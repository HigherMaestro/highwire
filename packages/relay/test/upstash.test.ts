import { test } from "node:test";
import assert from "node:assert/strict";
import { CAS_SCRIPT, INCR_SCRIPT, UpstashStore } from "../src/upstash.ts";
import { JsonRpc } from "../src/rpc.ts";
import { FakeClock } from "../src/clock.ts";
import { createRelay } from "../src/http.ts";
import { FakeCoins, FakeRpc, launchTx, memoTx, MINT, WALLET } from "../src/testing.ts";
import { randomHex, sha256Hex } from "../src/registration.ts";

// The Upstash store against a fake of Upstash's REST API that runs the same commands (the two Lua scripts as their
// JavaScript equivalents), and the whole referee on top of it: a registration and a full house match.

function fakeUpstash(clock: FakeClock) {
  const data = new Map<string, { hash?: Record<string, string>; n?: number; expires: number | null }>();
  const live = (k: string) => {
    const e = data.get(k);
    if (e && e.expires !== null && e.expires <= clock.now()) {
      data.delete(k);
      return undefined;
    }
    return e;
  };
  const sent: unknown[][] = [];
  let down = false;
  const fetch = (async (_url: string, init: RequestInit) => {
    if (down) throw new Error("connection refused");
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer tok");
    const cmd = JSON.parse(String(init.body)) as (string | number)[];
    sent.push(cmd);
    const ok = (result: unknown) => new Response(JSON.stringify({ result }));
    const [name, ...a] = cmd;
    if (name === "HMGET") {
      const e = live(String(a[0]));
      return ok([e?.hash?.v ?? null, e?.hash?.d ?? null]);
    }
    if (name === "DEL") return ok(data.delete(String(a[0])) ? 1 : 0);
    if (name === "EVAL" && a[0] === CAS_SCRIPT) {
      const [, , key, ver, doc, ttl] = a as [string, number, string, number, string, number];
      const e = live(key);
      const cur = Number(e?.hash?.v ?? 0);
      if (cur !== Number(ver)) return ok(0);
      data.set(key, { hash: { v: String(cur + 1), d: doc }, expires: Number(ttl) > 0 ? clock.now() + Number(ttl) * 1000 : null });
      return ok(cur + 1);
    }
    if (name === "EVAL" && a[0] === INCR_SCRIPT) {
      const [, , key, by, ttl] = a as [string, number, string, number, number];
      const e = live(key);
      const n = (e?.n ?? 0) + Number(by);
      data.set(key, { n, expires: e ? e.expires : clock.now() + Number(ttl) * 1000 });
      return ok(n);
    }
    return new Response(JSON.stringify({ error: `unknown command ${name}` }), { status: 400 });
  }) as typeof globalThis.fetch;
  return { fetch, sent, data, setDown: (d: boolean) => (down = d) };
}

test("the Upstash store: versioned documents, compare-and-set, counters, expiry and a prefix", async () => {
  const clock = new FakeClock();
  const up = fakeUpstash(clock);
  const s = new UpstashStore({ url: "https://up.test/", token: "tok", fetch: up.fetch });
  assert.equal(await s.get("a"), null);
  assert.equal(await s.cas("a", 0, { x: 1 }), 1);
  assert.equal(await s.cas("a", 0, { x: 2 }), null, "a stale version loses");
  assert.deepEqual(await s.get("a"), { value: { x: 1 }, version: 1 });
  assert.equal(await s.cas("a", 1, { x: 3 }, 60), 2);
  clock.advance(61_000);
  assert.equal(await s.get("a"), null, "expired");
  assert.equal(await s.incr("c", 5, 120), 5);
  assert.equal(await s.incr("c", 1, 120), 6);
  await s.del("c");
  assert.equal(await s.incr("c", 1, 120), 1);
  assert.ok(up.sent.every((c) => typeof c[0] === "string" && (c[0] === "EVAL" ? String(c[3]) : String(c[1])).startsWith("line:")), "every key is prefixed");
  up.setDown(true);
  await assert.rejects(s.get("a"), (e: { code?: string }) => e.code === "paused");
});

test("the whole referee runs on the Upstash store: a registration and a full house match", async () => {
  const clock = new FakeClock();
  const up = fakeUpstash(clock);
  const store = new UpstashStore({ url: "https://up.test", token: "tok", fetch: up.fetch });
  const rpc = new FakeRpc();
  const relay = createRelay({ store, clock, rpc, coins: new FakeCoins(clock.now()) });
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await relay.fetch(new Request(`https://x.test${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as any };
  };
  const secret = randomHex();
  const ch = await call("POST", "/api/agents/challenge", { wallet: WALLET, mint: MINT, launchSignature: rpc.add(launchTx()), secretHash: sha256Hex(secret) });
  assert.equal(ch.status, 200);
  const reg = await call("POST", "/api/agents/register", { code: ch.body.code, signature: rpc.add(memoTx(WALLET, ch.body.memo, clock.now() + 1000)), secret, adult: true });
  assert.equal(reg.status, 200);
  let v = (await call("POST", "/api/arena/join", { fallback: "zero" }, reg.body.arenaToken)).body;
  while (v.round !== null) {
    clock.advance(5000);
    const res = await call("POST", "/api/arena/move", { match: v.id, round: v.round, pull: Math.min(2, v.energy[v.you]), nonce: randomHex(16), line: "" }, reg.body.arenaToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    v = res.body;
  }
  assert.ok(v.ending && v.house.seed);
  // About how many commands a match costs, for the budget.
  assert.ok(store.commands < 1500, `${store.commands} commands`);
});

test("the JSON-RPC client asks for confirmed transactions in the JSON shape", async () => {
  const seen: any[] = [];
  const f = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seen.push(body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: body.method === "getGenesisHash" ? "g" : null }));
  }) as typeof globalThis.fetch;
  const rpc = new JsonRpc("https://rpc.test", 1000, f);
  assert.equal(await rpc.genesisHash(), "g");
  assert.equal(await rpc.getTransaction("sig"), null);
  assert.deepEqual(seen[1].params, ["sig", { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
});
