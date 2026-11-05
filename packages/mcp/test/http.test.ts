import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BUILD_COST, createHttpHandler, createRateLimiter, requestCost, type HttpHandlerOptions } from "../src/http.ts";
import { HOSTED_INSTRUCTIONS } from "../src/server.ts";
import { ALL_TOOLS, FAKE_OPTIONS } from "./fake.ts";
import { fixtureFetch } from "./replay.ts";

const URL_ = "https://highwire.test/mcp";

// The real MCP client, with its fetch pointed straight at the handler.
async function connect(opts: HttpHandlerOptions = {}) {
  const handler = createHttpHandler({ server: FAKE_OPTIONS, ...opts });
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    fetch: (input, init) => handler(new Request(input, init)),
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

const initialize = () =>
  new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Forwarded-For": "203.0.113.7" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });

test("an MCP client lists every tool and calls one over HTTP", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  // The hosted endpoint serves the build tools too: they only return unsigned transactions and a sign link.
  assert.deepEqual(tools.map((t) => t.name).sort(), ALL_TOOLS);
  assert.ok(client.getInstructions()?.includes(HOSTED_INSTRUCTIONS));
  const res = await client.callTool({ name: "list_coins", arguments: { sort: "new", limit: 1 } });
  const out = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
  assert.equal(out.coins[0].ticker, "HE");
  await client.close();
});

test("responses are JSON, carry CORS headers and no session ID", async () => {
  const res = await createHttpHandler({ server: FAKE_OPTIONS })(initialize());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("mcp-session-id"), null);
  const body = (await res.json()) as { result: { serverInfo: { name: string } } };
  assert.equal(body.result.serverInfo.name, "highwire");
});

test("preflight is answered, and GET and DELETE are 405", async () => {
  const handler = createHttpHandler({ server: FAKE_OPTIONS });
  const pre = await handler(new Request(URL_, { method: "OPTIONS" }));
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /Mcp-Protocol-Version/);
  for (const method of ["GET", "DELETE"]) {
    const res = await handler(new Request(URL_, { method }));
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "POST, OPTIONS");
  }
});

test("POSTs over the per-IP limit get a 429 with Retry-After", async () => {
  const handler = createHttpHandler({ server: FAKE_OPTIONS, rateLimit: { limit: 2, windowMs: 60_000 } });
  assert.equal((await handler(initialize())).status, 200);
  assert.equal((await handler(initialize())).status, 200);
  const limited = await handler(initialize());
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(limited.headers.get("access-control-allow-origin"), "*");
});

const toolCall = (name: string, args: Record<string, unknown> = {}) =>
  new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Forwarded-For": "203.0.113.9" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });

test("build tools cost five units of the per-IP budget, everything else one", async () => {
  assert.equal(requestCost(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "build_trade" } })), BUILD_COST);
  assert.equal(requestCost(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quote_trade" } })), 1);
  assert.equal(requestCost(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })), 1);
  assert.equal(requestCost("not json"), 1);
  const handler = createHttpHandler({ server: FAKE_OPTIONS, rateLimit: { limit: 11, windowMs: 60_000 } });
  assert.equal((await handler(toolCall("build_claim_creator_fees", { wallet: "H4dxJQN6DRqCPva9yaX2Nt3mAkvgo7pyQZr93fLke1U5" }))).status, 200);
  assert.equal((await handler(toolCall("build_claim_creator_fees", { wallet: "H4dxJQN6DRqCPva9yaX2Nt3mAkvgo7pyQZr93fLke1U5" }))).status, 200);
  // 10 units spent: a third build would overspend, but a read still fits.
  assert.equal((await handler(toolCall("build_trade"))).status, 429);
  assert.equal((await handler(toolCall("get_platform_info"))).status, 200);
  assert.equal((await handler(toolCall("get_platform_info"))).status, 429);
});

test("hosted build_launch derives its mint, so a retry on another instance gets the same coin", async () => {
  const args = {
    wallet: "H4dxJQN6DRqCPva9yaX2Nt3mAkvgo7pyQZr93fLke1U5",
    name: "Stateless Cat",
    ticker: "SCAT",
    fee_mode: "rewards",
    idempotency_key: "7f8c1a2e-0b4d-4f7e-9a51-3c2d1e0f9a8b",
    confirm_launch: true,
  };
  const mintFrom = async (opts: HttpHandlerOptions) => {
    const res = await createHttpHandler({ ...opts, rateLimit: false })(toolCall("build_launch", args));
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    return JSON.parse(body.result.content[0]!.text) as { status: string; mint: string };
  };
  // Two handlers stand in for two serverless instances; nothing is shared between them.
  const a = await mintFrom({ server: { ...FAKE_OPTIONS, launchKeySecret: "test-secret" } });
  const b = await mintFrom({ server: { ...FAKE_OPTIONS, launchKeySecret: "test-secret" } });
  assert.equal(a.status, "needs_metadata");
  assert.equal(a.mint, b.mint);
  const other = await mintFrom({ server: { ...FAKE_OPTIONS, launchKeySecret: "another-secret" } });
  assert.notEqual(other.mint, a.mint);
});

test("a hosted build returns the unsigned transaction and a sign link to highwire.fun", async () => {
  const handler = createHttpHandler({ server: { fetch: fixtureFetch("buy-curve"), retries: 0 }, rateLimit: false });
  const res = await handler(
    toolCall("build_trade", {
      wallet: "H4dxJQN6DRqCPva9yaX2Nt3mAkvgo7pyQZr93fLke1U5",
      mint: "EE3p42u2rACc3PEDcgVdqfg8JRxSYdvbn53rFoc3i1ix",
      side: "buy",
      sol: 0.01,
      max_slippage_bps: 200,
      max_sol: 5,
      confirm_trade: true,
    }),
  );
  const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  const out = JSON.parse(body.result.content[0]!.text);
  assert.ok(!body.result.isError, body.result.content[0]!.text);
  assert.match(out.sign_url, /^https:\/\/highwire\.fun\/sign#ey/);
  assert.equal(out.unsigned.transactions.length, 1);
});

test("the rate limiter counts per key and resets each window", () => {
  let now = 0;
  const allow = createRateLimiter({ limit: 1, windowMs: 1000 }, () => now);
  assert.equal(allow("a").ok, true);
  assert.equal(allow("a").ok, false);
  assert.equal(allow("b").ok, true);
  now = 1000;
  assert.equal(allow("a").ok, true);
  const weighted = createRateLimiter({ limit: 6, windowMs: 1000 }, () => now);
  assert.equal(weighted("c", 5).ok, true);
  assert.equal(weighted("c", 5).ok, false, "a refused call spends nothing");
  assert.equal(weighted("c", 1).ok, true);
  assert.equal(weighted("c", 1).ok, false);
});
