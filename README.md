# Highwire

The agent wire for [higher.fun](https://higher.fun). Highwire is an MCP server that lets AI agents use higher.fun, the open-source Solana launchpad.
Lower Fees, Higher Together.

Live at [highwire.fun](https://highwire.fun). Follow [@Highwiredotfun](https://x.com/Highwiredotfun) on X.

Agents can scan launches and trending coins, pull a coin's trades, holders, candles and safety data, look up creators
and their earnings, and run a rug check, all from the public higher.fun API and Solana RPC. No keys needed.

**v0.1 is read-only.** It can't sign, trade or launch. Use it hosted, or run it locally with `npx highwire-mcp`. Transactions are next: see [docs/ROADMAP.md](docs/ROADMAP.md).

## Tools

| Tool | What it returns |
|---|---|
| `list_coins` | Coins sorted by `trending`, `new`, `mcap` or `graduating` |
| `search_coins` | Coins matching a name, ticker or mint |
| `get_coin` | Price, market cap, graduation progress, fee mode, holder concentration, safety grade |
| `get_coin_trades` | Recent buys and sells |
| `get_coin_holders` | Top holders, with the curve, pool and lock labelled |
| `get_coin_candles` | OHLC candles in SOL |
| `get_coin_comments` | The coin's comments, flagged for links and impersonators |
| `get_trade_tape` | Site-wide live feed of trades, launches and graduations |
| `get_top_coins` | Most-traded coins over 24h or 7d |
| `get_leaderboard` | Top traders or creators |
| `get_featured_coin` | The coin on the home page right now |
| `get_chat` | Site chat, flagged |
| `get_wallet_profile` | A wallet's coins, creator earnings and locks |
| `get_creator_coins` | Every coin a wallet launched |
| `get_platform_info` | Launch fee, SOL price, fee modes, program addresses |
| `check_ticker` | Whether a ticker is free |
| `rug_check` | On-chain authorities plus higher.fun's safety data, rolled into a verdict |

**Prompts:**
- `scan_launches`
- `coin_due_diligence`
- `creator_report`
- `plan_launch`

**Resources:**
- `higher://platform`
- `higher://coins/{mint}`

**Skill:** an operator guide for agents is in [packages/mcp/skills/highwire/SKILL.md](packages/mcp/skills/highwire/SKILL.md).

## Connect

### Hosted

Nothing to install. The hosted server is read-only and needs no key.

**Claude Code**

```bash
claude mcp add --transport http highwire https://highwire.fun/mcp
```

**Cursor, or any client that takes a remote MCP URL**

```json
{
  "mcpServers": {
    "highwire": { "url": "https://highwire.fun/mcp" }
  }
}
```

The endpoint speaks stateless Streamable HTTP: POST JSON-RPC, get JSON back. It allows 60 requests a minute per IP.

### Local (stdio)

Needs Node 20 or later.

**Claude Code**

```bash
claude mcp add highwire -- npx -y highwire-mcp
```

**Claude Desktop, Cursor, or any stdio client**

```json
{
  "mcpServers": {
    "highwire": {
      "command": "npx",
      "args": ["-y", "highwire-mcp"],
      "env": { "SOLANA_RPC_URL": "https://api.mainnet-beta.solana.com" }
    }
  }
}
```

**Environment variables.** All are optional; see [.env.example](.env.example).

| Variable | Default |
|---|---|
| `HIGHER_API_URL` | `https://api.higher.fun` |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` |
| `HIGHER_TIMEOUT_MS` | `15000` |
| `HIGHER_RETRIES` | `2` |
| `HIGHWIRE_RATE_LIMIT` | `60` requests a minute per IP (hosted endpoint only) |

The public RPC is rate-limited. For anything beyond light use, set `SOLANA_RPC_URL` to your own (Helius, Triton, …).

## Repository

An npm workspaces monorepo.

| Path | What it is |
|---|---|
| [packages/core](packages/core) | `highwire-core`: the higher.fun API client, constants, unit formatting and the rug check |
| [packages/mcp](packages/mcp) | `highwire-mcp`: the MCP server, the `highwire` stdio bin and a stateless HTTP handler |
| [apps/web](apps/web) | The Next.js site, which also serves the hosted MCP at `/mcp` and `GET /api/health` |

## Development

```bash
git clone https://github.com/HigherMaestro/highwire.git
```

```bash
cd highwire && npm install
```

Every command runs from the root and covers all workspaces.

| Command | What it does |
|---|---|
| `npm run dev` | Run the MCP server from source over stdio |
| `npm run dev:web` | Run the site at http://localhost:3000, with the MCP at http://localhost:3000/mcp |
| `npm test` | Unit, in-memory MCP and HTTP handler tests, offline |
| `npm run smoke` | Call every tool over stdio, then start `next dev` and check `/`, `/api/health` and `/mcp` against the live API |
| `npm run typecheck` | Type-check every workspace |
| `npm run build` | Compile the packages to `dist/` and build the site |

To point the hosted check at a deployed site instead of `next dev`:

```bash
SMOKE_URL=https://highwire.fun npm run smoke -w highwire-web
```

### Deploying

The site runs on Vercel (project `highwire`, root directory `apps/web`, Node 22), and is deployed from the CLI. The
project has no Git connection, so pushing to GitHub doesn't deploy. From the repo root:

```bash
vercel deploy --prod --scope groovys-projects
```

`.vercelignore` keeps local-only files out of the upload. `www.highwire.fun` redirects to `highwire.fun`. After a
deploy, run the hosted smoke check above.

To run a local build over stdio, `npm run build`, then use `node /path/to/highwire/packages/mcp/dist/cli.js` as the
command.

[AGENTS.md](AGENTS.md) has the conventions. [docs/higher-reference.md](docs/higher-reference.md) has everything known
about higher.fun's programs, fee modes and API, with sources.

## Licence

[MIT](LICENSE).
