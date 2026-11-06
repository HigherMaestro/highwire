# Changelog

Every release of `highwire-core`, `highwire-agent`, `highwire-mcp` and the site at highwire.fun.

## Unreleased

- **Live alerts.** `watch_market` waits on higher.fun's live feed for up to 50 seconds and returns launches,
  graduations, buys and sells as they land: all of higher.fun, or up to 16 coins (with each trader's wallet), and only
  trades above a size if you like. It reports each event as progress while it waits, and says so when the feed dropped
  and events were missed. On the hosted endpoint too, where it costs 5 units of the rate limit.
- **`highwire watch`** prints the same feed in the terminal, one line an event or JSON lines, with the same filters,
  until Ctrl-C. Coin names and tickers are stripped of control characters first, since creators write them.

- **A new link preview.** highwire.fun's card on X and elsewhere is now on ink, and says what Highwire does: your
  agent can trade, launch and claim on higher.fun. The page description says the same, in place of the read-only wording
  from before the transaction tools.
- **The roadmap on the home page** moves install (npm and the MCP Registry) into Now, and lists what's next: live
  alerts, recurring buys and stop-loss, then profit and loss and posting.

## 0.4.2 (2026-11-06)

- **Launch retries survive a restart.** The `highwire` CLI derives launch mints from a secret it keeps in
  `~/.highwire/launch-secret` (created once, readable only by you) when `HIGHWIRE_LAUNCH_SECRET` isn't set. Before, it
  kept them in memory, so a retry after a restart got a new mint and could launch the coin twice.
- **A creator lock that never got assigned can be finished.** A launch with a creator lock is two transactions. If the
  coin landed but the assignment expired or failed, a retry with the same idempotency key now builds just the
  assignment instead of returning `already_launched`. The sign page accepts a link holding only that assignment.

## 0.4.1 (2026-11-06)

- **The MCP registry.** `highwire-mcp` is listed as `fun.highwire/highwire`, with both ways to run it: the npm package
  (`npx highwire-mcp`) and the hosted endpoint. highwire.fun serves the registry's domain proof at
  `/.well-known/mcp-registry-auth`.
- **Sign links survive chat apps.** The sign page strips the percent-encoding, line breaks and zero-width spaces that
  chat apps put into long links before decoding, and says plainly when a link was cut short.

## 0.4.0 (2026-11-06)

The first release on npm: `highwire-core`, `highwire-agent` and `highwire-mcp` 0.4.0. `npx highwire-mcp` runs the
local server.

**Security fixes from the pre-launch audit.**

- **Sign links.**
  - **What the allow-list let through:** a hand-made link could pass every check on the sign page with any of these:
    - an associated-token account opened under an attacker's own program, then SOL sent into it;
    - SOL parked in a token account for a mint someone else controls;
    - a curve trade that named someone else's token accounts, paid a share fee, or set no minimum out.
  - **What it allows now:** SOL moves only into the wallet's own wrapped-SOL accounts. Associated-token opens pin the
    token program and the derived address. Curve trades must match the exact layout Highwire builds.
- **The sign page.**
  - It no longer shows any text from the link: titles are rebuilt from the bytes.
  - It refuses a link that misnames what it does, or that claims to have been built in the future.
  - It shows how far a trade's minimum out sits below what the simulation gets, and refuses more than 50%.
  - It checks that lookup tables are real.
  - It stops polling for refused links and hidden tabs.
- **The local signer.**
  - **Logged before sending:** each send is logged and counted before it goes out, so a lost answer can't hide a
    spend.
  - **Real spend counted:** the daily limit counts what the simulation shows leaving the wallet, rent and fees
    included.
  - **One execute at a time:** a lock file makes two Highwire processes take turns.
  - **Right cluster:** the RPC's genesis hash must match the policy's cluster.
  - **Kill switch:** STOP is checked before every transaction.
  - **Slippage and creator:** a trade's slippage is read from the signed bytes, and its creator from the chain.
  - **Audit log:** a torn last line in the log no longer swallows the next entry.
  - **Permissions:** loose permissions on the policy or its folder trigger a warning.
- **The hosted endpoint.**
  - Upstream error text is scrubbed of URLs and keys before it reaches a caller.
  - Heavy reads cost more of the rate limit: `get_wallet_positions` costs 10, or 3 with `mints`; `quote_trade` and
    `rug_check` cost 2.
  - A request may batch at most 10 messages, and bodies are capped as they stream.
  - IPv6 clients are limited per /64.
  - CORS allows only POST.
  - Profile bios, display names and leaderboard rows are labelled as user content.
- **Signed links.**
  - **What's signed:** the hosted server signs each envelope it builds (`attestation`): its build time and the exact
    transaction bytes, with a key derived from `HIGHWIRE_LAUNCH_SECRET`.
  - **What the sign page shows:** "built by highwire.fun, unchanged since" when the signature checks out. A link with a
    signature that doesn't match its contents is refused.
  - **Unverified links:** one with no signature, such as a local server's, still works. It's marked unverified and may
    accept at most 20% below the current price instead of 50%.
- **/sign allows no inline scripts:** its Content-Security-Policy carries a fresh nonce per request (`proxy.ts`), and
  the theme script is allowed by its hash.
- **A shared rate limit:** Vercel Firewall rules cap `/mcp` at 60 requests a minute per IP, and `/fees` at 120, across
  every instance. The endpoint's own weighted limit still applies within that.
- **Live policies:** the signer warns, at start-up and in `get_signer_status`, when a live policy lets an agent trade
  any coin (no `coins.allow` or `creators.allow`).
- **The site.**
  - Every page now sends `nosniff`, no-framing, referrer, permissions and HSTS headers.
  - `/fees/<mint>` costs one read for an address that isn't a higher.fun coin.
  - Coin names with links or look-alike letters are hidden, on the home page too.
  - Changelog links are restricted to https.

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
- **Fee tools.** `get_ecosystem_fees` (totals by recipient, phase and fee mode, what's waiting to be claimed, the top
  coins) and `get_coin_fees` (one coin, line by line), on the hosted endpoint too: the numbers behind highwire.fun/fees.
- **Launches with an image, and for someone else (local signer).**
  - **`image_path`:** `execute_launch` takes an image file. The signer signs higher.fun's sign-in message, checked word
    for word, then uploads the image and metadata. Only a real image of at most 4 MB is read, never anything from the
    signer's folder.
  - **`launch_for`:** an X or GitHub handle, New school. higher.fun resolves the handle to the wallet that holds that
    account's fees. The coin is created for that wallet, which gets 0.005 SOL if it holds less.
  - The sign page still never signs a launch for someone else.
  - higher.fun hasn't switched on the handle lookup yet. Until it does, `launch_for` stops with
    `launch_for_unavailable`, before uploading or spending anything.
- **Donations:** Highwire's one donation wallet, `7LnP9W1BcRhGRtUgSweGbGndaKaRmQxKVtCEHTeW7Rce`, is on the home page,
  linked from every page's footer.
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

## 0.3.0 (2026-11-05)

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
