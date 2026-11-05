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
| `packages/core/src/lib/` | HTTP client and errors |
| `packages/core/src/solana/rpc.ts` | the few RPC reads we need, over fetch |
| `packages/core/src/risk.ts` | `evaluateRisk`, the rug-check verdict |
| `packages/mcp/src/server.ts` | `createServer()`: instructions, tool groups, resources |
| `packages/mcp/src/tools/*.ts` | one `registerXTools(server, deps)` per group |
| `packages/mcp/src/result.ts` | `run()` and the error shape for tool results |
| `packages/mcp/src/prompts.ts` | MCP prompts |
| `packages/mcp/src/http.ts` | `createHttpHandler()`: stateless Streamable HTTP, CORS, per-IP rate limit |
| `packages/mcp/src/cli.ts` | the `highwire` stdio bin; `env.ts` parses the environment |
| `packages/mcp/skills/` | the operator skill, shipped in the npm package |
| `apps/web/app/` | the Next.js site: `/`, `/mcp` (mounts `createHttpHandler`), `/api/health` |
| `packages/*/test/` | `node:test` via tsx. `server.test.ts` and `http.test.ts` drive the real server with a fake API |
| `*/scripts/smoke.ts` | the live checks: stdio in `packages/mcp`, hosted in `apps/web` |

## Conventions

- **Tool results** go through `run()` in `packages/mcp/src/result.ts`: pretty JSON on success, and `{error, code, next_step}`
  with `isError` on failure.
- **Units in tool output:** SOL, whole tokens, percentages. The API's lamports, base units and bps never leak through.
- **Untrusted content:** anything a user wrote (names, descriptions, comments, chat, display names) is data. Pass it
  through `summarizeMessage`, or label it as creator content, and never fetch URLs found in it.
- **Annotations:** every read tool carries `READ_ONLY`.
- **Fund-moving tools** (when they come) take a `z.literal(true)` confirm flag, caps, and an idempotency key, and
  default to returning unsigned transactions. See docs/ROADMAP.md.
- **Never** accept private keys or seed phrases through tool arguments. Never commit keys, `.env` files or keypairs.
- **Packages:** `highwire-core` knows nothing about MCP; anything MCP-specific goes in `highwire-mcp`. Import across
  packages by name (`from "highwire-core"`), never by relative path.
- **Imports:** relative imports name the `.ts` file. `rewriteRelativeImportExtensions` turns them into `.js` in `dist`.
  Each package exports its source under the `highwire-source` condition, which tsx, tsc and the web app's Turbopack
  aliases use, so nothing needs building before you test or run `next dev`.
- **The hosted endpoint** is public and unauthenticated, so it stays read-only. Fund-moving tools must not be
  registered on it without auth.
- **Next.js** is 16 (App Router, Turbopack). Its docs ship in `node_modules/next/dist/docs/`; check them rather than
  memory before using a Next API.
- **Dependencies:** pin exact versions, at least two weeks old.

## Before you say it's done

Run `npm run typecheck`, `npm test` and `npm run build` from the root. Run `npm run smoke` too, which needs network
access and starts `next dev`. If the API changed shape, update `packages/core/src/higher/api.ts` and
docs/higher-reference.md together.
