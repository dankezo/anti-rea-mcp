#!/usr/bin/env node
/**
 * Smoke test for anti-rea-mcp: speaks raw JSON-RPC over stdio to
 * dist/index.js (initialize -> tools/list -> tool calls) and checks the
 * AGENT-GUIDE verification shape: a synthetic shared-grid herd confirms
 * in herd-phase; seat-occupancy without capacity is a clean error;
 * evaluating a closed session is a clean error.
 *
 * Usage: npm run build && node scripts/smoke.mjs
 * Exit code 0 iff all hard assertions pass.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const server = spawn("node", [path.join(root, "dist", "index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let nextId = 1;
const pending = new Map();
const rl = createInterface({ input: server.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function send(obj) {
  server.stdin.write(JSON.stringify(obj) + "\n");
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30000);
  });
}
async function callTool(name, args) {
  const res = await request("tools/call", { name, arguments: args });
  if (res.error) throw new Error(`JSON-RPC error calling ${name}: ${JSON.stringify(res.error)}`);
  const text = res.result.content?.map((c) => c.text ?? "").join("") ?? "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { isError: res.result.isError === true, parsed };
}

const checks = [];
function check(label, pass, detail = "") {
  checks.push({ label, pass });
  console.log(`CHECK ${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
}

const GRID = 900_000; // 900 s scheduler grid (the lab-validated period)
const T0 = 1_730_000_000_000;

async function main() {
  // 1. initialize ------------------------------------------------------------
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "anti-rea-mcp-smoke", version: "0.0.0" },
  });
  console.log("initialize ->", JSON.stringify(init.result?.serverInfo));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  // 2. tools/list -------------------------------------------------------------
  const list = await request("tools/list", {});
  const toolNames = list.result.tools.map((t) => t.name).sort();
  console.log("tools/list ->", toolNames.join(", "));
  check(
    "tools/list exposes exactly the 6 session tools",
    JSON.stringify(toolNames) ===
      JSON.stringify(
        ["close_signal", "create_signal", "evaluate", "list_signals", "observe", "observe_reference"].sort(),
      ),
  );

  // 3. list_signals ------------------------------------------------------------
  const ls = await callTool("list_signals", {});
  console.log("list_signals kinds ->", ls.parsed.signals.map((s) => s.kind).join(", "));
  check("list_signals returns 7 kinds", ls.parsed.signals.length === 7);

  // 4. herd-phase: synthetic shared-grid herd (AGENT-GUIDE checklist shape) ---
  const created = await callTool("create_signal", { kind: "herd-phase", sessionId: "smoke-herd" });
  console.log("create_signal herd-phase ->", JSON.stringify(created.parsed));
  check("create_signal herd-phase ok", !created.isError && created.parsed.sessionId === "smoke-herd");

  let counted = 0;
  let total = 0;
  let firstObs;
  let lastObs;
  for (let i = 0; i < 12; i++) {
    const identity = `bot-${String(i + 1).padStart(2, "0")}`;
    const offMs = ((i * 37) % 61) - 30; // deterministic per-identity jitter, seconds -30..+30
    for (let k = 0; k < 12; k++) {
      const ts = T0 + 123_000 + offMs * 1000 + k * GRID;
      const r = await callTool("observe", { sessionId: "smoke-herd", identity, ts });
      total++;
      if (r.parsed && r.parsed.counted) counted++;
      if (!firstObs) firstObs = r.parsed;
      lastObs = r.parsed;
    }
  }
  console.log(`observe x${total} -> counted ${counted}; first:`, JSON.stringify(firstObs), "last:", JSON.stringify(lastObs));
  check("all 144 herd observations counted", counted === 144, `${counted}/144`);

  const herdEval = await callTool("evaluate", {
    sessionId: "smoke-herd",
    args: { cohortWindowMs: 86_400_000 },
  });
  console.log("evaluate herd-phase ->", JSON.stringify(herdEval.parsed));
  check(
    "synthetic shared-grid herd CONFIRMS (AGENT-GUIDE checklist)",
    herdEval.parsed.confirmed === true,
    `confirmed=${herdEval.parsed.confirmed}, members=${(herdEval.parsed.members ?? []).length}`,
  );

  // 5. herd-tightness: reference + cohort streams, observe_reference path ------
  await callTool("create_signal", { kind: "herd-tightness", sessionId: "smoke-tight" });
  for (let i = 0; i < 10; i++) {
    const phase = i * 90_000; // spread reference phases across the grid
    for (let k = 0; k < 8; k++) {
      await callTool("observe_reference", {
        sessionId: "smoke-tight",
        identity: `regular-${i}`,
        ts: T0 + phase + k * GRID,
      });
    }
  }
  for (let i = 0; i < 10; i++) {
    for (let k = 0; k < 8; k++) {
      await callTool("observe", {
        sessionId: "smoke-tight",
        identity: `fleet-${i}`,
        ts: T0 + 45_000 + ((i * 13) % 11) * 1000 + k * GRID, // one shared phase, small jitter
      });
    }
  }
  const tightEval = await callTool("evaluate", { sessionId: "smoke-tight" });
  console.log("evaluate herd-tightness ->", JSON.stringify(tightEval.parsed));
  check(
    "herd-tightness scores against the fed reference",
    tightEval.parsed.status === "scored",
    `status=${tightEval.parsed.status}, tight=${tightEval.parsed.tight}`,
  );

  // 6. seat-occupancy: capacity is required ------------------------------------
  const noCap = await callTool("create_signal", { kind: "seat-occupancy", sessionId: "smoke-seats-bad" });
  console.log("create_signal seat-occupancy (no capacity) ->", JSON.stringify(noCap.parsed));
  check("seat-occupancy without capacity is a clean tool error", noCap.isError === true);

  const seats = await callTool("create_signal", {
    kind: "seat-occupancy",
    sessionId: "smoke-seats",
    options: { capacity: 30 },
  });
  check("create_signal seat-occupancy with capacity ok", !seats.isError);
  for (let i = 0; i < 16; i++) {
    const ts = T0 + i * 5_000;
    await callTool("observe", {
      sessionId: "smoke-seats",
      type: "join",
      identity: `squat-${i}`,
      ts,
      accountCreatedTs: ts - 3_600_000, // accounts 1 h old at join: "new"
    });
  }
  const seatEval = await callTool("evaluate", {
    sessionId: "smoke-seats",
    args: { asOfTs: T0 + 720_000 }, // ratio crosses 0.50 at ~T0+70 s (15th seat); +600 s sustain -> flags ~T0+670 s
  });
  console.log("evaluate seat-occupancy ->", JSON.stringify(seatEval.parsed));
  check(
    "synthetic silent squat flags the room (AGENT-GUIDE checklist)",
    seatEval.parsed.flagged === true,
    `flagged=${seatEval.parsed.flagged}, currentRatio=${seatEval.parsed.currentRatio}`,
  );

  // 7. close + use-after-close --------------------------------------------------
  const closed = await callTool("close_signal", { sessionId: "smoke-herd" });
  console.log("close_signal ->", JSON.stringify(closed.parsed));
  check("close_signal ok", closed.parsed.closed === true);
  const after = await callTool("evaluate", { sessionId: "smoke-herd" });
  check("evaluate on a closed session is a clean tool error", after.isError === true);

  const failed = checks.filter((c) => !c.pass);
  console.log(`\nSMOKE SUMMARY: ${checks.length - failed.length}/${checks.length} hard checks passed`);
  server.kill();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("SMOKE ERROR:", err);
  server.kill();
  process.exit(2);
});
