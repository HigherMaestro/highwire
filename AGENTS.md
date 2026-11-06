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
| `packages/core/src/lib/` | HTTP client with retries, and the error classes |
| `packages/core/src/solana/rpc.ts` | the few RPC reads we need, over fetch |
| `packages/core/src/risk.ts` | `evaluateRisk`, the rug-check verdict |
| `packages/core/src/tx/` | quotes and unsigned transactions: `chain.ts` (web3.js and Raydium's SDK behind one fetch), `quote.ts`, `trade.ts`, `launch.ts` (also `DerivedLaunchKeys`), `claim.ts`, `positions.ts`, `decode.ts` (plain-language decoding and the safety checks), `envelope.ts` (the memo, simulation, `finish()`), `format.ts` (the envelope types), `sign-link.ts` (sign URLs), `review.ts` (the sign page's checks), `refresh.ts` (blockhash refresh for wallet-only transactions) |
| `packages/core/src/tx/fees.ts` | `ecosystemFees`: every higher.fun coin's fees by recipient and phase, for /fees. Curve lines are measured, pool lines computed from volume at on-chain rates |
| `packages/core/src/tx/transfer.ts` | `buildTransfer`: SOL or a higher.fun coin to another wallet. Transfers never get a sign link |
| `packages/agent/src/` | `highwire-agent`, the opt-in local signer: `policy.ts` (the schema and `checkPolicy`), `keypair.ts`, `audit.ts` (the JSONL log and the daily count), `signer.ts` (`LocalSigner`: check, re-simulate, sign, send, confirm), `paths.ts` (`~/.highwire`) |
| `packages/mcp/src/tools/execute.ts` | `build_transfer`, `get_signer_status` and the execute tools; `signer-env.ts` turns the signer on from `HIGHWIRE_KEYPAIR_PATH` (the CLI only) |
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
| `apps/web/next.config.ts` | Turbopack aliases and `/sign`'s security headers (its CSP allows connections to the RPC origins only) |
| `CHANGELOG.md` | every release; add to the top section with each change |
| `packages/*/test/` | `node:test` via tsx. `server.test.ts` and `http.test.ts` drive the real server with a fake API |
| `*/scripts/smoke.ts` | the live checks: stdio in `packages/mcp`, hosted in `apps/web` |
| `packages/mcp/scripts/simulate.ts` | `npm run simulate`: builds and simulates trades, launches and claims on mainnet and devnet |
| `packages/mcp/scripts/rehearse.ts` | `npm run rehearse`: the execute tools, live, for a public wallet on mainnet and devnet, with the send replaced by a simulation of the signed bytes |
| `packages/core/test/fixtures/` | recorded mainnet responses the transaction tests replay; re-record with `npm run record-fixtures -w highwire-core` |
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
  is a per-instance brake). Build calls cost `BUILD_COST` units of the rate limit.
- **Next.js** is 16 (App Router, Turbopack). Its docs ship in `node_modules/next/dist/docs/`; check them rather than
  memory before using a Next API. `next build` and `next dev` share `apps/web/.next`: if dev fails with a
  `next/font` "Module not found" error, stop it, delete `apps/web/.next` and start it again.
- **Dependencies:** pin exact versions, at least two weeks old.
- **Original code only:** write it yourself rather than porting another project's code, and don't name or credit
  other agent-tooling projects as inspiration, in the repo or on the site. Naming the platforms Highwire works with
  (higher.fun, Raydium, Solana) is fine.

## Before you say it's done

Run `npm run typecheck`, `npm test` and `npm run build` from the root. Run `npm run smoke` too, which needs network
access and starts `next dev`, and `npm run simulate` when you touch the transaction code (`npm run rehearse -w highwire-mcp` when you touch the signer). If the API changed shape, update `packages/core/src/higher/api.ts` and
docs/higher-reference.md together.
