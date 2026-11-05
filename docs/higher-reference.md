# higher.fun reference

What we know about higher.fun's live deployment, and where each fact came from. Checked 2026-11-05.
Re-check before relying on anything here for transactions: the site can change without notice.

## Sources

- **The site and its JS bundles** (`higher.fun`, Next.js behind Cloudflare). The CSP allows connections only to
  `https://api.higher.fun`, `wss://api.higher.fun` and `https://launch-mint-v1.raydium.io/main/configs`.
- **The docs page**, `https://higher.fun/docs`.
- **The public API**, `https://api.higher.fun`, probed with GET requests.
- **The launchpad-template** on Codeberg (`codeberg.org/higherdotfun/launchpad-template`, MIT). This is a self-hostable
  pump.fun-style template that higher.fun open-sourced. **It is not what higher.fun runs**: production uses Raydium
  LaunchLab and graduates to Raydium CPMM, while the template uses its own Anchor programs and graduates to PumpSwap.

## How it works

- Coins launch on a **Raydium LaunchLab** bonding curve and graduate to a **Raydium CPMM** pool once the curve has
  raised its target. The API reports the target as `85000000000` lamports (85 SOL).
- LaunchLab mints use 6 decimals and a 1B supply. higher.fun reserves vanity mints ending in `high` (`POST /mints/reserve`).
- Launch fee: **0.02 SOL**, sent to treasury `7j6tyzmUbb7K1J178ciwuvrTEd6VnK6fwan7tycM6g1Q` (from `GET /launch-fee`).
  Network fees and rent add under 0.005 SOL. Before paying, the web app checks that the treasury equals the
  platform config's `platformClaimFeeWallet`.
- The docs say no custom contract of higher.fun holds users' SOL.

## Fee modes

The creator picks a mode at launch and can't change it. The web app calls the modes `classic` and `rewards`. The UI
calls them Old school and New school. The coin API returns `feeMode`.

| | `classic` (Old school) | `rewards` (New school) |
|---|---|---|
| Platform fee | 0 bps | 50 bps |
| Creator fee | 0 bps | 25 bps |
| Total per trade, with Raydium's 25 bps | 0.25% | 1% |
| higher.fun's take | 1% of supply if the coin graduates, unlocking over 30 days | 0.5% of each trade |
| Liquidity at graduation | 100% burned | 70% burned, 30% locked |
| Locked LP fees | none | 10 parts creator, 20 parts higher.fun |
| Optional creator lock | no | 1–10% of supply: 7-day cliff after graduation, then linear over 30 days |
| Launch for an X or GitHub account | no | yes (Privy holds the wallet; the owner claims at `/claim`) |
| LaunchLab platform config (mainnet) | `7mT6fb3m6W2886ymKsShBBcnX3TYb9ZsnkDJtACsVt8V` | `6ngXxsSPUxp9YEX2QBXQP1DEdNud12tobUmnJVN74D5v` (`rallyPlatform` in the bundle) |

The bundle also enforces caps: platform fee ≤ 100 bps and creator fee ≤ 50 bps.

## Mainnet addresses (from the web bundle)

| Name | Address |
|---|---|
| LaunchLab program | `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` |
| LaunchLab authority (curve and lock vault) | `WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh` |
| LaunchLab SOL config | `6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX` |
| CPMM program | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` |
| CPMM authority (pool vault) | `GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL` |
| CPMM config | `D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2` |
| LP lock program | `LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE` |
| LP lock authority | `3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH` |
| $HIGH mint | `7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh` (CPMM pool `CqvMZmWDvEufa5rzkubidyR4zMDqDPoLjAtsW6wGsPMu`) |

The bundle has devnet equivalents too. `api.higher.fun/rpc` is an RPC proxy for the web app; we don't depend on it.

## Public API (`https://api.higher.fun`)

No auth on the GET routes below. Amounts are strings: lamports for SOL, base units (6 decimals) for tokens, SOL per
token for prices. Lists return `{items, nextCursor}`. Errors look like `{"error":"bad_request","message":"…"}`.

| Route | Notes |
|---|---|
| `GET /coins?sort=&limit=&cursor=` | sort ∈ `new` `trending` `mcap` `graduating` |
| `GET /search?q=` | name, ticker or mint |
| `GET /coins/:mint` | adds `description`, links, `poolId`, `creatorHoldingBps`, `top10HoldingBps`, `tickerFlagged`, `feeMode`, and `safety` (grade, score, reasons, lock, snipers, bundles, dev) |
| `GET /coins/:mint/trades?cursor=` | `side`, `quoteAmount`, `tokenAmount`, `price`, `blockTime` |
| `GET /coins/:mint/holders` | `shareBps`, `isCreator`, `isCurve` |
| `GET /coins/:mint/candles?interval=` | interval ∈ `1m` `5m` `1h` `1d`; `time` is unix seconds |
| `GET /coins/:mint/comments?cursor=` | user content |
| `GET /coins/highest` | the coin featured on the home page |
| `GET /tape` | live feed; kind ∈ `new` `buy` `sell` `graduated` |
| `GET /leaderboard/coins?window=` | window ∈ `24h` `7d` |
| `GET /leaderboard?kind=&window=` | kind ∈ `traders` `creators` |
| `GET /chat?before=` | site chat, user content |
| `GET /users/:wallet`, `/coins`, `/earnings`, `/locks` | profile, coins created, `paidOut`/`pendingPayout`, creator locks |
| `GET /sol-price`, `GET /launch-fee`, `GET /tickers/:ticker`, `GET /sponsored` | |

Routes the web app uses that we haven't called yet: `/auth/nonce`, `/auth/verify`, `/auth/me`, `/auth/logout` (wallet
sign-in), `POST /uploads/image`, `POST /uploads/metadata`, `POST /mints/reserve`, `POST /fee-recipients/resolve`
(`{provider, handle}` for X/GitHub launches), `POST /chat`, `POST /coins/:mint/comments`, `/sponsor/quote`,
`/sponsor/confirm`, `/users/:wallet/graduated`, `/users/me`, `/reports`, and the `wss://api.higher.fun/ws` live feed.

## Content seen in the wild

- Chat already carries phishing links (a fake "claim your SOL" site). An account with the display name `һіgherfun`,
  spelled with Cyrillic `һ` and `і`, posts as if it were the team. The server flags both patterns.
