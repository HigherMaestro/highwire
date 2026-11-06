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
| Locked LP fees | none | 10 parts creator, 20 parts higher.fun (paid off-chain; see below) |
| Optional creator lock | no | 1–10% of supply: 7-day cliff after graduation, then linear over 30 days |
| Launch for an X or GitHub account | no | yes (Privy holds the wallet; the owner claims at `/claim`) |
| LaunchLab platform config (mainnet) | `7mT6fb3m6W2886ymKsShBBcnX3TYb9ZsnkDJtACsVt8V` | `6ngXxsSPUxp9YEX2QBXQP1DEdNud12tobUmnJVN74D5v` (`rallyPlatform` in the bundle) |

The bundle also enforces caps: platform fee ≤ 100 bps and creator fee ≤ 50 bps.

A PlatformConfig account starts with an 8-byte discriminator and the u64 `epoch`, so `platformClaimFeeWallet` is the
32 bytes at offset 16. The sign page reads it there, from the browser, to check a launch fee's destination.

On-chain (decoded 2026-11-05) the two platform configs say the same: New school `feeRate` 5000 and `creatorFeeRate`
2500 (per million), LP split `platformScale` 300000 / `creatorScale` 0 / `burnScale` 700000; Old school fees 0, LP
burn 1000000, `platformVestingScale` 1000000 (its 1% reserve vests to higher.fun) and `restrictCurveParam` 1 (a curve
rule account is passed on create). Both point at the CPMM config `D4FPEru…`. The fee wallets differ: New school
`platformClaimFeeWallet` is `7j6tyzmUbb7K1J178ciwuvrTEd6VnK6fwan7tycM6g1Q` (the launch-fee treasury), Old school's is
`5QM5XkjJVLUYEx3wdcmvHx75PENugpKR9pivkgEYuJpb`. The site checks the launch-fee treasury against the **New school**
config for both modes, and so does Highwire.

**After graduation** every coin trades in a CPMM pool on config `D4FPEru…`: `tradeFeeRate` 2500 (0.25%, of which
`protocolFeeRate` 12% and `fundFeeRate` 4% go to Raydium, the rest to LPs), plus a pool creator fee
`creatorFeeRate` 500 (0.05%) charged on the SOL side (`feeOn` names that side: 1 when SOL is token0, as in $HIGH's pool, 2 when it's token1). The pool's `poolCreator` is the coin's creator, who
claims it with CPMM `collect_creator_fee`; Raydium keeps `creatorFeeShareRate` 50000 (5%) of it. This applies to Old
school coins too: a graduated Old school coin pays its creator.

**Locked LP fees (New school).** At graduation the 30% locked LP goes into Raydium's LP lock with its Fee Key NFT sent
to the platform's `platformLockNftWallet`, which is higher.fun's wallet, not the creator's (`creatorScale` is 0).
higher.fun harvests the fees and pays the creator their 10/30 share off-chain; the payouts show in
`GET /users/:wallet/earnings` (`paidOut`, `pendingPayout`). There is nothing for the creator to sign.

**Measuring fees** (what /fees does). A LaunchLab pool's `protocolFee` is Raydium's curve fee, accumulated and not reset,
so `protocolFee / tradeFeeRate` is the coin's exact curve volume (it matched higher.fun's candles to within 0.4% on
2026-11-05); `platformFee` reads 0 because platform fees go to the platform's vault as they're charged. A CPMM pool's
`protocolFees*`, `fundFees*` and `creatorFees*` reset when collected, so pool fees are computed from volume. The pool's
`lpAmount` doesn't drop when LP is burned, so the LP lock's share is `(locked_lp + claimed_lp) / lpAmount` (about 31%
for a New school coin). A Raydium LP lock account (program `LockrWmn…`, 256 bytes) is the discriminator, then
`locked_lp`, `claimed_lp`, `unclaimed_lp`, `last_lp` (u64s), `last_k` (u128), `recent_epoch`, then the pool id at
byte 64, the Fee Key mint, the locked owner and the LP mint. Fees are harvested as LP tokens (`claimed_lp`).

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

## Devnet

higher.fun has a devnet deployment (addresses in `packages/core/src/higher/constants.ts`, from the web bundle). On
2026-11-05 its platform configs existed with the same fee rates (New school claim wallet
`2w4carRtFvPApE5rKmiBYVWkatV2xqoDoWzuAS9MUVUu`, Old school `86cuncxUK4dPvrGFR2uYrb1F6DKCgwmoWrhxcjgNUJgX`), 12 LaunchLab
pools on them (some graduated to devnet CPMM pools, with a 0.5 SOL target), and Raydium serves devnet curve
defaults at `https://launch-mint-v1-devnet.raydium.io/main/configs`. `api.higher.fun` has no devnet counterpart that
we know of, so on devnet Highwire charges no launch fee and the research tools keep reading mainnet.

## How higher.fun builds transactions

Source: the site's lazily loaded chunk with module `connectRally` (`/_next/static/chunks/5165.*.js`; the site's code
name is "Rally"), read 2026-11-05, and live transactions. It is Raydium's SDK v2 plus a checker:

- **Launch:** `raydium.launchpad.createLaunchpad` on the LaunchLab SOL config, the mode's platform config, 6 decimals,
  `migrateType: "cpmm"`, `createOnly` when there is no first buy, the launch fee as `txTipConfig` (a System transfer
  appended as the last instruction), the mint keypair as `extraSigners`. Old school passes
  `totalLockedAmount` = 1% of supply, `cliffPeriod` 86400 (1 day) and `unlockPeriod` 2592000 (30 days): that is
  higher.fun's reserve. New school with a creator lock passes `totalLockedAmount` = the lock, cliff 604800 (7 days),
  unlock 2592000, and adds a second transaction with LaunchLab `create_vesting_account` (owner = beneficiary =
  creator, vesting record `getPdaVestId(program, pool, creator)`) that assigns the lock. Supply and the graduation
  target come from Raydium's launch-config API (`supplyInit` 1e15 base units, `totalSellA` 7.931e14, 85 SOL).
- **Curve trades:** `launchpad.buyToken` / `sellToken` (`buy_exact_in` / `sell_exact_in`). Accounts after the CPI event
  authority: System, the platform's claim-fee vault and the creator's claim-fee vault.
- **Graduated trades:** `cpmm.getPoolInfoFromRpc` + `computeSwapAmount` + `cpmm.swap` (`swap_base_input`), with the
  lookup table stripped before review. The pool id is the CPMM PDA of config `D4FPEru…` and the mints sorted.
- **Curve creator fees:** `launchpad.claimCreatorFee` with mint B = WSOL, then a close of the WSOL account. One vault
  per creator across all their coins (`getPdaCreatorVault(program, creator, WSOL)`).
- **Pool creator fees:** CPMM `collect_creator_fee` per graduated pool, batched by size, then a WSOL close.
- **Priority fee:** the 75th percentile of `getRecentPrioritizationFees` on the written accounts, clamped to
  50,000–2,000,000 micro-lamports per CU. Compute limits: create 600k, curve trade 300k, pool swap 300k, claim 200k.
  Default slippage 200 bps; the site allows up to 5000.
- **Checks before signing:** a program allow-list; System transfers only into the signer's own token accounts except
  one launch fee (≤ the quote) and one creator funding; LaunchLab instructions must name the platform config; CPMM
  swaps and fee collects must be the signer's, on config `D4FPEru…`, into the signer's accounts; priority fee ≤ the
  cap. For a launch: the fee is ≤ 50,000,000 lamports (0.05 SOL) and its treasury equals the New school config's
  `platformClaimFeeWallet`; exactly one `initialize_v2` with the signer as creator; the reserved mint signed; the first
  buy spends what was entered and has a min-out. Then it simulates (`sigVerify: false`).

A real launch, `$SI` (`EE3p42u2rACc3PEDcgVdqfg8JRxSYdvbn53rFoc3i1ix`), signature
`8V1ZVUZxbe3gXUS5MNKnEsDTXWWh86Q5sDDewDQjJUL2TxzbfgvbnaCxSAVtLNTu8qxoyaFjgbyT7jc3Dwtz7ZW` (v0, Raydium's lookup table
`AcL1Vo8oy1ULiavEcjSUcwfBSForXMudcZvDZy5nzJkU`): set compute price, set compute limit, LaunchLab `InitializeV2` (payer
and creator the same wallet, config `6s1x…`, platform `6ngX…`, Metaplex metadata created by CPI), create the coin's
ATA, create the WSOL ATA, transfer, sync native, LaunchLab `BuyExactIn` (with the System program and the two fee
vaults appended), and a 0.02 SOL System transfer to `7j6tyzm…`. Highwire's builder produces the same sequence.

Trades on the coin API include third-party routers (Axiom's `FLASHX…`, Jupiter) and transaction version 1 messages;
`getTransaction` needs `maxSupportedTransactionVersion: 1` to read them. Highwire builds v0.

## Sign-in, uploads and mint reservation

- **Wallet sign-in:** `POST /auth/nonce {wallet}` returns `{nonce, message, expiresAt}`; the wallet signs a
  Sign-In With Solana text message (`higher.fun wants you to sign in with your Solana account: … Nonce: … Issued At: …`)
  and `POST /auth/verify {wallet, nonce, signature}` sets a session cookie. All client calls send credentials.
- **Uploads need it.** The create form signs in before it uploads ("Sign-in didn't complete, so nothing was
  uploaded"), then `POST /uploads/image` (multipart `file`, or `/uploads/giphy {id}`) returns `{imageUri}` and
  `POST /uploads/metadata` returns `{metadataUri}`. Metadata is a Metaplex JSON on Pinata IPFS:
  `{name, symbol, description, image, extensions: {website?, twitter?, telegram?}}`. Highwire can't sign the message,
  so `build_launch` takes a hosted `metadata_uri` or returns this JSON to host.
- **Checked on 2026-11-05:** `/auth/nonce` answers without a session and returns the full message to sign, which
  higher.fun's site rebuilds and compares before signing (domain `higher.fun`). `/auth/verify {wallet, nonce,
  signature}` takes a base58 signature and starts a cookie session. `/uploads/metadata` and `/fee-recipients/resolve`
  answer 401 `sign in required` without one. Highwire's local signer signs in this way (`higher/session.ts`). On
  2026-11-06 it signed in from Node with no Origin header, then uploaded an image and metadata: the metadata came back
  as a Pinata URI with `{name, symbol, description, image, extensions}`.
- **Launching for an X or GitHub account (New school):** `POST /fee-recipients/resolve {provider, handle}` returns
  `{provider, handle, wallet}`, or `recipient_unknown`; providers `x` (handle up to 15 of `a-z0-9_`) and `github`. The
  site creates the coin with that wallet as `initialize_v2`'s creator (account 1, not a signer), points the first buy's
  creator vault (account 17 of `buy_exact_in`) at the new creator's, sends the wallet 0.005 SOL if it holds less, allows
  no creator lock, and passes `feeRecipient` in the uploaded metadata. A mainnet simulation of Highwire's build accepted
  it (2026-11-05).
- **`POST /mints/reserve`** returns `{mint, secretKey}`: a vanity `…high` keypair from the server. The site checks the
  secret matches the address and ends in `high`, and silently falls back to a random mint when the call fails. Coins
  with random mints are indexed like any other (many listed coins don't end in `high`). Highwire generates its own
  mint per idempotency key. We didn't call the POST routes, so whether `/mints/reserve` needs the session is unknown.

## Public API (`https://api.higher.fun`)

No auth on the GET routes below. Amounts are strings: lamports for SOL, base units (6 decimals) for tokens, SOL per
token for prices. Lists return `{items, nextCursor}`. On 2026-11-05 `/coins/:mint/trades` rejected its own `nextCursor` (`cursor: Too big: expected string to have <=128 characters`): the cursor is base64 of `[slot, signature, n]`, about 144 characters with an 88-character signature, so the trades list can't be paged past the first 50. Errors look like `{"error":"bad_request","message":"…"}`.

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
