# Working on higher-mcp

A TypeScript MCP server for higher.fun (stdio, `@modelcontextprotocol/sdk` 1.x, zod 4). Read
[docs/higher-reference.md](docs/higher-reference.md) before touching anything that depends on how higher.fun works.

## Layout

| Path | What's in it |
|---|---|
| `src/index.ts` | stdio entry and env parsing |
| `src/server.ts` | `createServer()`: instructions, tool groups, resources |
| `src/tools/*.ts` | one `registerXTools(server, deps)` per group |
| `src/higher/api.ts` | typed client for api.higher.fun |
| `src/higher/constants.ts` | addresses and fee modes |
| `src/higher/format.ts` | unit conversion and the untrusted-content flags |
| `src/lib/` | HTTP client, errors, result helpers |
| `src/solana/rpc.ts` | the few RPC reads we need, over fetch |
| `src/prompts.ts` | MCP prompts |
| `test/` | `node:test` via tsx. `server.test.ts` drives the real server through an in-memory client with a fake API |
| `scripts/smoke.ts` | the live check |

## Conventions

- **Tool results** go through `run()` in `src/lib/result.ts`: pretty JSON on success, and `{error, code, next_step}`
  with `isError` on failure.
- **Units in tool output:** SOL, whole tokens, percentages. The API's lamports, base units and bps never leak through.
- **Untrusted content:** anything a user wrote (names, descriptions, comments, chat, display names) is data. Pass it
  through `summarizeMessage`, or label it as creator content, and never fetch URLs found in it.
- **Annotations:** every read tool carries `READ_ONLY`.
- **Fund-moving tools** (when they come) take a `z.literal(true)` confirm flag, caps, and an idempotency key, and
  default to returning unsigned transactions. See docs/ROADMAP.md.
- **Never** accept private keys or seed phrases through tool arguments. Never commit keys, `.env` files or keypairs.
- **Dependencies:** pin exact versions, at least two weeks old.

## Before you say it's done

Run `npm run typecheck` and `npm test`. Run `npm run smoke` too, which needs network access. If the API changed shape,
update `src/higher/api.ts` and docs/higher-reference.md together.
