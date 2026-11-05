# Highwire

The agent wire for [higher.fun](https://higher.fun). Highwire is an MCP server that lets AI agents use higher.fun, the open-source Solana launchpad.
Lower Fees, Higher Together.

Live at [highwire.fun](https://highwire.fun). Follow [@Highwiredotfun](https://x.com/Highwiredotfun) on X.

Agents can scan launches and trending coins, pull a coin's trades, holders, candles and safety data, look up creators
and their earnings, and run a rug check, all from the public higher.fun API and Solana RPC. No keys needed.

**Sign from any chat.** Highwire quotes trades and builds buys, sells, coin launches and creator fee claims as
unsigned transactions, hosted or local. Each comes with a `sign_url`: open it, and [highwire.fun/sign](https://highwire.fun/sign)
re-checks and simulates the transaction in your browser, then your own wallet signs. Highwire never signs, never holds
a key and never sends anything. See [docs/ROADMAP.md](docs/ROADMAP.md).

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

**Transactions (hosted and local):**

| Tool | What it does |
|---|---|
| `quote_trade` | Quote a buy (SOL in) or sell (tokens in) on the curve or, after graduation, the CPMM pool: output, minimum out, price impact, fees split by fee mode |
| `get_wallet_positions` | A wallet's SOL and its higher.fun coins (recognised on-chain), valued at the last price |
| `build_trade` | The trade as an unsigned transaction. Needs `confirm_trade: true`, `max_slippage_bps` (at most 1500) and `max_sol` |
| `build_launch` | Create a coin (Old or New school), pay the launch fee after checking its treasury, optional first buy and creator lock. Needs `confirm_launch: true` and an `idempotency_key` |
| `build_claim_creator_fees` | Claim curve creator fees and graduated pools' creator fees; reports the off-chain locked-LP payouts |

Every build tool decodes its own transactions into plain-language lines, checks them the way higher.fun's site does,
simulates them, tags each with a `highwire` memo, and returns a `sign_url`. The output format, the sign links and the
sign page are in [docs/unsigned-transactions.md](docs/unsigned-transactions.md).

**The sign page** ([highwire.fun/sign](https://highwire.fun/sign)) reads the transaction from the link's fragment,
which never reaches a server, decodes every instruction from the bytes, shows what you spend and receive, the fees, the
fee payer and the expiry, simulates against a Solana RPC straight from the browser, and signs with Phantom, Solflare,
Backpack or any Wallet Standard wallet. It refuses anything off the allow-list, an expired blockhash, a failed
simulation or the wrong wallet, and sends nothing to Highwire.

**Safety:**
- Highwire never asks for, accepts or stores a private key or seed phrase. The user signs in their own wallet.
- Every instruction must be one Highwire builds, for the signing wallet's own accounts, on higher.fun's platform
  configs and fee tier. The launch fee must go to the fee wallet recorded on-chain and be at most 0.05 SOL. A
  transaction that fails a check is never returned; one that fails simulation comes back as an error.
- Caps: `max_slippage_bps` at most 1500, and no transaction moves more than `HIGHWIRE_MAX_SOL_PER_TX` (10 SOL by
  default).
- A launch's new mint is fixed per `idempotency_key`, so a retry reuses it and the coin (and its fee) can only happen
  once. The local server keeps it in memory (a restart forgets it). The hosted endpoint keeps nothing: it derives the
  mint with HMAC-SHA256 from `HIGHWIRE_LAUNCH_SECRET`, the key and the launch (cluster, wallet, name, ticker, fee mode),
  so any serverless instance gives a retry the same mint, and once the coin exists a retry returns `already_launched`.
  Reusing a key for a different coin gets a different mint.
- higher.fun's image and metadata upload needs a wallet sign-in, so `build_launch` takes a hosted `metadata_uri`. Without
  one it returns the metadata JSON to host.

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

Nothing to install, no key. The hosted server has all 22 tools; the build tools only return unsigned transactions and a
sign link.

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

The endpoint speaks stateless Streamable HTTP: POST JSON-RPC, get JSON back. Each IP gets 60 units a minute: a build
tool call costs 5, anything else 1.

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
| `HIGHWIRE_CLUSTER` | `mainnet`; `devnet` quotes and builds on higher.fun's devnet deployment (the API, and so the research tools, stay on mainnet) |
| `SOLANA_RPC_URL` | the cluster's public RPC, `https://api.mainnet-beta.solana.com` on mainnet |
| `HIGHWIRE_MAX_SOL_PER_TX` | `10`: the most SOL one built transaction may spend or return |
| `HIGHER_TIMEOUT_MS` | `15000` |
| `HIGHER_RETRIES` | `2` |
| `HIGHWIRE_SITE_URL` | `https://highwire.fun`: where `sign_url` points; `http://localhost:3000` for a local site |
| `HIGHWIRE_LAUNCH_SECRET` | unset: launch mints are kept in memory. Set, they are derived from it (the hosted endpoint always derives) |
| `HIGHWIRE_RATE_LIMIT` | `60` units a minute per IP; a build costs 5 (hosted endpoint only) |

The site (apps/web) also reads `NEXT_PUBLIC_SOLANA_RPC_URL` and `NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL`, the RPCs the sign
page calls from the browser, and allows only their origins in its CSP. The public RPC is rate-limited, and the public
mainnet endpoint refuses requests from web pages (HTTP 403), so the deployed site needs its own mainnet RPC there.
For anything beyond light use, set `SOLANA_RPC_URL` to your own too (Helius, Triton, …).

## Repository

An npm workspaces monorepo.

| Path | What it is |
|---|---|
| [packages/core](packages/core) | `highwire-core`: the higher.fun API client, constants, unit formatting, the rug check, and the quote and transaction builders |
| [packages/mcp](packages/mcp) | `highwire-mcp`: the MCP server, the `highwire` stdio bin and a stateless HTTP handler |
| [apps/web](apps/web) | The Next.js site: the sign page at `/sign`, `/docs`, `/changelog`, `/terms`, `/privacy`, the hosted MCP at `/mcp` and `GET /api/health` |

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
| `npm run simulate` | Build and simulate buys, sells, launches and claims on mainnet and devnet as public wallets, check each `sign_url` decodes, and print one for a buy; nothing is signed or sent |
| `npm run smoke` | Call every tool over stdio, then start `next dev` and check the pages, `/sign`'s headers, `/api/health` and `/mcp` against the live API |
| `npm run typecheck` | Type-check every workspace |
| `npm run build` | Compile the packages to `dist/` and build the site |

To point the hosted check at a deployed site instead of `next dev`:

```bash
SMOKE_URL=https://highwire.fun npm run smoke -w highwire-web
```

### Deploying

The site runs on Vercel (project `highwire`, root directory `apps/web`, Node 22), and is deployed from the CLI. The
project has no Git connection, so pushing to GitHub doesn't deploy. Before deploying 0.3, set these in the project:
`NEXT_PUBLIC_SOLANA_RPC_URL` (a mainnet RPC that accepts browser requests from highwire.fun; it is public, so use a key
restricted to that origin), `SOLANA_RPC_URL` (the server-side RPC the build tools use), and `HIGHWIRE_LAUNCH_SECRET` (a
long random string; changing it changes the mint of any launch still being retried). From the repo root:

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
