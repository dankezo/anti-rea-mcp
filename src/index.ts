#!/usr/bin/env node
/**
 * anti-rea-mcp - a thin MCP (Model Context Protocol) server wrapping the
 * antiRea library (@dannyphan190/anti-rea).
 *
 * It exposes antiRea's seven advisory live-room / cohort signals as
 * stateful sessions over stdio:
 *
 *   list_signals     -> the 7 kinds and the event shape each one eats
 *   create_signal    -> open a session around one library signal instance
 *   observe          -> feed one event into a session's instance
 *   observe_reference-> feed the reference stream (herd-tightness only)
 *   evaluate         -> run the instance's frozen law, return its JSON
 *   close_signal     -> drop a session
 *
 * HONEST SCOPE: antiRea signals are designed to live inside the host
 * application's process, fed by its real event streams, and every output
 * is advisory (enforcement: "none"). This wrapper is an evaluation,
 * demo and agent-assisted integration-check channel - it is NOT a
 * production enforcement path. See README.md.
 *
 * Every library call below was checked against the published package's
 * dist/index.d.ts (2.7.4). Where a factory's surface differs from the
 * common shape it is noted inline:
 *   - createSeatOccupancySignal REQUIRES options ({ capacity }).
 *   - createHerdTightnessSignal instances add observeReference().
 *   - evaluate() options differ per kind ({ cohortWindowMs } for the
 *     phase signals, { asOfTs } for most others) - passed through as-is.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import antiRea from "@dannyphan190/anti-rea";

// ---------------------------------------------------------------------------
// Library surface (structural minimum - the real instance types differ per
// kind, but every one of the seven exposes observe/evaluate with these
// shapes per dist/index.d.ts).
// ---------------------------------------------------------------------------

interface SignalInstance {
  observe(event: Record<string, unknown>): unknown;
  evaluate(options?: Record<string, unknown>): unknown;
  observeReference?(event: Record<string, unknown>): unknown;
}

type SignalFactory = (options?: Record<string, unknown>) => SignalInstance;

const lib = antiRea as unknown as Record<string, unknown>;

function mustFactory(exportName: string): SignalFactory {
  const fn = lib[exportName];
  if (typeof fn !== "function") {
    throw new Error(
      `@dannyphan190/anti-rea does not export ${exportName} as a function - ` +
        `the wrapper is built against 2.7.4; refusing to start.`,
    );
  }
  return fn as SignalFactory;
}

// ---------------------------------------------------------------------------
// Signal catalogue
// ---------------------------------------------------------------------------

const SIGNAL_KINDS = [
  "herd-phase",
  "seat-occupancy",
  "activity-phase",
  "vote-brigading",
  "room-hop",
  "reconnect-storm",
  "herd-tightness",
] as const;

type SignalKind = (typeof SIGNAL_KINDS)[number];

interface SignalDef {
  kind: SignalKind;
  factoryName: string;
  create: SignalFactory;
  /** Human/agent-readable event contract for observe(). */
  event: string;
  /** Extra contract notes (required options, extra methods, scoping law). */
  notes: string;
}

const SIGNAL_DEFS: SignalDef[] = [
  {
    kind: "herd-phase",
    factoryName: "createHerdPhaseSignal",
    create: mustFactory("createHerdPhaseSignal"),
    event: "{ identity: string, ts: number } - one homogeneous stream (joins, session starts, retries).",
    notes:
      "Detects a fleet on one shared 900 s scheduler grid at one shared offset. " +
      "evaluate args: { cohortWindowMs?: number, asOfTs?: number } - scope room joins to 86400000 (24 h). " +
      "An identity needs >= 8 events before it is scored; members are named only when confirmed.",
  },
  {
    kind: "seat-occupancy",
    factoryName: "createSeatOccupancySignal",
    create: mustFactory("createSeatOccupancySignal"),
    event:
      "{ type: 'join' | 'leave' | 'activity', identity: string, ts: number, accountCreatedTs?: number }.",
    notes:
      "REQUIRES create options { capacity: number } (the room's real seat count). " +
      "Population-only room state: share of seats held by <24 h-old accounts with zero activity. Names nobody. " +
      "evaluate args: { asOfTs?: number }.",
  },
  {
    kind: "activity-phase",
    factoryName: "createActivityPhaseSignal",
    create: mustFactory("createActivityPhaseSignal"),
    event: "{ identity: string, ts: number } - ONE activity kind per session (chat sends, emotes, ...).",
    notes:
      "The herd-phase law over an activity stream. SCOPED evaluation is part of the law: " +
      "pass evaluate args { cohortWindowMs: 86400000 } for room streams; unscoped reads dilute and stay silent. " +
      "evaluate args: { cohortWindowMs?: number, asOfTs?: number }.",
  },
  {
    kind: "vote-brigading",
    factoryName: "createVoteBrigadingSignal",
    create: mustFactory("createVoteBrigadingSignal"),
    event: "{ identity: string, ts: number, accountCreatedTs?: number } - vote-skip events only (the measured scope).",
    notes:
      "Population-only room state; flags only when >= 2 distinct 60 s windows contribute. Names nobody. " +
      "evaluate args: { asOfTs?: number }.",
  },
  {
    kind: "room-hop",
    factoryName: "createRoomHopSignal",
    create: mustFactory("createRoomHopSignal"),
    event: "{ identity: string, room: string, ts: number } - room joins; key on identity, never on IP.",
    notes:
      "Flags identities joining >= 16 distinct rooms in a trailing hour. Self-disarms (names nobody, " +
      "disarmed: true) when > 25% of tracked identities would flag - never act on names while disarmed. " +
      "evaluate args: { asOfTs?: number }.",
  },
  {
    kind: "reconnect-storm",
    factoryName: "createReconnectStormSignal",
    create: mustFactory("createReconnectStormSignal"),
    event:
      "{ source: string, kind: 'connect' | 'disconnect', ts: number } - source is a session/account key, NEVER an IP.",
    notes:
      "Flags sources with >= 40 connects in 10 min whose sessions median under 5 s. Same 25% self-disarm " +
      "as room-hop; alert on disarmed: true with flaggedCount > 0. evaluate args: { asOfTs?: number }.",
  },
  {
    kind: "herd-tightness",
    factoryName: "createHerdTightnessSignal",
    create: mustFactory("createHerdTightnessSignal"),
    event: "{ identity: string, ts: number } - one homogeneous stream (session starts or joins).",
    notes:
      "Whole-cohort tightness of the phase-plane cloud, standardised against a reference population " +
      "fed through observe_reference (established legitimate users). Without a scored reference it " +
      "returns status 'uncalibrated' and classifies nothing. Names no identity. " +
      "evaluate args: { asOfTs?: number }.",
  },
];

const DEF_BY_KIND = new Map<SignalKind, SignalDef>(SIGNAL_DEFS.map((d) => [d.kind, d]));

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

interface Session {
  kind: SignalKind;
  instance: SignalInstance;
  createdAt: number;
}

const sessions = new Map<string, Session>();

function getSession(sessionId: string): Session {
  const s = sessions.get(sessionId);
  if (!s) {
    throw new Error(
      `unknown sessionId "${sessionId}" - open one with create_signal first (sessions are in-memory and die with the server process).`,
    );
  }
  return s;
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function textResult(value: unknown, isError = false) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  return { content: [{ type: "text" as const, text }], isError };
}

function ok(value: unknown) {
  return textResult(value, false);
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return textResult({ error: message }, true);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: "anti-rea-mcp", version: "2.7.4" },
  {
    instructions:
      "antiRea advisory signals as stateful sessions. Flow: list_signals -> create_signal -> " +
      "observe (and observe_reference for herd-tightness) -> evaluate -> close_signal. " +
      "Every result is advisory (enforcement: \"none\"): signals measure and report, host code decides. " +
      "Never hard-block anyone on this output.",
  },
);

server.registerTool(
  "list_signals",
  {
    title: "List antiRea signal kinds",
    description:
      "Returns the 7 signal kinds this server can open sessions for, the library factory behind each, " +
      "and the exact event shape observe() expects per kind. No session needed.",
  },
  async () =>
    ok({
      signals: SIGNAL_DEFS.map((d) => ({
        kind: d.kind,
        factory: d.factoryName,
        observeEvent: d.event,
        notes: d.notes,
      })),
      enforcement: "none",
      note: "All antiRea signals are advisory. This wrapper is for evaluation/demos, not production enforcement.",
    }),
);

server.registerTool(
  "create_signal",
  {
    title: "Create a signal session",
    description:
      "Creates one antiRea signal instance (from @dannyphan190/anti-rea) and holds it in an in-memory " +
      "session. kind is one of the 7 from list_signals. options are forwarded verbatim to the library " +
      "factory - seat-occupancy REQUIRES options { capacity: number }; for all other kinds options may " +
      "be omitted (lab-frozen defaults - do not retune silently). Returns the sessionId to feed with observe.",
    inputSchema: {
      kind: z.enum(SIGNAL_KINDS),
      sessionId: z
        .string()
        .min(1)
        .optional()
        .describe("Caller-chosen session id. Omit to have the server generate one."),
      options: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Factory options, forwarded verbatim (seat-occupancy: { capacity } is required)."),
    },
  },
  async ({ kind, sessionId, options }) => {
    try {
      const def = DEF_BY_KIND.get(kind)!;
      if (kind === "seat-occupancy") {
        const capacity = (options as Record<string, unknown> | undefined)?.capacity;
        if (typeof capacity !== "number" || !Number.isFinite(capacity) || capacity <= 0) {
          return fail(
            new Error(
              "seat-occupancy requires create options { capacity: <room seat count> } - " +
                "createSeatOccupancySignal's capacity option is required in the library.",
            ),
          );
        }
      }
      const id = sessionId ?? `${kind}-${crypto.randomUUID()}`;
      if (sessions.has(id)) {
        return fail(new Error(`sessionId "${id}" already exists - close it first or pick another id.`));
      }
      const instance = def.create(options);
      sessions.set(id, { kind, instance, createdAt: Date.now() });
      return ok({ sessionId: id, kind, factory: def.factoryName, enforcement: "none" });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "observe",
  {
    title: "Feed one event into a signal session",
    description:
      "Forwards one event to the session instance's observe(). Fill only the fields the session's kind " +
      "uses (see list_signals): herd-phase / activity-phase / vote-brigading / herd-tightness use " +
      "{ identity, ts } (vote-brigading also takes accountCreatedTs); seat-occupancy uses " +
      "{ type, identity, ts, accountCreatedTs? }; room-hop uses { identity, room, ts }; " +
      "reconnect-storm uses { source, kind, ts }. ts is a millisecond timestamp. Returns the library's " +
      "observation object (e.g. { status, counted }). Feed ONE homogeneous stream per session.",
    inputSchema: {
      sessionId: z.string().min(1),
      ts: z.number().optional().describe("Millisecond timestamp of the event."),
      identity: z.string().optional().describe("Authenticated identity (all kinds except reconnect-storm)."),
      type: z
        .enum(["join", "leave", "activity"])
        .optional()
        .describe("seat-occupancy only: the seat-lifecycle event type."),
      room: z.string().optional().describe("room-hop only: the room joined."),
      source: z
        .string()
        .optional()
        .describe("reconnect-storm only: session/account key - never an IP address."),
      kind: z
        .enum(["connect", "disconnect"])
        .optional()
        .describe("reconnect-storm only: socket event kind."),
      accountCreatedTs: z
        .number()
        .optional()
        .describe("seat-occupancy / vote-brigading: account creation time in ms, when known."),
    },
  },
  async ({ sessionId, ...fields }) => {
    try {
      const session = getSession(sessionId);
      const event: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) event[k] = v;
      }
      const observation = session.instance.observe(event);
      return ok(observation ?? { recorded: true });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "observe_reference",
  {
    title: "Feed the reference stream (herd-tightness only)",
    description:
      "Forwards { identity, ts } to a herd-tightness session's observeReference() - the established, " +
      "known-legitimate population the cohort is standardised against. Only herd-tightness instances " +
      "have this method in the library; other kinds return an error.",
    inputSchema: {
      sessionId: z.string().min(1),
      identity: z.string().min(1),
      ts: z.number(),
    },
  },
  async ({ sessionId, identity, ts }) => {
    try {
      const session = getSession(sessionId);
      if (typeof session.instance.observeReference !== "function") {
        return fail(
          new Error(
            `kind "${session.kind}" has no observeReference in the library - only herd-tightness does.`,
          ),
        );
      }
      const observation = session.instance.observeReference({ identity, ts });
      return ok(observation ?? { recorded: true });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "evaluate",
  {
    title: "Evaluate a signal session",
    description:
      "Runs the session instance's evaluate() and returns its JSON result verbatim. args are forwarded " +
      "as the evaluate options object: { cohortWindowMs } for herd-phase / activity-phase (scoping is " +
      "part of the law for room streams - use 86400000), { asOfTs } for the other kinds. Omit args to " +
      "evaluate with defaults. Every result is advisory (enforcement: \"none\").",
    inputSchema: {
      sessionId: z.string().min(1),
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Evaluate options forwarded verbatim, e.g. { cohortWindowMs: 86400000 } or { asOfTs: 1730000000000 }."),
    },
  },
  async ({ sessionId, args }) => {
    try {
      const session = getSession(sessionId);
      const result = session.instance.evaluate(args);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "close_signal",
  {
    title: "Close a signal session",
    description: "Drops the session and its in-memory signal instance. State is not persisted anywhere.",
    inputSchema: {
      sessionId: z.string().min(1),
    },
  },
  async ({ sessionId }) => {
    try {
      const session = getSession(sessionId);
      sessions.delete(sessionId);
      return ok({ closed: true, sessionId, kind: session.kind });
    } catch (err) {
      return fail(err);
    }
  },
);

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout carries the JSON-RPC protocol; logs go to stderr only.
  console.error("anti-rea-mcp 2.7.4 listening on stdio (7 signal kinds, in-memory sessions)");
}

main().catch((err) => {
  console.error("anti-rea-mcp fatal:", err);
  process.exit(1);
});
