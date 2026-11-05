import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpConfig, request } from "../src/lib/http.js";
import { NotFoundError, ServerError, ValidationError } from "../src/lib/errors.js";

function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const r = responses.shift();
    if (!r) throw new Error("no more fake responses");
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const config = (fetch: typeof globalThis.fetch) =>
  createHttpConfig({ baseUrl: "https://api.example/", retries: 2, retryDelayMs: 1, fetch });

test("builds the URL and skips undefined query values", async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: { items: [] } }]);
  await request(config(fetch), { path: "/coins", query: { sort: "new", cursor: undefined, limit: 5 } });
  assert.equal(calls[0], "https://api.example/coins?sort=new&limit=5");
});

test("retries a 5xx and then succeeds", async () => {
  const { fetch, calls } = fakeFetch([
    { status: 502, body: { error: "bad gateway" } },
    { status: 200, body: { ok: true } },
  ]);
  assert.deepEqual(await request(config(fetch), { path: "/x" }), { ok: true });
  assert.equal(calls.length, 2);
});

test("gives up after the retry budget", async () => {
  const { fetch, calls } = fakeFetch(Array.from({ length: 3 }, () => ({ status: 500, body: { error: "boom" } })));
  await assert.rejects(request(config(fetch), { path: "/x" }), ServerError);
  assert.equal(calls.length, 3);
});

test("maps higher.fun's 400 body to a ValidationError without retrying", async () => {
  const { fetch, calls } = fakeFetch([
    { status: 400, body: { error: "bad_request", message: 'sort: Invalid option: expected one of "new"|"trending"' } },
  ]);
  await assert.rejects(request(config(fetch), { path: "/coins" }), (err: unknown) => {
    assert.ok(err instanceof ValidationError);
    assert.match(err.message, /^sort: Invalid option/);
    assert.equal(err.code, "bad_request");
    return true;
  });
  assert.equal(calls.length, 1);
});

test("404 is a NotFoundError", async () => {
  const { fetch } = fakeFetch([{ status: 404, body: { error: "not_found" } }]);
  await assert.rejects(request(config(fetch), { path: "/coins/x" }), NotFoundError);
});

test("retries a 429 after Retry-After", async () => {
  const { fetch, calls } = fakeFetch([
    { status: 429, body: { error: "slow down" }, headers: { "retry-after": "0" } },
    { status: 200, body: { ok: 1 } },
  ]);
  assert.deepEqual(await request(config(fetch), { path: "/x" }), { ok: 1 });
  assert.equal(calls.length, 2);
});
