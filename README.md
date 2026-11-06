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

**Or let your agent act, inside your rules.** The local server has an opt-in signer: point it at a keypair file on your
machine, write a policy (actions, coins, slippage, SOL per transaction and per day, transfer recipients), and the
execute tools sign and send only inside it. Dry run until the policy says `"live": true`. See
[Local signer](#local-signer).

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
| `watch_market` | Live alerts: waits up to 50 seconds on higher.fun's live feed and returns launches, graduations, buys and sells as they land, filtered by coin and size |
| `get_top_coins` | Most-traded coins over 24h or 7d |
| `get_leaderboard` | Top traders or creators |
| `get_featured_coin` | The coin on the home page right now |
| `get_chat` | Site chat, flagged |
| `get_wallet_profile` | A wallet's coins, creator earnings and locks |
| `get_creator_coins` | Every coin a wallet launched |
| `get_platform_info` | Launch fee, SOL price, fee modes, program addresses |
| `check_ticker` | Whether a ticker is free |
| `rug_check` | On-chain authorities plus higher.fun's safety data, rolled into a verdict |
| `get_ecosystem_fees` | Every fee higher.fun's coins have paid and who got it, by phase and fee mode, what's waiting to be claimed, and the top coins: the numbers behind highwire.fun/fees |
| `get_coin_fees` | One coin's fees, line by line: who got each, measured on-chain or computed from volume, and what's waiting |

**Transactions (hosted and local):**

| Tool | What it does |
|---|---|
| `quote_trade` | Quote a buy (SOL in) or sell (tokens in) on the curve or, after graduation, the CPMM pool: output, minimum out, price impact, fees split by fee mode |
| `get_wallet_positions` | A wallet's SOL and its higher.fun coins (recognised on-chain), valued at the last price |
| `get_wallet_pnl` | Profit and loss on a wallet's coins from its own transactions on-chain: average cost, realized and unrealized, through any app. Needs an RPC that can search history |
| `build_trade` | The trade as an unsigned transaction. Needs `confirm_trade: true`, `max_slippage_bps` (at most 1500) and `max_sol` |
| `build_launch` | Create a coin (Old or New school), pay the launch fee after checking its treasury, optional first buy and creator lock. Needs `confirm_launch: true` and an `idempotency_key` |
| `build_claim_creator_fees` | Claim curve creator fees and graduated pools' creator fees; reports the off-chain locked-LP payouts |

Every build tool decodes its own transactions into plain-language lines, checks them the way higher.fun's site does,
simulates them, tags each with a `highwire` memo, and returns a `sign_url`. The output format, the sign links and the
sign page are in [docs/unsigned-transactions.md](docs/unsigned-transactions.md).

**Local only:**

| Tool | What it does |
|---|---|
| `build_transfer` | SOL or a higher.fun coin to another wallet, unsigned. No `sign_url`: the sign page never signs transfers |
| `get_signer_status` | With the local signer: its wallet, live or dry run, the policy, and what's left of today's limit |
| `execute_trade`, `execute_launch`, `execute_claim`, `execute_transfer` | With the local signer: build exactly what the build tool builds, check the policy, simulate again, then sign and send (or dry-run) |
| `place_order`, `list_orders`, `cancel_order` | With the local signer: standing orders (stop-loss, take-profit, recurring buys) that `highwire orders run` fills inside the policy |

**The sign page** ([highwire.fun/sign](https://highwire.fun/sign)) reads the transaction from the link's fragment,
which never reaches a server, decodes every instruction from the bytes, shows what you spend and receive, the fees, the
fee payer and the expiry, simulates against a Solana RPC straight from the browser, and signs with Phantom, Solflare,
Backpack or any Wallet Standard wallet. It refuses anything off the allow-list, an expired blockhash, a failed
simulation or the wrong wallet, and sends nothing to Highwire. Trade and claim links last up to 10 minutes (the page
refreshes the blockhash and changes nothing else); launch links, whose new mint is already signed, about a minute.

**Safety:**
- Highwire never asks for, accepts or stores a private key or seed phrase. The user signs in their own wallet.
- Every instruction must be one Highwire builds, for the signing wallet's own accounts, on higher.fun's platform
  configs and fee tier. The launch fee must go to the fee wallet recorded on-chain and be at most 0.05 SOL. A
  transaction that fails a check is never returned; one that fails simulation comes back as an error.
- Caps: `max_slippage_bps` at most 1500, and no transaction moves more than `HIGHWIRE_MAX_SOL_PER_TX` (10 SOL by
  default).
- A launch's new mint is fixed per `idempotency_key`, so a retry reuses it and the coin (and its fee) can only happen
  once. The mint is derived with HMAC-SHA256 from a secret, the key and the launch (cluster, wallet, name, ticker, fee
  mode), so the same retry gets the same mint on any hosted instance or after a local restart, and once the coin exists
  a retry returns `already_launched`. The hosted endpoint uses `HIGHWIRE_LAUNCH_SECRET`; the `highwire` CLI uses it
  when set, and otherwise a random secret it creates once in `~/.highwire/launch-secret`. Reusing a key for a different
  coin gets a different mint.
- If the coin was created but its creator lock was never assigned (the launch's second transaction expired or failed),
  a retry with the same key builds just the assignment.
- higher.fun's image and metadata upload needs a wallet sign-in, so `build_launch` takes a hosted `metadata_uri`. Without
  one it returns the metadata JSON to host. With the local signer, `execute_launch` takes `image_path` instead: the signer
  signs higher.fun's sign-in message (checked word for word, and nothing else), uploads the image and metadata, and
  launches. Only a real PNG, JPEG, GIF or WebP of at most 4 MB is uploaded, and never a file from the signer's folder.
- `execute_launch` also takes `launch_for` (New school): an X or GitHub handle. higher.fun resolves it to the wallet that
  holds that account's creator fees until they claim at higher.fun/claim; the coin is created for that wallet, which
  gets 0.005 SOL from you if it holds less, and your first buy is still yours. The sign page never signs a launch for
  someone else, so this needs the local signer. higher.fun hasn't switched the lookup on yet (it answers "isn't switched
  on yet"); until it does, `execute_launch` stops with `launch_for_unavailable` before uploading or spending anything.

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

Nothing to install, no key. The hosted server has all 26 tools; the build tools only return unsigned transactions and a
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
tool or `watch_market` call costs 5, a few heavy reads 2 to 10, anything else 1.

### Local (stdio)

Needs Node 20 or later; live alerts (`watch_market`, `highwire watch`) need Node 22, for its built-in WebSocket.

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
| `HIGHWIRE_LAUNCH_SECRET` | the secret launch mints are derived from. Unset, the CLI creates one in `~/.highwire/launch-secret` |
| `HIGHWIRE_RATE_LIMIT` | `60` units a minute per IP; a build costs 5 (hosted endpoint only) |

The site (apps/web) also reads `NEXT_PUBLIC_SOLANA_RPC_URL` and `NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL`, the RPCs the sign
page calls from the browser, and allows only their origins in its CSP. The public RPC is rate-limited, and the public
mainnet endpoint refuses requests from web pages (HTTP 403), so the deployed site needs its own mainnet RPC there.
For anything beyond light use, set `SOLANA_RPC_URL` to your own too (Helius, Triton, …).

### Live alerts in the terminal

```bash
npx -y highwire-mcp watch --min-sol 1
```

prints higher.fun's live feed, one line an event, until Ctrl-C. `--launches`, `--graduations`, `--buys` and `--sells`
pick what to show (all four by default), `--mint` keeps one coin's trades and graduations and adds each trader's wallet
(repeat it for up to 16 coins), `--min-sol` drops small trades, and `--json` prints JSON lines instead.

### Local signer

Off unless you turn it on, and never on the hosted endpoint. It signs only inside a policy you write in
`~/.highwire/policy.json`, which no tool can change.

```bash
npx -y highwire-mcp policy init
```

writes a starting policy: devnet, dry run, trades and claims, 0.1 SOL a transaction, 0.5 SOL a day. Then set
`HIGHWIRE_KEYPAIR_PATH` in the local server's `env` to a Solana CLI keypair file. Use a wallet that holds only what
you'd let an agent spend.

| Policy key | What it limits |
|---|---|
| `cluster` | `mainnet` or `devnet`, required |
| `live` | `false` by default: every execute is a dry run that signs nothing |
| `actions` | any of `trade`, `launch`, `claim`, `transfer` |
| `max_sol_per_tx`, `max_sol_per_day` | SOL spent on trades, launch fees and first buys, and SOL sent. Each transaction may also spend up to 0.03 SOL on rent and fees. Both limits count what the simulation shows actually leaving the wallet, rent and fees included, when that's more. The day is the last 24 hours, counted from the audit log |
| `max_slippage_bps` | for trades and first buys |
| `coins` | `allow` or `deny` lists of mints. Before going live, list the coins (or `creators`) you mean the agent to trade: without an allow-list it may buy any higher.fun coin within your limits, and the signer warns you so |
| `creators` | `allow`: only coins launched by these wallets |
| `transfer_allowlist` | the only recipients for `execute_transfer` |
| `orders` | `kinds`: the standing orders an agent may place (`stop_loss`, `take_profit`, `recurring_buy`), and `max_open` (default 10). Without it, none |

Every execute is written to `~/.highwire/audit.jsonl`: refusals, dry runs, and each signature as it's sent. Creating
`~/.highwire/STOP` refuses everything until you delete it. `HIGHWIRE_HOME` and `HIGHWIRE_POLICY_PATH` move the files.

**Standing orders.** With `"orders": {"kinds": ["stop_loss", "take_profit", "recurring_buy"]}` in the policy, an agent
can place orders with `place_order`, which wait in `~/.highwire/orders.json`:

- `stop_loss` sells a share of the wallet's coin once its price falls to a trigger (`trigger_price_sol`, or
  `trigger_change_pct` from now), and `take_profit` once it rises to one. `min_sol_out` makes either wait rather than
  sell for less.
- `recurring_buy` buys `sol` every `every_hours`, `times` times.

They fill only while this runs, with the same `HIGHWIRE_KEYPAIR_PATH` (one runner at a time):

```bash
HIGHWIRE_KEYPAIR_PATH=~/.config/solana/agent.json npx -y highwire-mcp orders run
```

Price orders are checked against the coin's on-chain price every minute, and within seconds of a trade on it (the live
feed only says when to look). Each fill passes the whole policy again, dry run included, is simulated and is written to
the audit log with its order's id. A fill the runner can't be sure about (it stopped mid-fill, or the send's answer
was lost) closes the order as failed rather than risk filling it twice. `highwire orders list` and
`highwire orders cancel <id>` work without the keypair.

## Repository

An npm workspaces monorepo.

| Path | What it is |
|---|---|
| [packages/core](packages/core) | `highwire-core`: the higher.fun API client, constants, unit formatting, the rug check, and the quote and transaction builders |
| [packages/agent](packages/agent) | `highwire-agent`: the opt-in local signer: the policy, the keypair loader, the audit log and the executor |
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

The site runs on Vercel (project `highwire`, root directory `apps/web`, Node 22), connected to this repository:
every push to `main` deploys production. The project needs `NEXT_PUBLIC_SOLANA_RPC_URL` (a mainnet RPC that accepts
browser requests from highwire.fun; it is public, so use a key restricted to that origin), `SOLANA_RPC_URL` (the
server-side RPC the build tools and `get_wallet_pnl` use; it must be able to search transaction history), and
`HIGHWIRE_LAUNCH_SECRET` (a long random string; changing it changes the mint of any launch still being retried).

To deploy without a push, run this from the repo root, never from a package folder (that makes a new Vercel project):

```bash
vercel deploy --prod --scope groovys-projects
```

`.vercelignore` keeps local-only files out of a CLI upload. `www.highwire.fun` redirects to `highwire.fun`. After a
deploy, run the hosted smoke check above.

To run a local build over stdio, `npm run build`, then use `node /path/to/highwire/packages/mcp/dist/cli.js` as the
command.

[AGENTS.md](AGENTS.md) has the conventions. [docs/higher-reference.md](docs/higher-reference.md) has everything known
about higher.fun's programs, fee modes and API, with sources.


## Support

Highwire is free. If you'd like to support it, its only donation wallet is
`7LnP9W1BcRhGRtUgSweGbGndaKaRmQxKVtCEHTeW7Rce` ([Solscan](https://solscan.io/account/7LnP9W1BcRhGRtUgSweGbGndaKaRmQxKVtCEHTeW7Rce)).
No other wallet collects for Highwire, there is no Highwire token, and we never ask for funds in DMs.

## Licence

[MIT](LICENSE).
