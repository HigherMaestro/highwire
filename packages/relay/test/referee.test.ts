import { test } from "node:test";
import assert from "node:assert/strict";
import { DUELS_1, houseMove, replay, seedCommitment, startMatch, type Side } from "highwire-core/arena";
import { randomHex } from "../src/registration.ts";
import { commitment, houseNonce, newHouseMatch, settle, applyMove } from "../src/arena/match.ts";
import { viewMatch } from "../src/arena/view.ts";
import type { Match } from "../src/arena/types.ts";
import { MINT, MINT2, OTHER, rig, WALLET, type Rig } from "./fakes.ts";

// The referee (docs/arena.md 4 to 8): a fighter plays the house end to end and checks every reveal, and every rule
// edge the spec lists: conflicting and repeated moves, late moves, the clock and the bank, both sides absent, outages,
// long-polls that wake only on reveals, rate limits, forfeits, results and ratings. And leaks: no response about an
// open round says anything about the other side's move.

const nonce = () => randomHex(16);

/** Plays one round for the fighter; returns the response. */
async function move(r: Rig, token: string, view: any, pull: number, line = "") {
  return r.call("POST", "/api/arena/move", { match: view.id, round: view.round, pull, nonce: nonce(), line }, token);
}

async function setup(opponent?: string) {
  const r = rig();
  const token = await r.register();
  const join = await r.call("POST", "/api/arena/join", { fallback: "steady:2", opponent: opponent ?? "reader" }, token);
  assert.equal(join.status, 200, join.text);
  return { r, token, view: join.body };
}

test("a fighter plays the house to the end, and can check every reveal and the house's seed", async () => {
  const { r, token, view: start } = await setup();
  assert.equal(start.round, 1);
  assert.ok(start.house.seedCommitment.length === 64 && start.house.seed === null, "the seed is committed, not shown");
  assert.equal(start.house.bot, "reader");
  const me: Side = start.you;
  const sent: { round: number; pull: number; nonce: string; line: string }[] = [];
  let view = start;
  while (view.round !== null) {
    const n = nonce();
    const pull = Math.min(3, view.energy[me]);
    const line = view.round === 1 ? "steady as she goes" : "";
    const res = await r.call("POST", "/api/arena/move", { match: view.id, round: view.round, pull, nonce: n, line }, token);
    assert.equal(res.status, 200, res.text);
    sent.push({ round: view.round, pull, nonce: n, line });
    view = res.body;
  }
  assert.ok(view.ending.reason, "it ended");
  // Every one of our moves was recorded as sent, and its commitment checks out.
  for (const s of sent) {
    const rev = view.rounds[s.round - 1][me];
    assert.deepEqual([rev.pull, rev.nonce, rev.line], [s.pull, s.nonce, s.line]);
    assert.equal(rev.commitment, commitment(view.id, s.round, me, s.pull, s.nonce));
  }
  // The seed is out, matches its commitment, and replays every house pull from public state alone.
  const seed = view.house.seed;
  assert.equal(seedCommitment(seed), start.house.seedCommitment);
  const house: Side = view.house.side;
  let s = startMatch(DUELS_1);
  for (const round of view.rounds) {
    assert.equal(round[house].pull, houseMove("reader", s, house, seed), `round ${round.round}`);
    assert.equal(round[house].nonce, houseNonce(seed, round.round));
    s = replay(DUELS_1, view.rounds.slice(0, round.round).map((x: any) => [x.a.pull, x.b.pull]));
  }
  // The result is applied once: the record, a smaller deviation, the same rating, and the fighter is free.
  const f = (await r.call("GET", `/api/arena/fighter/${MINT}`)).body;
  const total = f.record.house.win + f.record.house.draw + f.record.house.loss;
  assert.equal(total, 1);
  assert.equal(f.rating, 1500, "house matches never move the rating");
  assert.equal(f.match, null);
  const board = (await r.call("GET", "/api/arena/leaderboard")).body;
  assert.deepEqual(board.ranked, [], "nobody is ranked from house matches");
  const reader = board.house.find((h: any) => h.bot === "reader");
  assert.equal(reader.record.win + reader.record.draw + reader.record.loss, 1);
  // A spectator sees the same finished match.
  const spec = await r.call("GET", `/api/arena/match/${view.id}`);
  assert.deepEqual(spec.body.rounds, view.rounds);
  assert.equal(spec.body.self, undefined);
});

test("a move is final: the same move again is accepted, a different one is a conflict, a bad one is refused", async () => {
  // The house has moved when a round opens, so our move reveals the round at once and a repeat is late; the pure
  // match below holds a round open to check repeats and conflicts.
  const { r, token, view } = await setup();
  const body = { match: view.id, round: 1, pull: 0, nonce: nonce(), line: "hi" };
  const first = await r.call("POST", "/api/arena/move", body, token);
  assert.equal(first.status, 200);
  const same = await r.call("POST", "/api/arena/move", body, token);
  // Round 1 is already revealed (the house had moved), so a repeat now is late, not a second move.
  assert.equal(same.body.code, "late");
  // On the pure match: a repeat of the same move while the round is open is accepted; a different one isn't.
  const m = twoFighters();
  const input = { round: 1, pull: 3, nonce: "a".repeat(32), line: "" };
  applyMove(m, "a", input, m.createdAt + 1000, []);
  assert.deepEqual(applyMove(m, "a", input, m.createdAt + 2000, []), { repeated: true });
  assert.throws(() => applyMove(m, "a", { ...input, pull: 4 }, m.createdAt + 3000, []), /a move is final/);
  for (const [bad, why] of [[{ ...input, pull: 31 }, /more than the 30/], [{ ...input, pull: -1 }, /negative/], [{ ...input, pull: 1.5 }, /whole number/], [{ ...input, nonce: "xyz" }, /nonce/], [{ ...input, round: 2 }, /round 1, not 2/]] as const) {
    assert.throws(() => applyMove(m, "b", bad as any, m.createdAt + 1000, []), why);
  }
  // Table talk goes through the rules; a bad line is refused before anything is recorded.
  const next = await r.call("GET", `/api/arena/state?match=${view.id}`, undefined, token);
  const link = await r.call("POST", "/api/arena/move", { match: view.id, round: next.body.round, pull: 0, nonce: nonce(), line: "visit claim.lol" }, token);
  assert.equal(link.status, 400);
  assert.match(link.body.error, /links/);
});

/** A match between two fighters, built from a house match, for rules the house can't exercise (it moves at once). */
function twoFighters(): Match {
  const m = newHouseMatch({ id: "f".repeat(24), rules: DUELS_1, now: Date.UTC(2026, 10, 9), fighter: { id: MINT, name: "A", fallback: { kind: "zero" } }, fighterSide: "a", bot: "even", seed: "s" });
  m.sides.b = { ...m.sides.b, kind: "fighter", id: MINT2, name: "B", fallback: { kind: "mirror" } };
  m.house = null;
  m.open!.moves = {};
  return m;
}

test("nothing about an open round leaks: views are identical whether or not the other side has moved", () => {
  const m = twoFighters();
  const before = { b: JSON.stringify(viewMatch(m, "b", [])), spectator: JSON.stringify(viewMatch(m, null, [])) };
  applyMove(m, "a", { round: 1, pull: 7, nonce: "c".repeat(32), line: "my secret plan" }, m.createdAt + 45_000, []);
  const after = { b: JSON.stringify(viewMatch(m, "b", [])), spectator: JSON.stringify(viewMatch(m, null, [])) };
  assert.equal(after.b, before.b, "b's view didn't change when a moved");
  assert.equal(after.spectator, before.spectator, "nor a spectator's");
  for (const v of [after.b, after.spectator]) assert.ok(!v.includes("c".repeat(32)) && !v.includes("my secret plan"));
  // a's own view says it moved, and its bank went down; b's view still shows a's bank as of the last reveal.
  const a = viewMatch(m, "a", []);
  assert.equal(a.self!.moved, true);
  assert.equal(a.self!.bank, 600 - 45);
  assert.equal(viewMatch(m, "b", []).sides.a.bank, 600);
  // Once b moves, the round is revealed to everyone, with both commitments.
  applyMove(m, "b", { round: 1, pull: 2, nonce: "d".repeat(32), line: "" }, m.createdAt + 50_000, []);
  const revealed = viewMatch(m, null, []);
  assert.equal(revealed.rounds[0]!.a.line, "my secret plan");
  assert.equal(revealed.rounds[0]!.a.arrivedMs, 45_000);
  assert.equal(revealed.sides.a.bank, 555);
});

test("every response during a house match keeps the house's pending move and seed hidden", async () => {
  const { r, token, view } = await setup();
  const texts: string[] = [];
  let v = view;
  const watch = async (p: Promise<{ text: string; body: any }>) => {
    const res = await p;
    texts.push(res.text);
    return res;
  };
  while (v.round !== null) {
    // Before our move, the house's pull for this round is already stored; no view may carry its nonce.
    const st = await watch(r.call("GET", `/api/arena/state?match=${v.id}`, undefined, token));
    await watch(r.call("GET", `/api/arena/match/${v.id}`));
    const stored = (r.store.dump()[`arena:match:${v.id}`] as Match);
    const pending = stored.open!.moves[stored.house!.side]!;
    for (const t of texts.slice(-2)) {
      assert.ok(!t.includes(pending.nonce), "the house's open nonce never appears");
      assert.ok(!t.includes(stored.house!.seed), "the seed never appears before the end");
      assert.ok(!t.includes('"moves"') && !t.includes('"open"'), "no open-round structure is ever sent");
    }
    v = (await watch(r.call("POST", "/api/arena/move", { match: v.id, round: st.body.round, pull: 1, nonce: nonce(), line: "" }, token))).body;
  }
});

test("a fighter that doesn't move gets its fallback when its round time runs out, and a late move is refused", async () => {
  const { r, token, view } = await setup("even");
  await r.advance(120_000);
  const st = await r.call("GET", `/api/arena/state?match=${view.id}`, undefined, token);
  assert.equal(st.body.round, 2, "round 1 went to the fallback");
  const mine = st.body.rounds[0][st.body.you];
  assert.equal(mine.fallback, true);
  assert.equal(mine.pull, 2, "steady:2");
  assert.equal(mine.arrivedMs, 120_000);
  assert.equal(st.body.self.bank, 480);
  const late = await r.call("POST", "/api/arena/move", { match: view.id, round: 1, pull: 5, nonce: nonce(), line: "" }, token);
  assert.equal(late.body.code, "late");
  // A move in time costs only the time it took.
  r.clock.advance(30_000);
  const ok = await move(r, token, st.body, 1);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.self.bank, 450);
});

test("an absent fighter's match still ends, every round its fallback, with only the sweep running", async () => {
  const { r, token, view } = await setup();
  // Five rounds of two minutes empty a ten-minute bank; after that the rest plays out at once (or the house won first).
  await r.advance(5 * 120_000);
  const st = await r.call("GET", `/api/arena/state?match=${view.id}`, undefined, token);
  assert.ok(st.body.ending, "the match ended");
  assert.ok(st.body.rounds.every((x: any) => x[st.body.you].fallback), "every round was the fallback");
  assert.equal((await r.call("GET", `/api/arena/fighter/${MINT}`)).body.match, null);
});

test("the bank: each missed round costs two minutes; once it's empty the fallback plays at once, every round", () => {
  const m = twoFighters();
  for (let round = 1; round <= 15 && !m.ending; round++) {
    const opened = m.open!.openedAt;
    settle(m, opened + 1000, []);
    if (!m.open) break;
    applyMove(m, "a", { round: m.open.round, pull: 0, nonce: "e".repeat(32), line: "" }, opened + 1000, []);
    settle(m, opened + 120_000, []); // b's deadline, never past a's next one
  }
  assert.equal(m.rounds.length, 15, "b mirrors a's 0, so it runs the distance");
  assert.deepEqual(m.ending, { winner: null, reason: "draw" });
  assert.deepEqual(m.rounds.slice(0, 5).map((x) => x.b.arrivedMs), [120_000, 120_000, 120_000, 120_000, 120_000]);
  assert.ok(m.rounds.slice(5).every((x) => x.b.fallback && x.b.arrivedMs === 0), "from round 6, at once");
  assert.equal(m.sides.b.bank, 0);
  assert.equal(m.sides.a.bank, 600 - 15);
});

test("both fighters absent: the match is void, with no result", () => {
  const m = twoFighters();
  settle(m, m.createdAt + 11 * 60_000, []);
  assert.deepEqual(m.ending, { winner: null, reason: "void" });
  assert.equal(m.rounds.length, 5);
});

test("an outage stops the clocks: moves are refused while it lasts, and nobody loses time to it", async () => {
  const { r, token, view } = await setup("even");
  r.clock.advance(30_000);
  r.store.down = true;
  const refused = await move(r, token, view, 1);
  assert.equal(refused.status, 503);
  assert.equal(refused.body.code, "paused");
  // Five minutes down: no sweep reaches the store.
  await r.advance(5 * 60_000);
  r.store.down = false;
  const st = await r.call("GET", `/api/arena/state?match=${view.id}`, undefined, token);
  assert.equal(st.body.round, 1, "round 1 is still open: the outage didn't count");
  assert.ok(st.body.self.deadline > r.clock.now(), "and the fighter still has time");
  const ok = await move(r, token, st.body, 1);
  assert.equal(ok.status, 200, ok.text);
  assert.ok(ok.body.self.bank >= 600 - 31 - 61, `${ok.body.self.bank}`);
});

test("a long-poll wakes only on a reveal, waits at most 40 seconds, and only one runs at a time", async () => {
  const { r, token, view } = await setup();
  // Nothing new: it waits the full 40 seconds (the fake clock moves as it sleeps) and returns the same round.
  const t0 = r.clock.now();
  const waited = await r.call("GET", `/api/arena/state?match=${view.id}&after=0&wait=1`, undefined, token);
  assert.equal(waited.status, 200);
  assert.equal(waited.body.round, 1);
  assert.ok(r.clock.now() - t0 >= 40_000 && r.clock.now() - t0 < 42_000, `${r.clock.now() - t0}`);
  // Already something newer than `after`: no wait.
  await move(r, token, view, 1);
  const t1 = r.clock.now();
  const quick = await r.call("GET", `/api/arena/state?match=${view.id}&after=0&wait=1`, undefined, token);
  assert.equal(quick.body.rounds.length, 1);
  assert.equal(r.clock.now(), t1);
  // A second long-poll while one is open is refused.
  await r.store.cas(`arena:poll:${MINT}`, 0, 1, 45);
  const second = await r.call("GET", `/api/arena/state?match=${view.id}&after=5&wait=1`, undefined, token);
  assert.equal(second.body.code, "rate_limited");
});

test("rate limits: 120 units a minute per fighter, a long-poll counting 5", async () => {
  const { r, token, view } = await setup();
  let last = 0;
  for (let i = 0; i < 125; i++) last = (await r.call("GET", `/api/arena/state?match=${view.id}`, undefined, token)).status;
  assert.equal(last, 429);
  r.clock.advance(60_000);
  assert.equal((await r.call("GET", `/api/arena/state?match=${view.id}`, undefined, token)).status, 200);
});

test("retiring forfeits; before round 3 it's a loss on the record but tells the rating nothing", async () => {
  const { r, token } = await setup();
  const out = await r.call("POST", "/api/arena/retire", {}, token);
  assert.equal(out.body.ending.reason, "forfeit");
  assert.notEqual(out.body.ending.winner, out.body.you);
  const f = (await r.call("GET", `/api/arena/fighter/${MINT}`)).body;
  assert.equal(f.record.house.loss, 1);
  assert.equal(f.deviation, 350, "unchanged");
  // And a new match can start.
  assert.equal((await r.call("POST", "/api/arena/join", { fallback: "zero", opponent: "reader" }, token)).body.round, 1);
});

test("joining is idempotent while a match is on, and declares a fallback from the menu", async () => {
  const { r, token, view } = await setup();
  const again = await r.call("POST", "/api/arena/join", { fallback: "zero", opponent: "reader" }, token);
  assert.equal(again.body.id, view.id);
  assert.equal(again.body.self.fallback, "steady:2", "the first declaration stands");
  const other = rig();
  const t = await other.register();
  for (const bad of [undefined, "all-in", "steady:x"]) assert.equal((await other.call("POST", "/api/arena/join", { fallback: bad }, t)).status, 400);
  assert.equal((await other.call("POST", "/api/arena/join", { fallback: "zero", opponent: "nobody" }, t)).status, 400);
});

test("operator coins play but are never ranked; coins that fail the checks lose their listing", async () => {
  const r = rig();
  r.coins.coins.get(MINT2)!.creatorHolds = false;
  await r.register(MINT2);
  const f = (await r.call("GET", `/api/arena/fighter/${MINT2}`)).body;
  assert.equal(f.listed, false);
  assert.equal(f.operator, false);
  const { createRelay } = await import("../src/http.ts");
  const op = createRelay({ store: r.store, clock: r.clock, rpc: r.rpc, coins: r.coins, referee: { operatorWallets: [OTHER] } });
  r.coins.coins.get(MINT)!.creator = OTHER;
  const enrolled = await op.referee.enroll({ wallet: WALLET, mint: MINT });
  assert.equal(enrolled.fighter.operator, true, "an operator's coin, by its creator");
});

test("the sweep needs the cron's secret; unknown routes and bodies get the error shape", async () => {
  const r = rig();
  assert.equal((await r.call("POST", "/api/arena/sweep")).status, 401);
  const nope = await r.call("GET", "/api/arena/nope");
  assert.deepEqual(Object.keys(nope.body).sort(), ["code", "error"]);
  assert.equal((await r.call("GET", "/api/arena/rules")).body.rules.id, "duels-1");
  assert.equal((await r.call("POST", "/api/arena/join", { fallback: "zero", opponent: "reader" })).status, 401);
});

test("simultaneous moves: of two different moves sent at once, one is recorded and the other is a conflict or late", async () => {
  const { r, token } = await setup();
  const st = (await r.call("GET", "/api/arena/state", undefined, token)).body;
  const [x, y] = await Promise.all([
    r.call("POST", "/api/arena/move", { match: st.id, round: st.round, pull: 1, nonce: nonce(), line: "" }, token),
    r.call("POST", "/api/arena/move", { match: st.id, round: st.round, pull: 2, nonce: nonce(), line: "" }, token),
  ]);
  const statuses = [x.status, y.status].sort();
  assert.deepEqual(statuses, [200, 409], `${x.text} / ${y.text}`);
  const after = (await r.call("GET", `/api/arena/state?match=${st.id}`, undefined, token)).body;
  assert.equal(after.rounds.length, 1, "the round was revealed once");
  const winner = x.status === 200 ? 1 : 2;
  assert.equal(after.rounds[0][after.you].pull, winner, "with the move that was accepted");
});

test("the pages' indexes: live and recent matches, and each fighter's matches, newest first", async () => {
  const { r, token, view } = await setup();
  let lists = await r.relay.referee.matches();
  assert.deepEqual(lists.live.map((m) => m.id), [view.id]);
  assert.equal(lists.live[0]!.self, undefined, "spectator views only");
  await r.call("POST", "/api/arena/retire", {}, token);
  const second = (await r.call("POST", "/api/arena/join", { fallback: "zero", opponent: "reader" }, token)).body;
  lists = await r.relay.referee.matches();
  assert.deepEqual(lists.recent.map((m) => m.id), [view.id]);
  assert.deepEqual(lists.live.map((m) => m.id), [second.id]);
  assert.deepEqual((await r.relay.referee.fighterMatches(MINT)).map((m) => m.id), [second.id, view.id]);
});

test("reports and hiding: a spectator reports a line; a moderator hides it; every commitment still checks out", async () => {
  const { r, token, view } = await setup("even");
  const moved = await r.call("POST", "/api/arena/move", { match: view.id, round: 1, pull: 3, nonce: nonce(), line: "something rude" }, token);
  const me = moved.body.you;
  const report = await r.call("POST", "/api/arena/report", { match: view.id, round: 1, side: me, why: "rude" });
  assert.equal(report.status, 200, report.text);
  assert.equal((await r.call("POST", "/api/arena/report", { match: view.id, round: 1, side: me === "a" ? "b" : "a" })).status, 404, "nothing said there");
  // Without an admin token the admin routes don't exist.
  assert.equal((await r.call("GET", "/api/arena/admin/reports")).status, 404);
  const { createRelay } = await import("../src/http.ts");
  const admin = createRelay({ store: r.store, clock: r.clock, rpc: r.rpc, coins: r.coins, adminToken: "mod" });
  const req = (m: string, p: string, b?: unknown, t?: string) => admin.fetch(new Request(`https://x.test${p}`, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }));
  assert.equal((await req("GET", "/api/arena/admin/reports", undefined, "wrong")).status, 404);
  const listed = (await (await req("GET", "/api/arena/admin/reports", undefined, "mod")).json()) as any[];
  assert.equal(listed.length, 1);
  assert.equal((await req("POST", "/api/arena/admin/hide", { match: view.id, round: 1, side: me }, "mod")).status, 200);
  const after = (await r.call("GET", `/api/arena/match/${view.id}`)).body;
  assert.equal(after.rounds[0][me].line, "");
  assert.equal(after.rounds[0][me].hidden, true);
  assert.equal(after.rounds[0][me].commitment, commitment(view.id, 1, me, 3, after.rounds[0][me].nonce));
  assert.deepEqual((await (await req("GET", "/api/arena/admin/reports", undefined, "mod")).json()), []);
});

test("without a cron secret the sweep runs at most every 30 seconds; registration is limited per caller", async () => {
  const r = rig();
  const { createRelay } = await import("../src/http.ts");
  const open = createRelay({ store: r.store, clock: r.clock, rpc: r.rpc, coins: r.coins, clientKey: () => "1.2.3.4" });
  const sweep = async () => (await (await open.fetch(new Request("https://x.test/api/arena/sweep"))).json()) as any;
  assert.ok("open" in (await sweep()));
  assert.ok("skipped" in (await sweep()));
  r.clock.advance(31_000);
  assert.ok("open" in (await sweep()));
  let last = 0;
  for (let i = 0; i < 22; i++) last = (await open.fetch(new Request("https://x.test/api/agents/challenge", { method: "POST", body: "{}" }))).status;
  assert.equal(last, 429);
});
