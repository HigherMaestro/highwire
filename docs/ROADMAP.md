# Roadmap

## Phase 0: monorepo and hosted endpoint (done)

- npm workspaces: `highwire-core` (API client, constants, formatting, rug check), `highwire-mcp` (server, tools,
  prompts, the `highwire` stdio bin, a stateless HTTP handler) and `apps/web` (Next.js).
- The hosted read-only MCP at `https://highwire.fun/mcp`: stateless Streamable HTTP (fresh server per request, JSON
  responses), CORS, a per-IP rate limit, and `GET /api/health`.
- A placeholder home page with the install snippets. The brand and the real site design come next.
- Deployed to Vercel on `highwire.fun`, from the CLI (see the README's Deploying section).
- Left to the maintainer: publish `highwire-core` and `highwire-mcp` to npm.

## v0.1: read-only (done)

17 tools over the public API and Solana RPC, 4 prompts, 2 resources, an operator skill. No keys and no signing.

## v0.2: transactions, unsigned (built)

Built on Raydium's SDK (`@raydium-io/raydium-sdk-v2` 0.2.74-alpha, LaunchLab and CPMM modules) the way higher.fun's
own site uses it (docs/higher-reference.md). The build tools return **unsigned** v0 transactions for the user's own
wallet to sign, in the format in [unsigned-transactions.md](unsigned-transactions.md). Verified by simulation only
(`npm run simulate`), on mainnet and devnet.

| Tool | What it does |
|---|---|
| `quote_trade` | Buy (SOL in) or sell (tokens in) quote on the curve or the CPMM pool: output, min out, fees by mode, price impact |
| `get_wallet_positions` | Balances in higher.fun coins, recognised on-chain and valued from the API |
| `build_trade` | The trade as an unsigned transaction. Needs `confirm_trade: true`, `max_slippage_bps` ≤ 1500 and `max_sol` |
| `build_launch` | Create the coin on the chosen fee mode, pay the launch fee after the treasury and cap checks, optional first buy and creator lock. Needs `confirm_launch: true` and an idempotency key |
| `build_claim_creator_fees` | Curve creator fees and graduated pools' creator fees; reports higher.fun's off-chain locked-LP payouts |

What's in place:
- `z.literal(true)` confirm flags, a per-transaction SOL cap (`HIGHWIRE_MAX_SOL_PER_TX`), a slippage cap, and
  idempotency keys that pin a launch's mint so a retry can't create (or pay for) the coin twice.
- The checks higher.fun's site runs: the launch-fee treasury against the on-chain fee wallet, the fee cap, a program
  allow-list, and each decoded instruction against the intended trade or launch.
- `HIGHWIRE_CLUSTER=mainnet|devnet`.
- Offline tests replaying recorded mainnet responses (`npm run record-fixtures -w highwire-core` re-records them).

Not done, and why:
- **Image and metadata upload, and `…high` vanity mints.** higher.fun uploads only for a wallet signed in with a
  Sign-In With Solana message, which Highwire can't sign. `build_launch` takes a hosted `metadata_uri`, or returns the
  metadata JSON to host. A future option: return the sign-in message for the user to sign, then upload with the
  session.
- **Locked-LP fees.** The Fee Key NFT belongs to higher.fun, which pays creators off-chain; nothing to claim.
- **The hosted endpoint** has none of these tools, quotes included. `quote_trade` and `get_wallet_positions` are
  read-only and could go on it once the site's tool catalog and hosted smoke test expect them.
- **The signing page** on highwire.fun, which will consume the envelope.

## v0.3: optional local signer

An opt-in mode that signs with a local keypair (`HIGHER_KEYPAIR_PATH`), with:
- a per-trade and a per-day SOL limit
- a mint allowlist or denylist
- a dry-run default

Off unless the user configures it. Never accept a key through a tool argument.

## Later

- **OAuth on the hosted endpoint**, before it serves anything beyond public reads. Until then, transaction tools stay
  off the hosted server.
- **Live feed:** subscribe to `wss://api.higher.fun/ws` for launches, trades and graduations.
- **Sign-in tools:** posting comments and chat through `/auth/nonce` and `/auth/verify`, if higher.fun wants agents posting.
- **Publishing:** to the MCP registry, once `highwire-mcp` is on npm.
- **Partnering:** ask the higher.fun team for a stable API contract and an agent rate-limit tier.
