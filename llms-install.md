# Installing anti-rea-mcp

anti-rea-mcp is a stdio MCP server published on npm as `@dannyphan190/anti-rea-mcp`.
There is nothing to build or host: an MCP client starts it as a subprocess with `npx`.

## MCP client configuration

Add this entry to the client's MCP servers configuration (for Cline this is
`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "anti-rea": {
      "command": "npx",
      "args": ["-y", "@dannyphan190/anti-rea-mcp"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Requirements: Node.js 20 or newer on the machine running the client. No API key,
account, or environment variable is needed. The server speaks MCP over stdio and
keeps all state in memory for the life of the process.

## Verify the installation

After adding the configuration, the client should list these tools from the
`anti-rea` server: `list_signals`, `create_signal`, `observe`,
`observe_reference`, `evaluate`, `close_signal`.

A minimal check: call `list_signals` - it returns the 7 advisory signal kinds
the server can open sessions for. Then `create_signal` with
`{ "kind": "herd-phase" }` returns a `sessionId` ready for `observe` calls.

## What this server is

A thin evaluation and demo wrapper around the antiRea library
(`@dannyphan190/anti-rea`, repo https://github.com/dankezo/antiRea). Signals are
advisory only - every result carries `enforcement: "none"`. Production
integrations should import the library in-process instead of using this wrapper.
