import { test } from "node:test";
import assert from "node:assert/strict";
import { RelayError } from "../src/errors.ts";
import type { LinkAction } from "../src/link/referee.ts";
import { FakeLinkEngine, MINT, MINT2, OTHER, rig } from "./fakes.ts";

// Rated link battles' referee (docs/link-battles.md 4.2, 6, 8.2, 9) with a fake engine: no emulator, a battle where each
// side has three hits in it. Under test: pairing, decisions held and never served, resolution after the answer, the
// clocks and their fallbacks, forfeits and voids, ratings, the house, and what the public page may show.

const HIT: LinkAction = { kind: "move", slot: 0 };
const WAIT: LinkAction = { kind: "move", slot: 1 };

async function setup(arena = {}) {
  const engine = new FakeLinkEngine();
  const tasks: (() => Promise<unknown>)[] = [];
  const r = rig(undefined, { engine, rated: true, defer: (t) => tasks.push(t), arena });
  /** Runs what the host would after its responses (resolutions, films), until nothing's left. */
  const flush = async () => {
    while (tasks.length) await tasks.shift()!();
  };
  const a = await r.register(MINT);
  const b = await r.register(MINT2, OTHER);
  return { r, engine, flush, a, b, tasks };
}

/** Pairs the two fighters: the first queues, the second finds it. */
async function pair(s: Awaited<ReturnType<typeof setup>>) {
  const first = await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a);
  assert.equal(first.body.waiting, true);
  const second = await s.r.call("POST", "/api/link/join", { fallback: "strongest", wait: false }, s.b);
  assert.equal(second.status, 200, second.text);
  const match = second.body.match as string;
  assert.match(match, /^[a-z2-9]{10}$/);
  const mine = await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a);
  assert.equal(mine.body.match, match, "the first finds the battle it was paired into");
  return match;
}

test("rated play is off without the switch, and without an engine that plays it", async () => {
  const r = rig(undefined, { engine: new FakeLinkEngine() });
  const t = await r.register();
  assert.equal((await r.call("POST", "/api/link/join", { fallback: "first" }, t)).status, 404);
});

test("two agents are paired, decide, and a turn resolves only once both are in, after the answer", async () => {
  const s = await setup();
  const match = await pair(s);
  const spectate = async () => (await s.r.call("GET", `/api/link/match/${match}`)).text;
  const aSide = (await s.r.call("GET", `/api/link/state?match=${match}`, undefined, s.a)).body.view.only_for as string;
  // Time passes before A decides, so a clock that stopped at A's decision would show.
  s.r.clock.advance(7_000);
  const before = await spectate();
  s.r.clock.advance(3_000);
  const moved = await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT, line: "here goes" }, s.a);
  assert.equal(moved.status, 200, moved.text);
  assert.equal(moved.body.status, "waiting");
  // Nothing about a pending decision is served: not to the other side, not to spectators, not even that it arrived.
  const theirs = await s.r.call("GET", `/api/link/state?match=${match}`, undefined, s.b);
  assert.equal(theirs.body.status, "your_decision");
  assert.ok(!theirs.text.includes("here goes") && !theirs.text.includes(aSide), "neither A's line nor A's view");
  assert.equal(await spectate(), before, "the public page is the same before and after one side decides, clocks included");
  s.r.clock.advance(5_000);
  assert.equal(await spectate(), before, "and stays so while the other side thinks");
  assert.equal(s.engine.resolves, 0);
  await s.r.call("POST", "/api/link/move", { match, turn: 0, action: WAIT }, s.b);
  assert.equal(s.engine.resolves, 0, "the turn runs after the answer, not in it");
  await s.flush();
  assert.equal(s.engine.resolves, 1);
  const after = await s.r.call("GET", `/api/link/state?match=${match}`, undefined, s.b);
  assert.equal(after.body.turn, 1);
  assert.equal(after.body.view.you.hp, 2);
  assert.deepEqual(after.body.their_lines, [{ turn: 1, line: "here goes" }], "the opponent's line once its turn has resolved");
  assert.match((await spectate()), /here goes/);
  assert.ok(s.engine.films.length >= 2, "the opening and each turn are filmed after the answer");
  // A stale turn and an action not in the view are refused, never played.
  assert.equal((await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, s.a)).status, 409);
  assert.equal((await s.r.call("POST", "/api/link/move", { match, turn: 1, action: { kind: "switch", to: 2 } }, s.a)).status, 400);
  assert.equal((await s.r.call("GET", `/api/link/state?match=${match}`, undefined, s.a)).body.view.only_for, aSide, "each side gets its own view, every turn");
});

test("a battle played out is rated once, both fighters freed, and its screens public as it's played", async () => {
  const s = await setup();
  const match = await pair(s);
  const sideOf = async (token: string) => ((await s.r.call("GET", `/api/link/state?match=${match}`, undefined, token)).body.view.only_for === "side 0" ? 0 : 1);
  const winner = (await sideOf(s.a)) === 0 ? s.a : s.b;
  assert.equal(await s.r.relay.linkArena!.filmsVisible(match), true, "a rated battle's screens are public while it's on");
  assert.equal(await s.r.relay.linkArena!.filmsVisible("aaaaaaaaaa"), null, "not a rated battle");
  for (let turn = 0; turn < 3; turn++) {
    await s.r.call("POST", "/api/link/move", { match, turn, action: HIT }, winner);
    await s.r.call("POST", "/api/link/move", { match, turn, action: WAIT }, winner === s.a ? s.b : s.a);
    await s.flush();
  }
  const end = await s.r.call("GET", `/api/link/state?match=${match}`, undefined, winner);
  assert.equal(end.body.status, "ended");
  assert.equal(end.body.ended.result, "won");
  assert.equal(await s.r.relay.linkArena!.filmsVisible(match), true);
  const board = (await s.r.call("GET", "/api/link/leaderboard")).body;
  const rows = Object.fromEntries(board.fighters.map((f: { fighter: string }) => [f.fighter, f]));
  const w = rows[winner === s.a ? MINT : MINT2], l = rows[winner === s.a ? MINT2 : MINT];
  assert.deepEqual([w.record.rated.win, l.record.rated.loss], [1, 1]);
  assert.ok(w.rating > 1500 && l.rating < 1500, "rated against each other");
  const lobby = (await s.r.call("GET", "/api/link/matches")).body;
  assert.equal(lobby.recent[0].match, match);
  assert.equal(lobby.live.length, 0);
  // Each fighter's page: its record there and the battle.
  const page = await s.r.relay.linkArena!.fighter(winner === s.a ? MINT : MINT2);
  assert.deepEqual([page!.record.rated.win, page!.battles[0]!.match], [1, match]);
  assert.equal(await s.r.relay.linkArena!.fighter("never-played"), null);
  // Free again: a new join queues.
  assert.equal((await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a)).body.waiting, true);
});

test("an empty bank takes the fallback at once, every turn after", async () => {
  const s = await setup({ bankMs: 5_000 });
  const match = await pair(s);
  await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, s.a);
  // The public page doesn't move the battle on (it never writes); the sweep does: the fallback goes in, the turn resolves.
  s.r.clock.advance(6_000);
  assert.equal((await s.r.call("GET", `/api/link/match/${match}`)).body.turn, 0);
  await s.r.advance(1_000);
  await s.flush();
  const v = await s.r.call("GET", `/api/link/state?match=${match}`, undefined, s.b);
  assert.equal(v.body.turn, 1, "resolved with the fallback");
  assert.equal(v.body.clock_seconds, 0);
  assert.equal(v.body.status, "waiting", "with an empty bank, its fallback is in as soon as the turn opens");
});

test("a side asked and silent for two minutes forfeits, and a forfeit before turn 3 isn't rated", async () => {
  const s = await setup();
  const match = await pair(s);
  await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, s.a);
  await s.r.advance(125_000);
  const end = await s.r.call("GET", `/api/link/state?match=${match}`, undefined, s.a);
  assert.equal(end.body.status, "ended");
  assert.equal(end.body.ended.result, "won");
  const rows = (await s.r.call("GET", "/api/link/leaderboard")).body.fighters;
  assert.ok(rows.every((f: { rating: number }) => f.rating === 1500), "no rating moved");
});

test("both sides silent is a void; leaving is a forfeit", async () => {
  const s = await setup();
  const match = await pair(s);
  await s.r.advance(125_000);
  const v = (await s.r.call("GET", `/api/link/match/${match}`)).body;
  assert.equal(v.ended.reason, "void");
  // Both went silent, so both wait out the cooldown before joining again.
  await s.r.advance(300_000);
  const again = await pair(s);
  assert.deepEqual((await s.r.call("POST", "/api/link/leave", {}, s.a)).body, { left: true, from: "battle" });
  const e = (await s.r.call("GET", `/api/link/match/${again}`)).body.ended;
  assert.equal(e.reason, "forfeit");
});

test("the house plays at once when asked for, decides as the turn opens, and never moves the agent's rating", async () => {
  const s = await setup();
  const j = await s.r.call("POST", "/api/link/join", { fallback: "random", opponent: "house" }, s.a);
  assert.equal(j.status, 200, j.text);
  assert.equal(j.body.opponent.house, true);
  assert.equal(j.body.rated, false);
  for (let turn = 0; turn < 3; turn++) {
    await s.r.call("POST", "/api/link/move", { match: j.body.match, turn, action: HIT }, s.a);
    await s.flush();
  }
  const end = await s.r.call("GET", `/api/link/state?match=${j.body.match}`, undefined, s.a);
  assert.equal(end.body.status, "ended");
  assert.equal(end.body.ended.result, "draw", "both hit every turn");
  const me = (await s.r.call("GET", "/api/link/leaderboard")).body.fighters.find((f: { fighter: string }) => f.fighter === MINT);
  assert.equal(me.rating, 1500);
  assert.equal(me.record.house.draw, 1);
});

test("two fighters of one owner are never paired; unpaired for two minutes, the house plays", async () => {
  const s = await setup({ houseAfterMs: 120_000 });
  const same = await s.r.register(MINT2);
  await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a);
  assert.equal((await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, same)).body.waiting, true);
  // A queued fighter keeps its place by calling again within a minute.
  for (let t = 0; t < 3; t++) {
    s.r.clock.advance(40_000);
    await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a);
  }
  s.r.clock.advance(5_000);
  const late = await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a);
  assert.equal(late.body.opponent?.house, true, "after two minutes, the house");
});

test("a resolution that died is run again by the sweep", async () => {
  const s = await setup();
  const match = await pair(s);
  s.engine.failOnce = new Error("the function died");
  await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, s.a);
  await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, s.b);
  await s.flush();
  assert.equal((await s.r.call("GET", `/api/link/match/${match}`)).body.turn, 0, "nothing was kept");
  await s.r.advance(180_000);
  await s.flush();
  assert.equal((await s.r.call("GET", `/api/link/match/${match}`)).body.turn, 1, "the sweep ran it again");
  // A rig that changed under the battle voids it.
  s.engine.failOnce = new RelayError("expired", "another version of the rig");
  await s.r.call("POST", "/api/link/move", { match, turn: 1, action: HIT }, s.a);
  await s.r.call("POST", "/api/link/move", { match, turn: 1, action: HIT }, s.b);
  await s.flush();
  assert.equal((await s.r.call("GET", `/api/link/match/${match}`)).body.ended.reason, "void");
});

test("an outage of the store stops the clocks: nobody forfeits time it couldn't play", async () => {
  const s = await setup();
  const match = await pair(s);
  await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, s.a);
  await s.r.advance(60_000);
  // The store goes down for three minutes: B, asked and silent, can't be reached either.
  s.r.store.down = true;
  s.r.clock.advance(180_000);
  s.r.store.down = false;
  const back = (await s.r.call("GET", `/api/link/match/${match}`)).body;
  assert.equal(back.live, true, "a minute of silence outside the outage is not two");
  await s.r.advance(70_000);
  const end = (await s.r.call("GET", `/api/link/match/${match}`)).body;
  assert.equal(end.ended?.reason, "forfeit", "once two minutes of it are outside the outage, it is");
});

// ---------------------------------------------------------------- the adversarial review's findings (2026-11-15)

/** A gate the test opens when it's ready. */
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

test("a poll during a resolution doesn't lose the turn, nor does any write that leaves the turn alone", async () => {
  const s = await setup();
  const match = await pair(s);
  await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, s.a);
  s.r.clock.advance(11_000);
  await s.r.call("POST", "/api/link/move", { match, turn: 0, action: WAIT }, s.b);
  const g = gate();
  s.engine.gateResolve = g.p;
  const running = s.tasks.shift()!();
  await new Promise((r) => setTimeout(r, 10));
  // A, who decided 11 seconds ago, polls while the turn is played; and something else writes the document meanwhile.
  await s.r.call("GET", `/api/link/state?match=${match}`, undefined, s.a);
  const d = (await s.r.store.get<any>(`link:match:${match}`))!;
  await s.r.store.cas(`link:match:${match}`, d.version, { ...d.value, updatedAt: d.value.updatedAt + 1 });
  s.engine.gateResolve = null;
  g.open();
  await running;
  await s.flush();
  assert.equal((await s.r.call("GET", `/api/link/match/${match}`)).body.turn, 1, "the turn played is kept");
  assert.equal(s.engine.resolves, 1, "once");
});

test("a fighter is never in two battles: it's claimed before a battle is made, and waits while it is", async () => {
  const s = await setup();
  const MINT3 = "Cn8eVZaH5DWrRVHzbWZ4Eh4E9HFeuF2RwN4sx1ZSH8Fx";
  s.r.coins.coins.set(MINT3, { ...s.r.coins.coins.get(MINT)!, name: "Third", ticker: "TRI" });
  const c = await s.r.register(MINT3, "6nB5vWUTMBe2aQRrYzWvBrcHm8DKFxkUUXr5oULHXqX1");
  await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a);
  const g = gate();
  s.engine.gateStart = g.p;
  const bJoin = s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.b);
  await new Promise((r) => setTimeout(r, 10));
  // While B's battle with A is being made: A polls, then C joins. A must not be queued again, nor paired with C.
  const a2 = await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a);
  assert.equal(a2.body.waiting, true);
  assert.equal(a2.body.pairing, true, "A is told its battle is being made");
  const cJoin = await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, c);
  assert.equal(cJoin.body.waiting, true, "C finds nobody: A is claimed");
  s.engine.gateStart = null;
  g.open();
  const b = await bJoin;
  assert.match(b.body.match, /^[a-z2-9]{10}$/);
  const a3 = await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a);
  assert.equal(a3.body.match, b.body.match, "A is in B's battle, and only that one");
  assert.equal((await s.r.call("GET", "/api/link/matches")).body.live.length, 1);
});

test("a turn the rig keeps failing on voids the battle and frees both fighters", async () => {
  const s = await setup();
  const match = await pair(s);
  s.engine.failAlways = new Error("boom");
  const quiet = console.error;
  console.error = () => {};
  try {
    await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, s.a);
    await s.r.call("POST", "/api/link/move", { match, turn: 0, action: WAIT }, s.b);
    await s.flush();
    for (let i = 0; i < 15; i++) {
      await s.r.advance(60_000);
      await s.flush();
    }
  } finally {
    console.error = quiet;
  }
  const v = (await s.r.call("GET", `/api/link/match/${match}`)).body;
  assert.equal(v.ended?.reason, "void");
  assert.ok(s.engine.resolves <= 4, `tried ${s.engine.resolves} times`);
  s.engine.failAlways = null;
  assert.equal((await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a)).body.waiting, true, "free to join again");
});

test("an action is the same however its keys are ordered, and a resent decision never says whether the other side's is in", async () => {
  const s = await setup();
  const match = await pair(s);
  const ok = await s.r.call("POST", "/api/link/move", { match, turn: 0, action: { slot: 0, kind: "move" } }, s.a);
  assert.equal(ok.status, 200, ok.text);
  const before = (await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, s.a)).body.error;
  await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, s.b);
  const after = (await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, s.a)).body.error;
  assert.equal(before, after);
});

test("leaving the queue leaves it; a fighter that went silent waits to join again; an early forfeit isn't counted as rated", async () => {
  const s = await setup();
  await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a);
  assert.deepEqual((await s.r.call("POST", "/api/link/leave", {}, s.a)).body, { left: true, from: "queue" });
  assert.equal((await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.b)).body.waiting, true, "B finds nobody: A left");
  await s.r.call("POST", "/api/link/leave", {}, s.b);
  const match = await pair(s);
  await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, s.a);
  await s.r.advance(125_000);
  const silent = (await s.r.call("GET", `/api/link/match/${match}`)).body.ended;
  assert.equal(silent.reason, "forfeit");
  const loser = silent.winner === 0 ? 1 : 0;
  const ids = (await s.r.call("GET", `/api/link/match/${match}`)).body.sides.map((x: { fighter: string }) => x.fighter);
  const loserToken = ids[loser] === MINT ? s.a : s.b;
  const again = await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, loserToken);
  assert.equal(again.status, 429);
  assert.match(again.body.error, /stopped answering/);
  const rows = (await s.r.call("GET", "/api/link/leaderboard")).body.fighters;
  for (const f of rows) {
    assert.equal(f.record.rated.win + f.record.rated.loss, 0, "a forfeit before turn 3 isn't a rated result");
    assert.equal(f.record.unrated.win + f.record.unrated.loss, 1);
  }
});

test("a join that finds its battle counts as answering", async () => {
  const s = await setup();
  await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a);
  const b = await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.b);
  await s.r.call("POST", "/api/link/move", { match: b.body.match, turn: 0, action: HIT }, s.b);
  s.r.clock.advance(40_000);
  // A comes back within the minute it was told, finds its battle, and thinks for 100 seconds.
  assert.equal((await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a)).body.match, b.body.match);
  await s.r.advance(100_000);
  assert.equal((await s.r.call("GET", `/api/link/match/${b.body.match}`)).body.live, true);
});

test("link_state waits for the next turn by default, and practice waits for a rated battle", async () => {
  const s = await setup();
  const match = await pair(s);
  await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, s.a);
  const t0 = s.r.clock.now();
  const v = await s.r.call("GET", "/api/link/state?wait=1", undefined, s.a);
  assert.equal(v.body.status, "waiting");
  assert.ok(s.r.clock.now() - t0 >= 40_000, "it held for the long-poll, not answering at once");
  const p = await s.r.call("POST", "/api/link/practice", {}, s.a);
  assert.equal(p.status, 409);
});

test("a rated battle settled records each side's rating change; the house's battles are capped", async () => {
  const s = await setup({ maxHouse: 1 });
  const match = await pair(s);
  for (let turn = 0; turn < 3; turn++) {
    await s.r.call("POST", "/api/link/move", { match, turn, action: HIT }, s.a);
    await s.r.call("POST", "/api/link/move", { match, turn, action: WAIT }, s.b);
    await s.flush();
  }
  const page = (await s.r.call("GET", `/api/link/match/${match}`)).body;
  const changes = page.sides.map((x: { rating_change: number }) => x.rating_change);
  assert.ok(changes[0] !== null && changes[1] !== null && changes[0] === -changes[1], JSON.stringify(changes));
  const mine = (await s.r.call("GET", `/api/link/state?match=${match}`, undefined, s.a)).body.ended.rating_change;
  assert.equal(typeof mine, "number");
  assert.equal((await s.r.call("POST", "/api/link/join", { fallback: "first", opponent: "house" }, s.a)).status, 200);
  assert.equal((await s.r.call("POST", "/api/link/join", { fallback: "first", opponent: "house" }, s.b)).status, 429);
});

// ---------------------------------------------------------------- found live, on the first rated battle (2026-11-15)

test("a write that lands as a resolution starts doesn't strand the turn until the sweep", async () => {
  const s = await setup();
  const match = await pair(s);
  const key = `link:match:${match}`;
  await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, s.a);
  await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, s.b);
  // As the resolver counts its attempt, something else writes the document (a fighter's poll noting it's there).
  const cas = s.r.store.cas.bind(s.r.store);
  let bumped = false;
  s.r.store.cas = (async (k: string, version: number, value: any, ttl?: number) => {
    if (k === key && !bumped && value?.attempts === 1) {
      bumped = true;
      const d = (await s.r.store.get<any>(key))!;
      await cas(key, d.version, { ...d.value, updatedAt: d.value.updatedAt + 1 });
    }
    return cas(k, version, value, ttl);
  }) as typeof s.r.store.cas;
  await s.flush();
  assert.equal(bumped, true, "the write raced the resolver");
  assert.equal((await s.r.call("GET", `/api/link/match/${match}`)).body.turn, 1, "the turn played without waiting for the sweep");
  assert.equal(s.engine.resolves, 1, "once");
});

test("a next turn completed while the last resolution still holds its lock is played as the lock is let go", async () => {
  const s = await setup();
  const match = await pair(s);
  await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, s.a);
  await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, s.b);
  // Turn 0 is public once committed, before its resolver lets go of the lock: two quick agents decide turn 1 right then,
  // and the resolution their decisions start finds the lock held.
  const del = s.r.store.del.bind(s.r.store);
  let raced = false;
  s.r.store.del = (async (k: string) => {
    if (!raced && k.startsWith("link:mstate:")) {
      raced = true;
      await s.r.call("POST", "/api/link/move", { match, turn: 1, action: HIT }, s.a);
      await s.r.call("POST", "/api/link/move", { match, turn: 1, action: HIT }, s.b);
      while (s.tasks.length) await s.tasks.shift()!();
      assert.equal(s.engine.resolves, 1, "the lock was held: turn 1 wasn't played yet");
    }
    return del(k);
  }) as typeof s.r.store.del;
  await s.flush();
  assert.equal(raced, true);
  assert.equal((await s.r.call("GET", `/api/link/match/${match}`)).body.turn, 2, "turn 1 played without waiting for the sweep");
  assert.equal(s.engine.resolves, 2);
});
