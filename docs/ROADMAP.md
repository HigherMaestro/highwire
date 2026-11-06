# Roadmap

## Phase 0: monorepo and hosted endpoint (done)

- npm workspaces: `highwire-core` (API client, constants, formatting, rug check), `highwire-mcp` (server, tools,
  prompts, the `highwire` stdio bin, a stateless HTTP handler) and `apps/web` (Next.js).
- The hosted MCP at `https://highwire.fun/mcp`: stateless Streamable HTTP (fresh server per request, JSON
  responses), CORS, a per-IP rate limit, and `GET /api/health`. Read-only until M1.
- A placeholder home page with the install snippets. The brand and the real site design come next.
- Deployed to Vercel on `highwire.fun`, from the CLI (see the README's Deploying section).
- Left to the maintainer: publish `highwire-core` and `highwire-mcp` to npm.

## v0.1: read-only (done)

17 tools over the public API and Solana RPC, 4 prompts, 2 resources, an operator skill. No keys and no signing.

## v0.2: transactions, unsigned (done)

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
- **The hosted endpoint** has none of these tools (done in M1).
- **The signing page** on highwire.fun (done in M1).

## M1 (v0.3.0): sign from any chat (built, unreleased)

Decisions D4 (attribution memo), D6 (hosted build tools) and D9 (terms, privacy, changelog).

- **Attribution memo.** Every built transaction ends with one SPL Memo v2 instruction, `highwire`. Memo is on the
  allow-list (that memo only, once, no accounts) and the summary says "Tags the transaction as built by Highwire".
- **Sign links.** Every build result has `sign_url`, `https://highwire.fun/sign#<payload>`: the envelope as compact
  JSON in base64url, gzipped (`gz.` prefix) only past 8,000 characters. `HIGHWIRE_SITE_URL` overrides the origin.
  Encoding, decoding and shape checks are in `highwire-core`, with round-trip tests.
- **The sign page**, `/sign`: decodes the fragment in the browser, re-checks every instruction from the bytes
  (`reviewEnvelope`), shows spend and receive, fees, fee payer, expiry and each transaction, simulates against the RPC
  from the browser, connects a Wallet Standard wallet, and refuses to sign on a failed check, an expired blockhash, a
  failed simulation or the wrong wallet. Strict headers via `next.config.ts`; its CSP only allows the RPC origins.
  No analytics (Vercel Analytics isn't a dependency).
- **Hosted build tools.** All 22 tools at `/mcp`. Weighted rate limit: builds cost 5 units, everything else 1, 60 a
  minute per IP. Hosted instructions tell agents to hand over the sign link and never ask for keys. Launch mints are
  derived from `HIGHWIRE_LAUNCH_SECRET` and the idempotency key, so a retry works on any instance.
- **Pages.** /terms and /privacy as drafts pending legal review, and /changelog from `CHANGELOG.md`.

Not verified, and left to the maintainer:
- ~~Signing with a real wallet.~~ Done 2026-11-06: a 0.01 SOL $HIGH buy built on the hosted endpoint, opened as a sign
  link (verified as built by highwire.fun), signed in the user's own wallet and confirmed with the `highwire` memo
  ([transaction](https://solscan.io/tx/559k7pVa8iTefMpUQ2skvSpbwDH7bvpsQR2z1bsmQ2NJJbtQqU96dxA4RJdkY6BuysXw8L7NHVdmx7bHCZXFzBof)).
  It received 518.77 HIGH against a 488.94 minimum. The first attempt showed that chat apps mangle long links; the
  page now cleans that up before decoding.
- Production RPCs: Solana's public mainnet RPC refuses browser requests, so `NEXT_PUBLIC_SOLANA_RPC_URL` must be set to
  an RPC that allows highwire.fun before the sign page works on mainnet. Set `SOLANA_RPC_URL` and
  `HIGHWIRE_LAUNCH_SECRET` too.
- Legal review of /terms and /privacy.

## M2 (v0.4.0): local signer and execution (built, unreleased)

Decision D1: local signer only. Highwire never creates, holds or manages a wallet; the hosted endpoint never signs.

- **`highwire-agent`**, a new package: the policy schema and `checkPolicy`, the keypair loader, the JSONL audit log and
  `LocalSigner`. Turned on by `HIGHWIRE_KEYPAIR_PATH` (a Solana CLI keypair file) on the stdio server only;
  `createServer` refuses a signer on the hosted endpoint.
- **The policy** (`~/.highwire/policy.json`, FR-K6): cluster, `live`, actions, SOL per transaction and per 24 hours,
  slippage, coin allow and deny lists, a creator allow list, and the transfer allowlist. Strict: unknown keys are
  refused. Read on every execute. Without one, nothing executes; `highwire policy init` writes a dry-run devnet start.
- **Dry run by default** (FR-K7): every execute checks and simulates but signs nothing until `"live": true`.
- **Audit log** (FR-K8): refusals, dry runs and each signature, logged as it's sent, before it confirms. The daily
  limit counts from it, and executes run one at a time so two can't both squeeze under it.
- **Kill switch:** `~/.highwire/STOP` refuses every execute.
- **Tools:** `get_signer_status`, `execute_trade`, `execute_launch`, `execute_claim`, `execute_transfer`, all
  local only; and `build_transfer` (FR-T7), local only, with no sign link. The sign page refuses transfers.
- **Before signing:** the envelope must be for the signer's wallet and cluster and have passed simulation; each
  transaction is simulated again right before it's signed, and a later one gets a fresh blockhash when only the wallet
  signs it.

Exit criterion met on 2026-11-05: the `highwire` CLI, with the maintainer's devnet keypair and a live devnet policy
(trade only, 0.05 SOL a trade, 0.2 a day), bought 0.01 SOL of a higher.fun devnet coin and sold half of it through
`execute_trade`. Both landed with the `highwire` memo
([buy](https://solscan.io/tx/3kyoHCwJZp3grPhvnhwVnZe46USa1oDrFBifjRijRA7A7tF6mJq1WBAEPkzkzrm7rGpyBSnxPRBjiZFjiHYYpxAZ?cluster=devnet),
[sell](https://solscan.io/tx/5obmLiLmG9jobtuy32cJyLTnCDCqnj4vtcwaUL8SG8e26pntTm1gn1BqnycutvbcsTHGe3hr291BsmB1Xn4qTNDg?cluster=devnet)),
and a 0.08 SOL buy was refused by the policy with nothing sent. `npm run rehearse` covers the rest of the rules
against mainnet and devnet, short of sending.

First live mainnet launch through the local signer, 2026-11-06: `execute_launch` signed in to higher.fun, uploaded the
image and metadata, and launched $LGTM ("Looks Good To Me", New school) with a 0.2 SOL first buy, inside a live policy
capped at 0.22 SOL a launch. Mint `ALBA7iVjFkQzxPQQCovkK7zQiaXUPmixt2dZxNstXiPp`, [creation
transaction](https://solscan.io/tx/hC8XZUUQeJTaAyvXCAsuzqM8A9PGG1TidJpfm8rEzAE4eCkZMrTShnXHMdN7Bo7SEXK4tbprW4MUqLerP8T4PBx),
with the `highwire` memo. The day's limit counted 0.245 SOL, what the wallet actually spent with rent and fees.

## Later

- **OAuth on the hosted endpoint**, before it does anything beyond public reads and unsigned builds (for example
  sign-in tools or a hosted signer, which it must never become without it).
- **Live alerts** (done in 0.5.0): `watch_market` waits on `wss://api.higher.fun/ws` for launches, graduations,
  buys and sells, filtered by coin and size, and `highwire watch` streams them to the terminal. Alerts pushed to a chat
  without being asked for wait on MCP clients showing server notifications.
- **Recurring buys and stop-loss** (done in 0.6.0): `place_order`, `list_orders` and `cancel_order` keep stop-loss,
  take-profit and recurring-buy orders in `~/.highwire/orders.json`, allowed by the policy's `orders` section, and
  `highwire orders run` fills them through the local signer, checking prices on-chain with the live feed as a hint.
- **Profit and loss** (done in 0.7.0): `get_wallet_pnl` works out average cost, realized and unrealized profit from
  the wallet's own transactions on-chain (the trades API has no per-wallet view and can't be paged past 50). Searching
  history needs an RPC that can; Solana's public RPC often times out.
- **Sign-in tools:** posting comments and chat through `/auth/nonce` and `/auth/verify`, if higher.fun wants agents posting.
- ~~**Publishing**~~ Done 2026-11-06: `highwire-core`, `highwire-agent` and `highwire-mcp` on npm, and the MCP registry
  listing `fun.highwire/highwire` 0.4.1 (npm package and hosted endpoint), proved by highwire.fun's domain key.
- **Partnering:** ask the higher.fun team for a stable API contract and an agent rate-limit tier.
