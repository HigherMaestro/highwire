# Changelog

Every release of `highwire-core`, `highwire-mcp` and the site at highwire.fun.

## 0.3.0 (unreleased)

Sign from any chat: the hosted server builds transactions, and highwire.fun/sign signs them in your own wallet.

- **Sign links.** Every build tool's result has a `sign_url`, `https://highwire.fun/sign#…`, carrying the
  unsigned-transaction envelope in the URL fragment (compact JSON, base64url; gzipped only past about 8 KB).
  `HIGHWIRE_SITE_URL` points it at a local site.
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
- **Fixes.** The decoder now names the right pool and accounts for a CPMM `collect_creator_fee`.
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
