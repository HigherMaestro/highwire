# Highwire

The agent wire for [higher.fun](https://higher.fun). Highwire is an MCP server that lets AI agents use higher.fun, the open-source Solana launchpad.
Lower Fees, Higher Together.

Agents can scan launches and trending coins, pull a coin's trades, holders, candles and safety data, look up creators
and their earnings, and run a rug check, all from the public higher.fun API and Solana RPC. No keys needed.

**v0.1 is read-only.** It can't sign, trade or launch. Transactions are next: see [docs/ROADMAP.md](docs/ROADMAP.md).

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

**Skill:** an operator guide for agents is in [skills/highwire/SKILL.md](skills/highwire/SKILL.md).

## Setup

Needs Node 20 or later.

```bash
git clone https://github.com/HigherMaestro/highwire.git
```

```bash
cd highwire && npm install
```

```bash
npm run build
```

**Claude Code**

```bash
claude mcp add highwire -- node /path/to/highwire/dist/index.js
```

**Claude Desktop, Cursor, or any stdio client**

```json
{
  "mcpServers": {
    "highwire": {
      "command": "node",
      "args": ["/path/to/highwire/dist/index.js"],
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

The public RPC is rate-limited. For anything beyond light use, set `SOLANA_RPC_URL` to your own (Helius, Triton, …).

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Run from source over stdio |
| `npm test` | Unit and in-memory MCP tests, offline |
| `npm run smoke` | Start the server and call every tool against the live API |
| `npm run typecheck` | Type-check without building |
| `npm run build` | Compile to `dist/` |

[AGENTS.md](AGENTS.md) has the conventions. [docs/higher-reference.md](docs/higher-reference.md) has everything known
about higher.fun's programs, fee modes and API, with sources.

## Licence

[MIT](LICENSE).
