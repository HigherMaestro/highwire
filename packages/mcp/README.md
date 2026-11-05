# highwire-mcp

The MCP server that lets AI agents use [higher.fun](https://higher.fun), the open-source Solana launchpad. 17 read-only
tools for launches, coins, trades, holders, creators and rug checks, plus 4 prompts and 2 resources. No keys needed.

```bash
claude mcp add highwire -- npx -y highwire-mcp
```

Or in any stdio client's config:

```json
{
  "mcpServers": {
    "highwire": { "command": "npx", "args": ["-y", "highwire-mcp"] }
  }
}
```

As a library, it exports `createServer()` and `createHttpHandler()`, a stateless Streamable HTTP handler with the
signature `(Request) => Promise<Response>`, for hosting the server yourself.

Tools, environment variables and the hosted endpoint are documented in the
[main README](https://github.com/HigherMaestro/highwire#readme). MIT.
