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
  /** When set, start() and move() wait for it: to hold a step open while another call arrives. */
  hold: Promise<void> | null = null;
  /** When set, move() throws this, as the real engine does for a battle saved by another version of the rig. */
  failWith: RelayError | null = null;
  /** The phase the next views show ("waiting": the agent isn't asked, and continues with no action). */
  phase = "choose";
  async rules() {
    return { format: this.format };
  }
  private step(s: FakeState): LinkStep {
    const over = s.houseHp <= 0;
    return {
      state: s,
      packed: over ? null : new TextEncoder().encode(JSON.stringify(s)),
      view: { phase: over ? "ended" : this.phase, turn: s.turn, them: { hp_percent: Math.round((s.houseHp / 3) * 100) }, secret_agent_only: true },
      spectator: { turn: s.turn, house_hp_percent: Math.round((s.houseHp / 3) * 100) },
      turn: s.turn,
      ended: over ? { reason: "knockout", winner: "you" } : null,
      format: this.format,
      version: this.version,
      film: { turns: [s.turn] },
    };
  }
  /** What film() was asked for, in order. */
  films: { match: string; film: unknown }[] = [];
  filmFails = false;
  async film(match: string, film: unknown) {
    if (this.filmFails) throw new Error("the film broke");
    this.films.push({ match, film });
  }
  async start() {
    this.calls++;
    if (this.hold) await this.hold;
    return this.step({ turn: 0, houseHp: 3 });
  }
  async move(state: unknown, packed: Uint8Array, _agent: 0 | 1, action: LinkAction | null) {
    this.calls++;
    if (this.hold) await this.hold;
    if (this.failWith) throw this.failWith;
    if (this.version !== "v1") throw new RelayError("expired", "another version of the rig");
    const s = JSON.parse(new TextDecoder().decode(packed)) as FakeState;
    assert.deepEqual(s, state, "the packed battle and the document agree");
    if (action?.kind === "switch") throw new RelayError("bad_request", "That action isn't one of the legal actions in your view.");
    return this.step({ turn: s.turn + 1, houseHp: s.houseHp - (action ? 1 : 0) });
  }
}

async function setup(config: Partial<{ maxPractices: number; practiceMs: number; defer: (task: () => Promise<unknown>) => void }> = {}) {
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
    const res = await r.call("POST", "/api/link/practice/move", { match, turn: v.turn, action: hit, line: "here goes" }, token);
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
  const bad = await r.call("POST", "/api/link/practice/move", { match, turn: 0, action: { kind: "switch", to: 2 } }, token);
  assert.equal(bad.status, 400);
  assert.equal((await r.call("GET", `/api/link/practice/state?match=${match}`, undefined, token)).body.turn, 0);
  const calls = engine.calls;
  for (const action of [{ kind: "move", slot: 4 }, { kind: "item" }, null, { kind: "switch", to: -1 }]) {
    assert.equal((await r.call("POST", "/api/link/practice/move", { match, turn: 0, action }, token)).status, 400, JSON.stringify(action));
  }
  assert.equal(engine.calls, calls);
  assert.equal((await r.call("POST", "/api/link/practice/move", { match, turn: 0, action: hit, line: "see https://example.com" }, token)).status, 400, "table talk keeps The Line's rules");
});

test("another fighter can't play or read someone else's practice", async () => {
  const { r, token } = await setup();
  const other = await r.register(MINT2, OTHER);
  const { match } = (await r.call("POST", "/api/link/practice", {}, token)).body;
  assert.equal((await r.call("POST", "/api/link/practice/move", { match, turn: 0, action: hit }, other)).status, 404);
  assert.equal((await r.call("GET", `/api/link/practice/state?match=${match}`, undefined, other)).status, 404);
});

test("a second move while a turn resolves is refused, not played twice", async () => {
  const { r, engine, token } = await setup();
  const { match } = (await r.call("POST", "/api/link/practice", {}, token)).body;
  let release!: () => void;
  engine.hold = new Promise<void>((resolve) => (release = resolve));
  const first = r.call("POST", "/api/link/practice/move", { match, turn: 0, action: hit }, token);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await r.call("POST", "/api/link/practice/move", { match, turn: 0, action: hit }, token);
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).body.turn, 1);
});

test("a practice expires an hour after its last move", async () => {
  const { r, token } = await setup();
  const { match } = (await r.call("POST", "/api/link/practice", {}, token)).body;
  r.clock.advance(3_600_001);
  assert.equal((await r.call("POST", "/api/link/practice/move", { match, turn: 0, action: hit }, token)).status, 410);
});

test("a battle that can't go on (the rig was updated under it) ends, frees its place, and a new one can start", async () => {
  const { r, engine, token } = await setup({ maxPractices: 1 });
  const { match } = (await r.call("POST", "/api/link/practice", {}, token)).body;
  engine.version = "v2";
  assert.equal((await r.call("POST", "/api/link/practice/move", { match, turn: 0, action: hit }, token)).status, 410);
  const page = await r.call("GET", `/api/link/practice/${match}`);
  assert.equal(page.body.ended.reason, "void");
  assert.equal(page.body.spectator.live, false);
  engine.version = "v1";
  const next = await r.call("POST", "/api/link/practice", {}, token);
  assert.equal(next.status, 200, "its place in the cap was freed");
  assert.notEqual(next.body.match, match);
});

test("a retried move for a turn already played is refused, never played twice", async () => {
  const { r, token } = await setup();
  const { match } = (await r.call("POST", "/api/link/practice", {}, token)).body;
  assert.equal((await r.call("POST", "/api/link/practice/move", { match, turn: 0, action: hit }, token)).body.turn, 1);
  const again = await r.call("POST", "/api/link/practice/move", { match, turn: 0, action: hit }, token);
  assert.equal(again.status, 409);
  assert.equal((await r.call("GET", `/api/link/practice/state?match=${match}`, undefined, token)).body.turn, 1);
  assert.equal((await r.call("POST", "/api/link/practice/move", { match, action: hit }, token)).status, 400, "a move must name its turn");
});

test("two starts at once make one battle, and take one place in the cap", async () => {
  const { r, engine, token } = await setup({ maxPractices: 2 });
  let release!: () => void;
  engine.hold = new Promise<void>((resolve) => (release = resolve));
  const starts = Array.from({ length: 5 }, () => r.call("POST", "/api/link/practice", {}, token));
  await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  engine.hold = null;
  const done = await Promise.all(starts);
  const matches = new Set(done.filter((d) => d.status === 200).map((d) => d.body.match));
  assert.equal(matches.size, 1, done.map((d) => d.status).join(","));
  assert.equal(engine.calls, 1);
  assert.equal((r.store.dump()["link:practices"] as unknown[]).length, 1);
});

test("someone else's match id never holds the lock against its owner", async () => {
  const { r, engine, token } = await setup();
  const other = await r.register(MINT2, OTHER);
  const { match } = (await r.call("POST", "/api/link/practice", {}, token)).body;
  let release!: () => void;
  engine.hold = new Promise<void>((resolve) => (release = resolve));
  const theirs = r.call("POST", "/api/link/practice/move", { match, turn: 0, action: hit }, other);
  const mine = r.call("POST", "/api/link/practice/move", { match, turn: 0, action: hit }, token);
  await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  assert.equal((await theirs).status, 404);
  assert.equal((await mine).status, 200);
});

test("with no action, a battle where the agent isn't asked goes on; otherwise an action is required", async () => {
  const { r, engine, token } = await setup();
  const { match } = (await r.call("POST", "/api/link/practice", {}, token)).body;
  assert.equal((await r.call("POST", "/api/link/practice/move", { match, turn: 0 }, token)).status, 400);
  engine.phase = "waiting";
  const moved = await r.call("POST", "/api/link/practice/move", { match, turn: 0, action: hit }, token);
  assert.equal(moved.body.view.phase, "waiting");
  const went = await r.call("POST", "/api/link/practice/move", { match, turn: 1 }, token);
  assert.equal(went.status, 200, went.text);
  assert.equal(went.body.turn, 2);
});

test("leaving waits for no turn: one resolving now is refused", async () => {
  const { r, engine, token } = await setup();
  const { match } = (await r.call("POST", "/api/link/practice", {}, token)).body;
  let release!: () => void;
  engine.hold = new Promise<void>((resolve) => (release = resolve));
  const move = r.call("POST", "/api/link/practice/move", { match, turn: 0, action: hit }, token);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await r.call("POST", "/api/link/practice/leave", {}, token)).status, 409);
  release();
  assert.equal((await move).status, 200);
  assert.deepEqual((await r.call("POST", "/api/link/practice/leave", {}, token)).body, { left: true });
});

test("a battle abandoned past its hour shows as over to anyone watching", async () => {
  const { r, token } = await setup();
  const { match } = (await r.call("POST", "/api/link/practice", {}, token)).body;
  r.clock.advance(3_600_001);
  const page = await r.call("GET", `/api/link/practice/${match}`);
  assert.deepEqual(page.body.ended, { reason: "void", winner: null, message: "Abandoned." });
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
  await r.call("POST", "/api/link/practice/move", { match, turn: 0, action: hit, line: "steady" }, token);
  const page = await r.call("GET", `/api/link/practice/${match}`);
  assert.equal(page.status, 200);
  assert.equal(page.body.spectator.turn, 1);
  assert.deepEqual(page.body.lines, [{ turn: 1, line: "steady" }]);
  assert.doesNotMatch(page.text, /secret_agent_only|tokenHash/);
  assert.equal((await r.call("GET", "/api/link/practice/zzzzzzzzzz")).status, 404);
});

test("each kept step is filmed after the answer, and never one that wasn't kept", async () => {
  // Deferred tasks are handed over unstarted (filming holds the CPU); the host starts them once the response is out.
  const tasks: (() => Promise<unknown>)[] = [];
  const deferred: Promise<unknown>[] = [];
  const { r, engine, token } = await setup({ defer: (t) => tasks.push(t) });
  const flush = () => {
    for (const t of tasks.splice(0)) deferred.push(t());
    return Promise.all(deferred);
  };
  const { match } = (await r.call("POST", "/api/link/practice", {}, token)).body;
  assert.deepEqual(engine.films, [], "nothing is filmed before the host starts it");
  await r.call("POST", "/api/link/practice/move", { match, turn: 0, action: hit }, token);
  await flush();
  assert.deepEqual(engine.films, [{ match, film: { turns: [0] } }, { match, film: { turns: [1] } }]);
  // A stale turn and an illegal action are refused before anything is kept: nothing more is filmed.
  await r.call("POST", "/api/link/practice/move", { match, turn: 0, action: hit }, token);
  await r.call("POST", "/api/link/practice/move", { match, turn: 1, action: { kind: "switch", to: 1 } }, token);
  await flush();
  assert.equal(engine.films.length, 2);
  // A film that fails is only missing: the battle goes on.
  engine.filmFails = true;
  const next = await r.call("POST", "/api/link/practice/move", { match, turn: 1, action: hit }, token);
  assert.equal(next.status, 200);
  await flush();
  assert.equal(deferred.length, 3);
});

test("without a way to defer, nothing is filmed", async () => {
  const { r, engine, token } = await setup();
  const { match } = (await r.call("POST", "/api/link/practice", {}, token)).body;
  await r.call("POST", "/api/link/practice/move", { match, turn: 0, action: hit }, token);
  assert.deepEqual(engine.films, []);
});
