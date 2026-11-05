import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpHandler, createRateLimiter, type HttpHandlerOptions } from "../src/http.js";
import { ALL_TOOLS, FAKE_OPTIONS } from "./fake.js";

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
  assert.deepEqual(tools.map((t) => t.name).sort(), ALL_TOOLS);
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

test("the rate limiter counts per key and resets each window", () => {
  let now = 0;
  const allow = createRateLimiter({ limit: 1, windowMs: 1000 }, () => now);
  assert.equal(allow("a").ok, true);
  assert.equal(allow("a").ok, false);
  assert.equal(allow("b").ok, true);
  now = 1000;
  assert.equal(allow("a").ok, true);
});
