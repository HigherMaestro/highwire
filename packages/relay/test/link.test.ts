import { test } from "node:test";
import assert from "node:assert/strict";
import { RelayError } from "../src/errors.ts";
import type { LinkAction, LinkEngine, LinkStep } from "../src/link/referee.ts";
import { MINT2, OTHER, rig } from "./fakes.ts";

// Link battles' practice referee (docs/link-battles.md 6, 8.3) with a fake engine: no emulator, just a battle the house
// loses in three hits. What's under test is the referee: tokens, one practice a fighter, the global cap, the lock on a
// battle, expiry, the store keys, and that the public page gets the spectators' view, never the agent's.

type FakeState = { turn: number; houseHp: number };

class FakeEngine implements LinkEngine {
  format = "colosseum-1";
  version = "v1";
  calls = 0;
  /** When set, move() waits for it: to hold a turn open while another call arrives. */
  hold: Promise<void> | null = null;
  async rules() {
    return { format: this.format };
  }
  private step(s: FakeState): LinkStep {
    const over = s.houseHp <= 0;
    return {
      state: s,
      packed: over ? null : new TextEncoder().encode(JSON.stringify(s)),
      view: { phase: over ? "ended" : "choose", turn: s.turn, them: { hp_percent: Math.round((s.houseHp / 3) * 100) }, secret_agent_only: true },
      spectator: { turn: s.turn, house_hp_percent: Math.round((s.houseHp / 3) * 100) },
      turn: s.turn,
      ended: over ? { reason: "knockout", winner: "you" } : null,
      format: this.format,
      version: this.version,
    };
  }
  async start() {
    this.calls++;
    return this.step({ turn: 0, houseHp: 3 });
  }
  async move(state: unknown, packed: Uint8Array, _agent: 0 | 1, action: LinkAction) {
    this.calls++;
    if (this.hold) await this.hold;
    if (this.version !== "v1") throw new RelayError("expired", "another version of the rig");
    const s = JSON.parse(new TextDecoder().decode(packed)) as FakeState;
    assert.deepEqual(s, state, "the packed battle and the document agree");
    if (action.kind === "switch") throw new RelayError("bad_request", "That action isn't one of the legal actions in your view.");
    return this.step({ turn: s.turn + 1, houseHp: s.houseHp - 1 });
  }
}

async function setup(config: Partial<{ maxPractices: number; practiceMs: number }> = {}) {
  const engine = new FakeEngine();
  const r = rig(undefined, { engine, ...config });
  const token = await r.register();
  return { r, engine, token };
}

const hit: LinkAction = { kind: "move", slot: 0 };

test("without an engine the link routes don't exist", async () => {
  const r = rig();
  assert.equal((await r.call("GET", "/api/link/rules")).status, 404);
});

test("a fighter practises against the house to the end, and the store keeps no battle once it's over", async () => {
  const { r, token } = await setup();
  assert.equal((await r.call("GET", "/api/link/rules")).body.format, "colosseum-1");
  assert.equal((await r.call("POST", "/api/link/practice")).status, 401, "practice needs the arena token");
  const start = await r.call("POST", "/api/link/practice", {}, token);
  assert.equal(start.status, 200, start.text);
  const match = start.body.match;
  assert.match(match, /^[a-z2-9]{10}$/);
  assert.equal(start.body.watch_path, `/link/practice/${match}`);
  assert.equal((await r.call("POST", "/api/link/practice", {}, token)).body.match, match, "one practice at a time: the same one comes back");
  let v = start.body;
  while (!v.ended) {
    const res = await r.call("POST", "/api/link/practice/move", { match, action: hit, line: "here goes" }, token);
    assert.equal(res.status, 200, res.text);
    v = res.body;
  }
  assert.deepEqual(v.ended, { reason: "knockout", winner: "you" });
  assert.equal(v.turn, 3);
  const keys = Object.keys(r.store.dump());
  assert.deepEqual(keys.filter((k) => k.startsWith("link:state:")), [], "no packed battle is kept after the end");
  assert.ok(!keys.some((k) => k.startsWith("link:lock:")), "no lock left behind");
  const next = await r.call("POST", "/api/link/practice", {}, token);
  assert.notEqual(next.body.match, match, "a new one starts once it's over");
});

test("an illegal action is refused and changes nothing; a malformed one never reaches the engine", async () => {
  const { r, engine, token } = await setup();
  const { match } = (await r.call("POST", "/api/link/practice", {}, token)).body;
  const bad = await r.call("POST", "/api/link/practice/move", { match, action: { kind: "switch", to: 2 } }, token);
  assert.equal(bad.status, 400);
  assert.equal((await r.call("GET", `/api/link/practice/state?match=${match}`, undefined, token)).body.turn, 0);
  const calls = engine.calls;
  for (const action of [{ kind: "move", slot: 4 }, { kind: "item" }, null, { kind: "switch", to: -1 }]) {
    assert.equal((await r.call("POST", "/api/link/practice/move", { match, action }, token)).status, 400, JSON.stringify(action));
  }
  assert.equal(engine.calls, calls);
  assert.equal((await r.call("POST", "/api/link/practice/move", { match, action: hit, line: "see https://example.com" }, token)).status, 400, "table talk keeps The Line's rules");
});

test("another fighter can't play or read someone else's practice", async () => {
  const { r, token } = await setup();
  const other = await r.register(MINT2, OTHER);
  const { match } = (await r.call("POST", "/api/link/practice", {}, token)).body;
  assert.equal((await r.call("POST", "/api/link/practice/move", { match, action: hit }, other)).status, 404);
  assert.equal((await r.call("GET", `/api/link/practice/state?match=${match}`, undefined, other)).status, 404);
});

test("a second move while a turn resolves is refused, not played twice", async () => {
  const { r, engine, token } = await setup();
  const { match } = (await r.call("POST", "/api/link/practice", {}, token)).body;
  let release!: () => void;
  engine.hold = new Promise<void>((resolve) => (release = resolve));
  const first = r.call("POST", "/api/link/practice/move", { match, action: hit }, token);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await r.call("POST", "/api/link/practice/move", { match, action: hit }, token);
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).body.turn, 1);
});

test("a practice expires an hour after its last move", async () => {
  const { r, token } = await setup();
  const { match } = (await r.call("POST", "/api/link/practice", {}, token)).body;
  r.clock.advance(3_600_001);
  assert.equal((await r.call("POST", "/api/link/practice/move", { match, action: hit }, token)).status, 410);
});

test("a battle from another version of the rig can't continue", async () => {
  const { r, engine, token } = await setup();
  const { match } = (await r.call("POST", "/api/link/practice", {}, token)).body;
  engine.version = "v2";
  assert.equal((await r.call("POST", "/api/link/practice/move", { match, action: hit }, token)).status, 410);
});

test("practices running at once are capped across fighters, and leaving frees the place", async () => {
  const { r, token } = await setup({ maxPractices: 1 });
  const other = await r.register(MINT2, OTHER);
  assert.equal((await r.call("POST", "/api/link/practice", {}, token)).status, 200);
  assert.equal((await r.call("POST", "/api/link/practice", {}, other)).status, 429);
  assert.deepEqual((await r.call("POST", "/api/link/practice/leave", {}, token)).body, { left: true });
  assert.equal((await r.call("POST", "/api/link/practice", {}, other)).status, 200);
});

test("the public page gets the spectators' view, never the agent's", async () => {
  const { r, token } = await setup();
  const { match } = (await r.call("POST", "/api/link/practice", {}, token)).body;
  await r.call("POST", "/api/link/practice/move", { match, action: hit, line: "steady" }, token);
  const page = await r.call("GET", `/api/link/practice/${match}`);
  assert.equal(page.status, 200);
  assert.equal(page.body.spectator.turn, 1);
  assert.deepEqual(page.body.lines, [{ turn: 1, line: "steady" }]);
  assert.doesNotMatch(page.text, /secret_agent_only|tokenHash/);
  assert.equal((await r.call("GET", "/api/link/practice/zzzzzzzzzz")).status, 404);
});
