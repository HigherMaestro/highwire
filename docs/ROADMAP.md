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
- Signing with a real wallet (Phantom, Solflare, Backpack): the page was tested up to the wallet prompt, with no wallet
  installed.
- Production RPCs: Solana's public mainnet RPC refuses browser requests, so `NEXT_PUBLIC_SOLANA_RPC_URL` must be set to
  an RPC that allows highwire.fun before the sign page works on mainnet. Set `SOLANA_RPC_URL` and
  `HIGHWIRE_LAUNCH_SECRET` too.
- Legal review of /terms and /privacy.

## Next: optional local signer

An opt-in mode that signs with a local keypair (`HIGHER_KEYPAIR_PATH`), with:
- a per-trade and a per-day SOL limit
- a mint allowlist or denylist
- a dry-run default

Off unless the user configures it. Never accept a key through a tool argument.

## Later

- **OAuth on the hosted endpoint**, before it does anything beyond public reads and unsigned builds (for example
  sign-in tools or a hosted signer, which it must never become without it).
- **Live feed:** subscribe to `wss://api.higher.fun/ws` for launches, trades and graduations.
- **Sign-in tools:** posting comments and chat through `/auth/nonce` and `/auth/verify`, if higher.fun wants agents posting.
- **Publishing:** to the MCP registry, once `highwire-mcp` is on npm.
- **Partnering:** ask the higher.fun team for a stable API contract and an agent rate-limit tier.
