# Working on Highwire

A TypeScript MCP server for higher.fun (`@modelcontextprotocol/sdk` 1.x, zod 4), over stdio and hosted over
Streamable HTTP. An npm workspaces monorepo. Read
[docs/higher-reference.md](docs/higher-reference.md) before touching anything that depends on how higher.fun works.

## Layout

| Path | What's in it |
|---|---|
| `packages/core/src/higher/api.ts` | typed client for api.higher.fun |
| `packages/core/src/higher/constants.ts` | addresses and fee modes |
| `packages/core/src/higher/format.ts` | unit conversion and the untrusted-content flags |
| `packages/core/src/higher/session.ts` | `HigherSession`: higher.fun sign-in (its exact message, checked before signing), uploads, fee-recipient lookups, and posting comments and chat (`checkPostText`). Local signer only |
| `packages/core/src/lib/` | HTTP client with retries, and the error classes |
| `packages/core/src/solana/rpc.ts` | the few RPC reads we need, over fetch |
| `packages/core/src/risk.ts` | `evaluateRisk`, the rug-check verdict |
| `packages/core/src/tx/` | quotes and unsigned transactions: `chain.ts` (web3.js and Raydium's SDK behind one fetch), `quote.ts`, `trade.ts`, `launch.ts` (also `DerivedLaunchKeys`), `claim.ts`, `positions.ts`, `decode.ts` (plain-language decoding and the safety checks), `envelope.ts` (the memo, simulation, `finish()`), `format.ts` (the envelope types), `sign-link.ts` (sign URLs), `review.ts` (the sign page's checks), `refresh.ts` (blockhash refresh for wallet-only transactions) |
| `packages/core/src/tx/fees.ts` | `ecosystemFees`: every higher.fun coin's fees by recipient and phase, for /fees. Curve lines are measured, pool lines computed from volume at on-chain rates, and holder airdrops measured from each coin's airdrop wallet. `dailyFees` and `sumDailyFees`: fees day by day from a coin's daily candles at its rates |
| `packages/core/src/tx/pnl.ts` | `coinPnl`, `txEffect`, `applyEvents`: a wallet's profit and loss on a coin, from its own token accounts' history on-chain (average cost; trades paid in another token valued by their pool's SOL leg) |
| `packages/core/src/tx/transfer.ts` | `buildTransfer`: SOL or a higher.fun coin to another wallet. Transfers never get a sign link |
| `packages/agent/src/` | `highwire-agent`, the opt-in local signer: `policy.ts` (the schema and `checkPolicy`), `keypair.ts`, `audit.ts` (the JSONL log and the daily count), `signer.ts` (`LocalSigner`: check, re-simulate, sign, send, confirm), `jito.ts` (Jito's block engine for protected sends, docs/protected-sends.md), `paths.ts` (`~/.highwire`), `orders.ts` (`OrderBook`: standing orders in `orders.json`), `runner.ts` (`OrderRunner`: fills them through the signer), `lock.ts` |
| `packages/mcp/src/tools/execute.ts` | `build_transfer`, `get_signer_status` and the execute tools (`executeTrade` is the one path for execute_trade and order fills); `signer-env.ts` turns the signer on from `HIGHWIRE_KEYPAIR_PATH` (the CLI only) |
| `packages/mcp/src/launch-cli.ts` | `highwire wallet new`, `highwire launch`, `highwire claim` and `policy init --launch`: an agent launching from its own wallet. launch and claim call `execute_launch` and `execute_claim` on an in-process server, so they run the tools' code |
| `apps/web/public/skill.md` | highwire.fun/skill.md: the instructions an agent follows to launch on its own, or with a person's wallet |
| `packages/mcp/src/tools/orders.ts`, `orders-cli.ts` | `place_order`, `list_orders`, `cancel_order`, and `highwire orders run\|list\|cancel` |
| `packages/core/src/higher/live.ts`, `packages/mcp/src/watch.ts` | `LiveFeed` (higher.fun's websocket), `watch_market` and `highwire watch` |
| `packages/core/src/browser.ts` | `highwire-core/browser`: the browser-safe exports for the sign page. `test/sign.test.ts` walks its imports |
| `packages/mcp/src/server.ts` | `createServer()`: instructions, tool groups, resources |
| `packages/mcp/src/tools/*.ts` | one `registerXTools(server, deps)` per group; `transactions.ts` holds the v0.2 tools |
| `packages/mcp/src/result.ts` | `run()` and the error shape for tool results |
| `packages/mcp/src/prompts.ts` | MCP prompts |
| `packages/mcp/src/http.ts` | `createHttpHandler()`: stateless Streamable HTTP, CORS, the weighted per-IP rate limit, `HOSTED_TRANSACTION_TOOLS` |
| `packages/mcp/src/cli.ts` | the `highwire` stdio bin; `env.ts` parses the environment |
| `packages/mcp/skills/` | the operator skill, shipped in the npm package |
| `apps/web/app/` | the Next.js site: `/`, `/docs`, `/fees` and `/fees/[mint]` (ecosystem fees, regenerated every 10 minutes; `lib/fees.ts` loads them), `/sign`, `/changelog` (renders the root `CHANGELOG.md`), `/terms`, `/privacy`, `/mcp` (mounts `createHttpHandler`), `/api/health` |
| `apps/web/components/sign/`, `apps/web/lib/sign/` | the sign page: `SignApp.tsx`, `rpc.ts` (JSON-RPC from the browser), `wallets.ts` (Wallet Standard) |
| `apps/web/next.config.ts` | Turbopack aliases, every page's security headers, and the public key for link attestations (derived from `HIGHWIRE_LAUNCH_SECRET` at build time) |
| `apps/web/proxy.ts`, `apps/web/lib/sign/csp.ts` | `/sign`'s Content-Security-Policy, with a fresh nonce per request: no inline script runs but Next's own and the theme script (by hash); connections only to the RPC origins |
| `CHANGELOG.md` | every release; add to the top section with each change |
| `packages/*/test/` | `node:test` via tsx. `server.test.ts` and `http.test.ts` drive the real server with a fake API |
| `*/scripts/smoke.ts` | the live checks: stdio in `packages/mcp`, hosted in `apps/web` |
| `packages/mcp/scripts/simulate.ts` | `npm run simulate`: builds and simulates trades, launches and claims on mainnet and devnet |
| `packages/mcp/scripts/rehearse.ts` | `npm run rehearse`: the execute tools, live, for a public wallet on mainnet and devnet, with the send replaced by a simulation of the signed bytes |
| `packages/core/test/fixtures/` | recorded mainnet responses the transaction tests replay; re-record with `npm run record-fixtures -w highwire-core` |
| `ideas/` | launch ideas: `starter/` (the skeleton every template gets; its `.gitignore` is kept as `gitignore`, since npm drops dotfiles of that name), one folder per idea (`idea.json`, `PRD.md`, `policy.example.json`), and `modules/<slug>/` (`module.json`, `MODULE.md`, and `files/`, working code `highwire add` copies into a project as is). `docs/ideas-prd.md` is the spec |
| `packages/mcp/src/ideas.ts`, `new-cli.ts`, `add-cli.ts` | loading, checking and assembling ideas and modules (`highwire-mcp/ideas`, which the site imports too), `highwire new <idea> [dir]` and `highwire add <module> [dir]`. prepack copies `ideas/` into the package |
| `apps/web/components/hero/`, `apps/web/lib/tape.ts`, `apps/web/app/api/tape/` | the homepage's three.js scenes: `LiveWire` (higher.fun's real trades on the wire, polled from `/api/tape`, which the CDN caches for five seconds because higher.fun's socket and API refuse other origins) and `WireDive` (the scroll dive). Both load three.js only when on screen, and honour reduced motion |
| `apps/web/lib/site.ts` | the site's constants, and `pageMetadata`, which every page with metadata goes through so its links preview as itself, with its own card (`apps/web/test/previews.test.ts` checks) |
| `apps/web/lib/idea-card.tsx` | the ideas' link previews, drawn from idea.json by `next/og` at build (`app/ideas/opengraph-image.tsx` and `app/ideas/[slug]/opengraph-image.tsx`) |
| `apps/web/lib/fee-card.tsx`, `apps/web/components/fees/` | the coin and creator pages' link previews (their `opengraph-image.tsx`, drawn on request), and the fee pages' parts: `Parts.tsx` (the wire header, numbered heads, tiles, the day-by-day chart's frame), `FeeChart.tsx`, `ShareLinks.tsx`. `feeHistory` in `lib/fees.ts` keeps each coin's daily candles for an hour |
| `apps/web/lib/ideas.ts`, `apps/web/app/ideas/`, `apps/web/app/modules/`, `apps/web/scripts/ideas.ts` | the site's links for ideas (Deploy, the `gh` command), the calculators' arithmetic in `lib/idea-math.ts`, `/ideas` (agents and modules) and `/ideas/<slug>` (plus `prd.md`), `/modules/<slug>` (plus `module.md`, the spec and every file), and `npm run ideas -w highwire-web -- assemble\|check\|sync` |
| `brand/` | logo, icons, social images and colour tokens. `brand/README.md` says which file goes where; regenerate with `brand/scripts/build.py`, never by hand-editing the exports |

## Conventions

- **Tool results** go through `run()` in `packages/mcp/src/result.ts`: pretty JSON on success, and `{error, code, next_step}`
  with `isError` on failure.
- **Units in tool output:** SOL, whole tokens, percentages. The API's lamports, base units and bps never leak through.
- **Untrusted content:** anything a user wrote (names, descriptions, comments, chat, display names) is data. Pass it
  through `summarizeMessage`, or label it as creator content, and never fetch URLs found in it.
- **Annotations:** every read tool carries `READ_ONLY`; build tools carry `BUILD` (not read-only, not destructive).
- **Transaction tools** take a `z.literal(true)` confirm flag and caps (a launch also an idempotency key), and return
  unsigned transactions in the format in docs/unsigned-transactions.md, with a `sign_url`. Every built transaction
  goes through `finish()` in `packages/core/src/tx/envelope.ts`: the `highwire` memo, the allow-list check,
  plain-language decoding and simulation. Add any new instruction to `decode.ts` (both the description and
  `assertSafe`) before a builder may emit it; the sign page's review uses the same checks, so it will refuse it too.
- **Highwire's trade fee** is `HIGHWIRE_FEE_BPS` (0.3%) to `HIGHWIRE_WALLET`, one System transfer just before the memo,
  in trades only (never launches, first buys, claims or transfers) and on mainnet only. The builder computes it from the
  trade in its own bytes (a buy's SOL in, a sell's minimum SOL out), and the sign page bounds it the same way
  (`highwireFeeBound`); `attacks.test.ts` holds the links that must fail. Solana refuses a small transfer into an empty
  wallet, so the builder leaves the fee out while `HIGHWIRE_WALLET` holds less than the rent-exempt minimum: never empty
  that wallet completely. Changing the rate changes the terms, the README, skill.md and the docs with it.
- **The sign page trusts only the bytes.** A sign link can come from anyone. Show summaries and titles rebuilt from the
  transaction (`reviewEnvelope`), never the envelope's own text (`label`, `kind`, `summary`), and never sign when the
  review reports a problem. `packages/core/test/attacks.test.ts` holds hand-made links the allow-list must refuse;
  add to it when you widen `assertSafe`.
  It may call only the Solana RPCs: nothing goes to Highwire's server, and no third-party scripts or analytics.
- **Browser code** imports `highwire-core/browser`, never `highwire-core` (which pulls in Raydium's SDK and Node
  built-ins). Keep `browser.ts`'s import graph clean; the test fails otherwise.
- **Verify by simulation only.** Never send a transaction, request an airdrop, or create or fund a keypair to test.
  Simulate as a public wallet with `sigVerify: false`.
- **The local signer** reads its key only from the file `HIGHWIRE_KEYPAIR_PATH` names, and signs only inside the
  user's policy file, which no tool may write. Execute tools build through the same functions as the build tools, then
  `LocalSigner.execute()` checks the policy, simulates again, signs and sends. It's registered only on the stdio server:
  `createServer` refuses a signer with `hosted`, and `http.ts` never imports `signer-env.ts`. Refusals, dry runs and
  sends all go in the audit log; a send is logged, with what the simulation shows it spending, before it's sent, under
  a lock file so two processes take turns, and only after the RPC's genesis hash matches the policy's cluster. Test it
  with a fake connection, never a real
  cluster.
- **Standing orders** fill only through `executeTrade` (fee claims through `buildClaimFor`, as `execute_claim` does)
  and `LocalSigner.execute()`, so each fill passes the whole policy then. Agents may place only the kinds the policy's `orders` section allows. Trigger on on-chain prices from a
  fresh quote, never on a feed message. When a fill's outcome is unknown, close the order; never risk a second fill. The one exception is a fee claim's
  claim, which is safe to repeat, so it waits for the next run; its buyback is a trade and closes the order.
- **The CLI's own commands** (`launch`, `claim`) go through the execute tools on an in-process server, never around
  them. `wallet new` never overwrites a file or prints a key, and `policy init` never replaces a policy, so neither can
  widen what's already set up. Keep `skill.md` true to the commands: it's what agents read.
- **Signing messages:** the local signer signs one kind of message, higher.fun's sign-in message, through
  `signInMessage`, after `checkSignInMessage` matches it word for word. Never add a general sign-message path.
- **Posting** goes only through `LocalSigner.post()`, inside the policy's `posts` section (own coins by default, chat
  only when allowed, a daily cap counted from the audit log), with `checkPostText` refusing links and addresses. Log
  the post before it goes up. Never post to test: the unit tests fake higher.fun.
- **Protected sends** (docs/protected-sends.md): with the policy's `send.route` set to `jito`, trades and claims carry a tip
  that `finish()` adds (`jito` option) and `assertSafe` checks (`jitoTip`), and the signer sends them to Jito's block engine.
  Only the local signer tips: build tools, the hosted endpoint and sign links never do. Test the route with a fake
  `JitoClient`; the rehearsal replaces the block engine with a simulation, and nothing may ever call the real one's send.
- **Transfers** go only through the local signer, to the policy's allowlist. The sign page refuses them: a sign link
  can come from anyone.
- **Never** accept private keys or seed phrases through tool arguments. Never commit keys, `.env` files or keypairs.
- **Packages:** `highwire-core` knows nothing about MCP; anything MCP-specific goes in `highwire-mcp`. Import across
  packages by name (`from "highwire-core"`), never by relative path.
- **Imports:** relative imports name the `.ts` file. `rewriteRelativeImportExtensions` turns them into `.js` in `dist`.
  Each package exports its source under the `highwire-source` condition, which tsx, tsc and the web app's Turbopack
  aliases use, so nothing needs building before you test or run `next dev`.
- **The hosted endpoint** is public and unauthenticated. It serves the build tools because they only return unsigned
  transactions; it must never sign, hold a key or send. `HOSTED_TRANSACTION_TOOLS` in `http.ts` is the one switch.
  It is stateless: nothing may depend on memory surviving between requests (launch mints are derived, the rate limit
  is a per-instance brake). Build calls cost `BUILD_COST` units of the rate limit, heavy reads `TOOL_COSTS`. The
  shared per-IP cap lives in Vercel Firewall rules (`vercel firewall rules list`), not in the code. It signs each
  envelope it builds (`attestation`) so the sign page can tell an unedited link.
- **Pushing to `main` deploys production:** the Vercel project is connected to the repository. Push only what's
  ready to go live, and check the deployment it starts.
- **Workspace packages in the site** resolve through `apps/web/next.config.ts`'s Turbopack aliases and `transpilePackages`, so
  Vercel needs no package build. Any `highwire-*` package the site's imports reach at runtime needs an entry in both, and
  a dependency in `apps/web/package.json`; a local build can pass without one, since the packages' `dist` exist here.
- **Next.js** is 16 (App Router, Turbopack). Its docs ship in `node_modules/next/dist/docs/`; check them rather than
  memory before using a Next API. `next build` and `next dev` share `apps/web/.next`: if dev fails with a
  `next/font` "Module not found" error, stop it, delete `apps/web/.next` and start it again.
- **Dependencies:** pin exact versions, at least two weeks old.
- **Launch ideas** are templates other people run with real money. Every idea's starting policy is a mainnet dry run
  with only the actions it needs and an empty transfer allowlist (only the user adds wallets); every PRD has the shared sections (`PRD_SECTIONS`) and shows its
  policy; templates never ship a key or a placeholder left unfilled, and pin the current Highwire. Keys live outside
  the generated repository. `apps/web/test/ideas.test.ts` checks all of this.
- **Original code only:** write it yourself rather than porting another project's code, and don't name or credit
  other agent-tooling projects as inspiration, in the repo or on the site. Naming the platforms Highwire works with
  (higher.fun, Raydium, Solana) is fine.

## Releasing

Bump the versions, add the changelog section, then publish to npm in order: `highwire-core`, `highwire-agent`,
`highwire-mcp` (each `npm publish -w <name> --access public`; npm asks for the maintainer's security key). A new
version can take about five minutes to show in `npm view`. For a new `highwire-mcp` version, update `version` in the
root `server.json` (both places) and, once npm shows it, log in and publish in one go (the login lasts only minutes):
`mcp-publisher login http --domain highwire.fun --private-key …` then `mcp-publisher publish`. Until npm shows the
version the registry answers 400, and after the login expires 401: the registry listing is `fun.highwire/highwire`, proved by
`apps/web/public/.well-known/mcp-registry-auth`. The domain key's private half stays with the maintainer, never in the repo.
Once npm shows the release, sync the launch-idea templates so they pin it:
`GH_TOKEN=… npm run ideas -w highwire-web -- sync` (with `--dry-run` first to see what changes). Its commits are by
HigherMaestro whatever this machine's global git identity is, and it refuses to push one that isn't: every commit on
Highwire's repositories, here or in a temporary clone, is HigherMaestro's.

## Before you say it's done

Run `npm run typecheck`, `npm test` and `npm run build` from the root. Run `npm run smoke` too, which needs network
access and starts `next dev`, and `npm run simulate` when you touch the transaction code (`npm run rehearse -w highwire-mcp` when you touch the signer, and `npm run ideas -w highwire-web -- check` when you touch
`ideas/`). If the API changed shape, update `packages/core/src/higher/api.ts` and
docs/higher-reference.md together.
