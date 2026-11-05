# Changelog

Every release of `highwire-core`, `highwire-agent`, `highwire-mcp` and the site at highwire.fun.

## 0.4.0 (unreleased)

Let an agent act on its own, inside rules you write: an opt-in local signer. Custody stays with you: Highwire never
creates, holds or manages a wallet, and the hosted endpoint still never signs.

- **The local signer** (`highwire-agent`, new). Set `HIGHWIRE_KEYPAIR_PATH` to a Solana CLI keypair file and the local
  server signs for that wallet, only inside `~/.highwire/policy.json`: allowed actions, coins (allow or deny),
  creators, slippage, SOL per transaction and per 24 hours, and transfer recipients. No tool can write the policy.
  Every execute is a dry run until it says `"live": true`. `highwire policy init` writes a starting one (devnet, dry
  run, small limits).
- **Execute tools.** `execute_trade`, `execute_launch`, `execute_claim` and `execute_transfer` build exactly what the
  build tools build, check the policy, simulate again right before signing, then sign, send and confirm, and report the
  wallet's actual balance changes. `get_signer_status` shows the wallet, the policy and what's left of today's limit.
  Local only, and marked destructive.
- **Audit log and kill switch.** `~/.highwire/audit.jsonl` gets one line per refusal, dry run and signature, written as
  each transaction is sent. The daily limit is counted from it. Creating `~/.highwire/STOP` refuses everything.
- **Transfers.** `build_transfer` sends SOL or a higher.fun coin to another wallet, checked to the lamport and the
  recipient. It's local only and has no sign link: the sign page refuses transfers, since a link can come from anyone.
- **Ecosystem fees** at highwire.fun/fees: every fee all of higher.fun's coins have paid and who got it (creators,
  higher.fun, Raydium, the pools), by phase and fee mode, what's waiting to be claimed, and a searchable table of every
  coin, each with its own page at `/fees/<mint>`. Curve fees are measured from each pool's on-chain fee counter; pool
  fees are computed from volume at rates read on-chain, and each line says which. Refreshed every 10 minutes; a failed
  refresh keeps the last good numbers. Coin names that are slurs show as the mint.
- **How a trade's fee splits:** a 3D diagram on /fees (three.js, with our own shaders) of one trade's fee flowing to
  each recipient, on the curve or in the pool, for New school or Old school. Wire thickness and particle density follow
  each share, from the on-chain rates. It loads only when scrolled into view, pauses offscreen, holds still for reduced
  motion, and the list under it says the same in text.
- **`npm run rehearse`** runs the execute tools live against mainnet and devnet for a public wallet, with every rule of
  a small policy, and simulates the signed bytes instead of sending them.
- **Page views.** highwire.fun counts page views with Vercel Web Analytics (no cookies; queries and fragments are
  stripped). The sign page has none: it doesn't load the script, and any event about it is dropped.

## 0.3.0 (unreleased)

Sign from any chat: the hosted server builds transactions, and highwire.fun/sign signs them in your own wallet.

- **Sign links.** Every build tool's result has a `sign_url`, `https://highwire.fun/sign#…`, carrying the
  unsigned-transaction envelope in the URL fragment (compact JSON, base64url; gzipped only past about 8 KB).
  `HIGHWIRE_SITE_URL` points it at a local site. The envelope format is now `highwire.unsigned-tx/v2`, which adds
  `builtAt`; v1 links still decode.
- **Links that last.** Trade and claim links work for up to 10 minutes: the sign page gives transactions only the
  user's wallet signs a fresh blockhash on load and right before signing, refuses if anything else in the bytes
  differs, and checks and simulates again. Past 5 minutes it says how old the quote is (the minimum out still holds);
  past 10 it asks for a rebuild. Launch links, whose new mint is already signed, last about a minute.
- **The sign page.** /sign decodes the envelope in the browser and re-checks every instruction from the bytes, shows
  what is spent and received, the fees, the fee payer and the expiry, simulates each transaction against a Solana RPC
  called directly from the browser, and signs with a Wallet Standard wallet (Phantom, Solflare, Backpack). It refuses
  to sign when a check fails, the blockhash has expired, simulation fails or the wallet isn't the fee payer. It sends
  nothing to Highwire.
- **Build tools on the hosted endpoint.** `quote_trade`, `get_wallet_positions`, `build_trade`, `build_launch` and
  `build_claim_creator_fees` now run at highwire.fun/mcp (22 tools). They only ever return unsigned transactions.
- **A weighted rate limit.** Build tools cost 5 units and everything else 1, out of 60 units a minute per IP.
- **Stateless launches.** A launch's mint is derived from the idempotency key and a server secret
  (`HIGHWIRE_LAUNCH_SECRET`), so a retry on any serverless instance gets the same coin.
- **Attribution memo.** Every built transaction carries one SPL Memo instruction, `highwire`.
- **Browser-safe core.** `highwire-core/browser` exports the envelope format, sign links, the decoder and the review,
  without Node built-ins or Raydium's SDK.
- **Fixes.** The decoder now names the right pool and accounts for a CPMM `collect_creator_fee`, and
  `get_featured_coin` answers `featured: null` instead of failing when higher.fun features nothing.
  `build_trade` no longer times out for wallets that hold thousands of tokens: it reads only the wallet's token
  accounts for the coin and wrapped SOL, where Raydium's SDK would list all of them (hundreds of megabytes for a busy
  trading wallet). `get_wallet_positions` takes `mints` to check only those coins, which reads just their accounts;
  the full listing reads only each account's mint and amount, and past about 60,000 token accounts it says to pass
  `mints` instead of running out of time.
- **Pages.** /terms and /privacy (drafts, pending legal review) and this changelog.

## 0.2.0 (2026-11-05)

Transactions, unsigned, on the local server.

- `quote_trade`: buys and sells on the LaunchLab curve or, after graduation, the Raydium CPMM pool, with fees split
  by fee mode and price impact.
- `get_wallet_positions`: a wallet's SOL and higher.fun coins, recognised on-chain.
- `build_trade`, `build_launch` and `build_claim_creator_fees`: unsigned v0 transactions in the
  `highwire.unsigned-tx/v1` envelope, decoded into plain language, checked against an allow-list and simulated.
- Confirm flags, a slippage cap, a per-transaction SOL cap and launch idempotency keys.
- `HIGHWIRE_CLUSTER=devnet`, `npm run simulate`, and offline tests that replay recorded mainnet state.

## 0.1.0 (2026-11-05)

Read-only.

- 17 tools over higher.fun's public API and Solana RPC: discovery, coin research, creators and wallets, a rug check,
  platform info and site chat, with user-written text flagged as untrusted.
- 4 prompts, 2 resources and an operator skill.
- The hosted endpoint at highwire.fun/mcp (stateless Streamable HTTP), and the site.
