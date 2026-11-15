import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { agentPaths, LocalSigner } from "highwire-agent";
import { createRelay, FakeClock, MemoryStore } from "highwire-relay";
import { FakeCoins, FakeLinkEngine, FakeRpc, launchTx, memoTx, MINT, WALLET } from "highwire-relay/testing";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerOptions } from "../src/server.ts";
import { serverOptionsFromEnv } from "../src/env.ts";
import { FAKE_OPTIONS } from "./fake.ts";

// Link battles' tools (docs/link-battles.md 6): off until rated play opens (HIGHWIRE_LINK=1 turns them on), link_rules
// asks the referee, and link_practice exists only with the local signer (it plays with the fighter's arena token). The
// referee's practice routes are tested in highwire-relay with a fake engine.

async function connect(opts: Partial<ServerOptions>) {
  const server = createServer({ ...FAKE_OPTIONS, ...opts } as ServerOptions);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("link battles' tools are off by default and with HIGHWIRE_LINK unset", async () => {
  assert.equal(serverOptionsFromEnv({}).link, false);
  assert.equal(serverOptionsFromEnv({ HIGHWIRE_LINK: "1" }).link, true);
  const names = (await (await connect({})).listTools()).tools.map((t) => t.name);
  assert.ok(!names.some((n) => n.startsWith("link_")));
});

test("with them on and no signer, only the rules and the ladder, read from the referee", async () => {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "relay.test") {
      calls.push(url.pathname);
      return Response.json({ format: "colosseum-1", banned_moves: ["Counter"] });
    }
    return (FAKE_OPTIONS.fetch as typeof globalThis.fetch)(input, init);
  }) as typeof globalThis.fetch;
  const client = await connect({ link: true, fetch, relayUrl: "https://relay.test" });
  const names = (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("link_"));
  assert.deepEqual(names, ["link_rules", "link_leaderboard"], "practice and rated play need the local signer");
  const res = await client.callTool({ name: "link_rules", arguments: {} });
  const body = JSON.parse((res.content as { text: string }[])[0]!.text);
  assert.equal(body.format, "colosseum-1");
  assert.deepEqual(calls, ["/api/link/rules"]);
});

test("rated link battles through the tools: join the house, decide each turn to the end, and the token never shows", async () => {
  const clock = new FakeClock(Date.now());
  const rpc = new FakeRpc();
  const tasks: (() => Promise<unknown>)[] = [];
  const relay = createRelay({ store: new MemoryStore(clock), clock, rpc, coins: new FakeCoins(clock.now()), link: { engine: new FakeLinkEngine(), rated: true, defer: (t) => tasks.push(t) } });
  const flush = async () => {
    while (tasks.length) await tasks.shift()!();
  };
  const api = async (method: string, path: string, body?: unknown): Promise<any> => (await relay.fetch(new Request(`https://relay.test${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }))).json();
  // The fighter, registered as line_register would leave it: its token in agent.json, read only by this server.
  const secret = randomBytes(32).toString("hex");
  const ch = await api("POST", "/api/agents/challenge", { wallet: WALLET, mint: MINT, launchSignature: rpc.add(launchTx({ payer: WALLET, mint: MINT })), secretHash: createHash("sha256").update(secret).digest("hex") });
  const reg = await api("POST", "/api/agents/register", { code: ch.code, signature: rpc.add(memoTx(WALLET, ch.memo, clock.now() + 5000)), secret });
  const token = reg.arenaToken as string;
  const paths = agentPaths({ HIGHWIRE_HOME: mkdtempSync(join(tmpdir(), "highwire-link-")) });
  writeFileSync(paths.agent, JSON.stringify({ arena: { token, fighter: MINT, relay: "https://relay.test", registeredAt: new Date().toISOString() } }));
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "relay.test") return relay.fetch(new Request(url, init));
    return (FAKE_OPTIONS.fetch as typeof globalThis.fetch)(input, init);
  }) as typeof globalThis.fetch;
  const client = await connect({ link: true, fetch, relayUrl: "https://relay.test", signer: new LocalSigner(Keypair.generate(), paths) });
  const names = (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("link_"));
  for (const n of ["link_join", "link_state", "link_move", "link_leave", "link_leaderboard", "link_practice"]) assert.ok(names.includes(n), n);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]!.text;
    await flush();
    if (!text.startsWith("{")) throw new Error(`${name}: ${text}`);
    return { isError: Boolean(res.isError), body: JSON.parse(text), text };
  };
  const texts: string[] = [];
  let v = await call("link_join", { fallback: "strongest", opponent: "house" });
  assert.equal(v.isError, false, v.text);
  assert.equal(v.body.opponent.house, true);
  assert.match(v.body.watch_url, /\/link\/match\/[a-z2-9]{10}$/);
  assert.match(v.body.next_step, /link_move/);
  for (let i = 0; i < 10 && !v.body.ended; i++) {
    const moved = await call("link_move", { action: { kind: "move", slot: 0 }, turn: v.body.turn, line: i === 0 ? "good luck" : undefined });
    assert.equal(moved.isError, false, moved.text);
    texts.push(moved.text);
    v = await call("link_state", { wait: false });
    assert.equal(v.isError, false, v.text);
    texts.push(v.text);
  }
  assert.ok(v.body.ended, "played to the end");
  assert.match(v.body.next_step, /over/);
  // A retried decision for a turn already played is refused, never played twice.
  const stale = await call("link_move", { action: { kind: "move", slot: 0 }, turn: 0 });
  assert.equal(stale.isError, true);
  for (const t of [...texts, v.text]) assert.ok(!t.includes(token), "the token never appears in a result");
  const board = await call("link_leaderboard", {});
  assert.equal(board.body.fighters[0].record.house.draw + board.body.fighters[0].record.house.win + board.body.fighters[0].record.house.loss, 1);
});
