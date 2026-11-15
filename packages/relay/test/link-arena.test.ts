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
  return { r, engine, flush, a, b };
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

test("a battle played out is rated once, both fighters freed, and its screens shown only then", async () => {
  const s = await setup();
  const match = await pair(s);
  const sideOf = async (token: string) => ((await s.r.call("GET", `/api/link/state?match=${match}`, undefined, token)).body.view.only_for === "side 0" ? 0 : 1);
  const winner = (await sideOf(s.a)) === 0 ? s.a : s.b;
  assert.equal(await s.r.relay.linkArena!.filmsVisible(match), false, "a rated battle's screens wait for its end");
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
  // Free again: a new join queues.
  assert.equal((await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a)).body.waiting, true);
});

test("an empty bank takes the fallback at once, every turn after", async () => {
  const s = await setup({ bankMs: 5_000 });
  const match = await pair(s);
  await s.r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, s.a);
  s.r.clock.advance(6_000);
  // Any read plays the clock forward: the silent side's fallback goes in and the turn resolves.
  await s.r.call("GET", `/api/link/match/${match}`);
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
  const again = await pair(s);
  assert.deepEqual((await s.r.call("POST", "/api/link/leave", {}, s.a)).body, { left: true });
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
  for (let t = 0; t < 2; t++) {
    s.r.clock.advance(50_000);
    await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a);
  }
  s.r.clock.advance(25_000);
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
