# Roadmap

## v0.1: read-only (done)

17 tools over the public API and Solana RPC, 4 prompts, 2 resources, an operator skill. No keys and no signing.

## v0.2: transactions, unsigned by default

Build transactions with Raydium's SDK (`@raydium-io/raydium-sdk-v2`, LaunchLab and CPMM modules) and higher.fun's
platform configs (docs/higher-reference.md). By default, return them **unsigned** (base64) for the user's own wallet
to sign.

| Tool | What it does |
|---|---|
| `quote_trade` | Buy or sell quote on the curve (LaunchLab) or the pool (CPMM): output, fees by mode, price impact |
| `build_trade` | The same, as an unsigned transaction. Needs `confirm_trade: true` and `max_slippage_bps` |
| `build_launch` | Reserve a `…high` mint, upload the image and metadata, create the coin on the chosen fee mode, pay the 0.02 SOL launch fee, optional dev buy. Needs `confirm_launch: true` |
| `build_claim_creator_fees` | Curve creator fees (LaunchLab) and locked-LP fees after graduation (Raydium LP lock) |
| `get_wallet_positions` | Token balances on higher.fun coins, valued from the API |

Rules:
- `z.literal(true)` confirm flags on every tool that moves funds. The tool description says to set the flag only after
  the user has approved that exact trade.
- Quote before build. Hard caps on SOL in and on slippage. Idempotency keys for launches, so a retry never pays twice.

Checks to copy from higher.fun's own web app before signing anything:
- the launch-fee treasury equals the platform config's `platformClaimFeeWallet`
- the fee is at or under higher.fun's cap
- each decoded instruction matches the intended trade

## v0.3: optional local signer

An opt-in mode that signs with a local keypair (`HIGHER_KEYPAIR_PATH`), with:
- a per-trade and a per-day SOL limit
- a mint allowlist or denylist
- a dry-run default

Off unless the user configures it. Never accept a key through a tool argument.

## Later

- **Streamable HTTP transport** with OAuth.
- **Live feed:** subscribe to `wss://api.higher.fun/ws` for launches, trades and graduations.
- **Sign-in tools:** posting comments and chat through `/auth/nonce` and `/auth/verify`, if higher.fun wants agents posting.
- **Publishing:** to npm (`npx higher-mcp`) and to the MCP registry.
- **Partnering:** ask the higher.fun team for a stable API contract and an agent rate-limit tier.
