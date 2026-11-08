# @dannyphan190/anti-rea-mcp

A thin [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that wraps the antiRea library ([`@dannyphan190/anti-rea`](https://www.npmjs.com/package/@dannyphan190/anti-rea)) and exposes seven of its advisory signals - the coordinated-cohort family: herd phase, herd tightness, seat occupancy, activity phase, vote brigading, room hopping and reconnect storms - as **stateful sessions over stdio**. The library itself is broader than this wrapper: its core is per-identity dataset metering against bulk extraction and cloning, which stays in-process by design; only the signal family is exposed here, because signals are what an agent can exercise through tool calls.

It exists so an AI agent (or a developer driving one) can open a signal, feed it a synthetic or replayed event stream, and read the signal's verdict - for trying antiRea out, running the integration checklist shapes from the library's `AGENT-GUIDE.md`, and demoing what each signal does, without writing any host code first.

## Honest caveat - read this first

**This wrapper is a registry-presence, evaluation and demo channel. It is not a production enforcement path.**

antiRea's signals are designed to live **inside the host application's process**, fed by its real event streams (room joins, seat lifecycles, socket connect/disconnect hooks). Every signal output is advisory - each result carries `enforcement: "none"` - because antiRea measures and reports; the host application decides what to do. A signal session held in this MCP server's memory sees only what a tool caller feeds it, dies when the server process exits, and is separated from your serving path by an agent round-trip. Production integrations should import `@dannyphan190/anti-rea` in-process and follow its `AGENT-GUIDE.md`. The strongest legitimate reaction to any signal remains a step-up challenge for **new** actions, wired host-side through `createVerificationGrace` - never a ban, kick or block driven by this wrapper's output.

## Tools

| Tool | What it does |
|---|---|
| `list_signals` | Returns the 7 signal kinds, the library factory behind each, and the exact event shape `observe` expects per kind. |
| `create_signal` | Opens a session around one library signal instance. `{ kind, sessionId?, options? }` - `options` are forwarded verbatim to the factory; **seat-occupancy requires `options: { capacity }`**. Returns the `sessionId`. |
| `observe` | Feeds one event into a session. Fill only the fields the kind uses (see the table below). Returns the library's observation object. |
| `observe_reference` | Feeds `{ identity, ts }` to a **herd-tightness** session's `observeReference()` - the established legitimate population the cohort is standardised against. Other kinds return an error: they have no such method in the library. |
| `evaluate` | Runs the instance's `evaluate()` and returns its JSON verbatim. `{ sessionId, args? }` - `args` are forwarded as the evaluate options. |
| `close_signal` | Drops the session and its in-memory instance. Nothing is persisted. |

### The seven kinds and their event shapes

| kind | factory | `observe` event | Notes |
|---|---|---|---|
| `herd-phase` | `createHerdPhaseSignal` | `{ identity, ts }` | Shared-scheduler fleet on a 900 s grid. Evaluate with `args: { cohortWindowMs: 86400000 }` for room joins. |
| `seat-occupancy` | `createSeatOccupancySignal` | `{ type: "join" \| "leave" \| "activity", identity, ts, accountCreatedTs? }` | Requires `capacity` at create. Population-only room state; names nobody. |
| `activity-phase` | `createActivityPhaseSignal` | `{ identity, ts }` | Herd-phase law over one activity stream. Scoped evaluation is mandatory - pass `cohortWindowMs`. |
| `vote-brigading` | `createVoteBrigadingSignal` | `{ identity, ts, accountCreatedTs? }` | Vote-skip scope only (the measured scope). Flags need >= 2 contributing windows. |
| `room-hop` | `createRoomHopSignal` | `{ identity, room, ts }` | >= 16 distinct rooms / trailing hour. Self-disarms above a 25% flagged share - never act on names while `disarmed`. |
| `reconnect-storm` | `createReconnectStormSignal` | `{ source, kind: "connect" \| "disconnect", ts }` | `source` is a session/account key, **never an IP**. >= 40 connects / 10 min with median session < 5 s. |
| `herd-tightness` | `createHerdTightnessSignal` | `{ identity, ts }` (+ `observe_reference`) | Whole-cohort tightness vs the fed reference; without one it returns `status: "uncalibrated"` and classifies nothing. Names nobody. |

`ts` is always a millisecond timestamp. Feed **one homogeneous stream per session** (joins OR chats OR retries - never mixed), and keep the lab-frozen default options unless you have your own measurements: thresholds in these modules were fixed before the lab ran.

## Install and run

Requires Node.js >= 20.

Run it directly:

```bash
npx -y @dannyphan190/anti-rea-mcp
```

Or install globally:

```bash
npm install -g @dannyphan190/anti-rea-mcp
anti-rea-mcp
```

The server speaks MCP over stdio; stdout is the protocol channel and startup logs go to stderr.

### Client configuration

Generic MCP client config (Claude Code, Cursor, and other stdio clients use this shape):

```json
{
  "mcpServers": {
    "anti-rea": {
      "command": "npx",
      "args": ["-y", "@dannyphan190/anti-rea-mcp"]
    }
  }
}
```

### A first session

1. `list_signals` - pick a kind.
2. `create_signal` `{ "kind": "herd-phase" }` - keep the returned `sessionId`.
3. `observe` `{ "sessionId": "...", "identity": "acct-1", "ts": 1730000000000 }` - repeat per event.
4. `evaluate` `{ "sessionId": "...", "args": { "cohortWindowMs": 86400000 } }` - read the advisory result.
5. `close_signal` `{ "sessionId": "..." }` when done.

## Development

```bash
npm install
npm run build   # tsc -> dist/index.js
npm run smoke   # scripted JSON-RPC smoke test over stdio (scripts/smoke.mjs)
npm start       # node dist/index.js
```

The smoke test mirrors the library's own verification checklist: a synthetic shared-grid herd (12 identities x 12 events, 900 s grid, ~+/-30 s jitter) confirms in `herd-phase` and names exactly its members; a herd-tightness cohort fed against a spread reference scores `tight`; 16 fresh silent joins flag a 30-seat room in `seat-occupancy` after the 600 s sustain; missing `capacity` and use-after-close return clean tool errors.

## Scope notes

- Sessions are in-memory only and unbounded in count; this is a deliberate thin-wrapper trade-off for evaluation use, not a serving component.
- There is no `createRoomGuard` - the library deliberately does not ship one (see the library's `AGENT-GUIDE.md`); this wrapper invents nothing on top of the published `dist/index.d.ts` surface.
- All lab numbers quoted by the library (and echoed in its result `notice` fields) are seeded-simulation numbers, not real-traffic performance.

## License

MIT. The wrapped library `@dannyphan190/anti-rea` is also MIT.
