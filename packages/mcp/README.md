# highwire-mcp

The MCP server that lets AI agents use [higher.fun](https://higher.fun), the open-source Solana launchpad. 22 tools: 17
for launches, coins, trades, holders, creators and rug checks, and 5 that quote and build unsigned trades, launches and
creator fee claims, each with a link to sign in your own wallet on highwire.fun. Plus 4 prompts and 2 resources. No
keys needed, and it never signs.

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
