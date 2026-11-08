import { test } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { randomHex } from "../src/registration.ts";
import type { Fighter, Match } from "../src/arena/types.ts";
import { MINT, MINT2, OTHER, rig, WALLET, type Rig } from "./fakes.ts";

// Agents against agents (docs/arena.md 7, phase 3): the queue pairs by rating, widening with the wait; never two
// fighters with one owner; the house after two minutes; rated results for both sides with the weights and the weekly
// cap; and the flags a moderator reviews.

const addr = () => bs58.encode(Uint8Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)));

/** Registers a fighter for `mint` from `wallet`, adding the coin to the fake directory if it's new. */
async function fighter(r: Rig, mint = addr(), wallet = addr(), name = `Fighter ${mint.slice(0, 4)}`): Promise<{ token: string; mint: string }> {
  if (!r.coins.coins.has(mint)) r.coins.coins.set(mint, { name, ticker: "F", createdAt: r.clock.now() - 86_400_000, holders: 1, volumeSol: 0, rugFlag: false, creatorHolds: true, creator: wallet });
  return { token: await r.register(mint, wallet), mint };
}

const join = (r: Rig, token: string, body: Record<string, unknown> = {}) => r.call("POST", "/api/arena/join", { fallback: "zero", wait: false, opponent: "agent", ...body }, token);
const stored = (r: Rig, key: string) => r.store.dump()[key] as any;

/** Pairs two fighters the way agents would: both keep calling line_join, and the allowed rating gap widens with time. */
async function pair(r: Rig, a: string, b: string): Promise<string> {
  for (let i = 0; i < 4; i++) {
    const x = await join(r, a);
    if (x.body.id) {
      assert.equal(x.body.ending, null, "never a finished match");
      return x.body.id;
    }
    const y = await join(r, b);
    if (y.body.id) {
      assert.equal(y.body.ending, null, "never a finished match");
      return y.body.id;
    }
    r.clock.advance(31_000);
  }
  throw new Error("never paired");
}

/** Plays a match between two agents to the end, each choosing its pull with `pick`. */
async function play(r: Rig, match: string, players: { token: string; pick: (energy: number, round: number) => number }[]) {
  for (let i = 0; i < 40; i++) {
    const m = stored(r, `arena:match:${match}`) as Match;
    if (m.ending) return m;
    for (const p of players) {
      const v = (await r.call("GET", `/api/arena/state?match=${match}`, undefined, p.token)).body;
      if (v.round === null) break;
      if (v.self.moved) continue;
      r.clock.advance(2000);
      const res = await r.call("POST", "/api/arena/move", { match, round: v.round, pull: Math.min(p.pick(v.energy[v.you], v.round), v.energy[v.you]), nonce: randomHex(16), line: "" }, p.token);
      assert.equal(res.status, 200, res.text);
    }
  }
  return stored(r, `arena:match:${match}`) as Match;
}

test("two agents queue and are paired into a rated match; the first finds it on its next call", async () => {
  const r = rig();
  const a = await fighter(r, MINT, WALLET);
  const b = await fighter(r, MINT2, OTHER);
  const first = await join(r, a.token);
  assert.equal(first.body.waiting, true);
  assert.equal(first.body.queue, 0);
  assert.equal((await r.call("GET", "/api/arena/queue")).body.waiting, 1);
  const second = await join(r, b.token);
  assert.equal(second.status, 200, second.text);
  assert.ok(second.body.id && second.body.round === 1);
  const m = stored(r, `arena:match:${second.body.id}`) as Match;
  assert.equal(m.house, null);
  assert.equal(m.rated, true);
  assert.deepEqual(new Set([m.sides.a.id, m.sides.b.id]), new Set([MINT, MINT2]));
  const again = await join(r, a.token);
  assert.equal(again.body.id, second.body.id, "the first fighter gets the same match");
  assert.notEqual(again.body.you, second.body.you);
  assert.equal((await r.call("GET", "/api/arena/queue")).body.waiting, 0);
});

test("two joins at the same moment make exactly one match", async () => {
  const r = rig();
  const a = await fighter(r, MINT, WALLET);
  const b = await fighter(r, MINT2, OTHER);
  const [x, y] = await Promise.all([r.call("POST", "/api/arena/join", { fallback: "zero", opponent: "agent" }, a.token), r.call("POST", "/api/arena/join", { fallback: "zero", opponent: "agent" }, b.token)]);
  assert.equal(x.status, 200, x.text);
  assert.equal(y.status, 200, y.text);
  assert.ok(x.body.id && x.body.id === y.body.id, `${x.text} / ${y.text}`);
  const open = stored(r, "arena:open") as string[];
  assert.equal(open.length, 1);
});

test("one owner's fighters are never paired; after two minutes unpaired the house plays instead", async () => {
  const r = rig();
  const owner = addr();
  const a = await fighter(r, addr(), owner);
  const b = await fighter(r, addr(), owner);
  assert.equal((await join(r, a.token)).body.waiting, true);
  assert.equal((await join(r, b.token)).body.waiting, true, "same owner: no pairing");
  for (let t = 0; t < 100; t += 25) {
    r.clock.advance(25_000);
    await join(r, a.token);
    await join(r, b.token);
  }
  r.clock.advance(25_000);
  const house = await join(r, a.token);
  assert.equal(house.body.house?.bot, "reader", house.text);
});

test("a place lasts a minute after the last call; pairing widens with the wait", async () => {
  const r = rig();
  const a = await fighter(r, MINT, WALLET);
  const b = await fighter(r, MINT2, OTHER);
  await join(r, a.token);
  r.clock.advance(61_000);
  assert.equal((await join(r, b.token)).body.waiting, true, "a's place expired");
  assert.equal((await r.call("GET", "/api/arena/queue")).body.waiting, 1);

  // Ratings 200 apart: not at first (150), but after 30 seconds of waiting (250).
  const s = rig();
  const c = await fighter(s, MINT, WALLET);
  const d = await fighter(s, MINT2, OTHER);
  const fc = stored(s, `arena:fighter:${MINT2}`) as Fighter;
  await s.store.cas(`arena:fighter:${MINT2}`, (await s.store.get(`arena:fighter:${MINT2}`))!.version, { ...fc, rating: { ...fc.rating, r: 1700 } });
  await join(s, c.token);
  assert.equal((await join(s, d.token)).body.waiting, true, "too far apart at first");
  s.clock.advance(31_000);
  await join(s, c.token);
  const paired = await join(s, d.token);
  assert.ok(paired.body.id, paired.text);
});

test("a rated match moves both ratings, a quarter as far against provisional fighters, and fills the leaderboard's counts", async () => {
  const r = rig();
  const a = await fighter(r, MINT, WALLET);
  const b = await fighter(r, MINT2, OTHER);
  await join(r, a.token);
  const id = (await join(r, b.token)).body.id;
  const m = await play(r, id, [
    { token: a.token, pick: (e) => Math.min(e, 6) },
    { token: b.token, pick: () => 2 },
  ]);
  assert.ok(m.ending?.winner);
  const fa = stored(r, `arena:fighter:${MINT}`) as Fighter;
  const fb = stored(r, `arena:fighter:${MINT2}`) as Fighter;
  const winner = m.sides[m.ending!.winner!].id === MINT ? fa : fb;
  const loser = winner === fa ? fb : fa;
  assert.ok(winner.rating.r > 1500 && loser.rating.r < 1500, `${winner.rating.r} / ${loser.rating.r}`);
  // Against a provisional opponent a win counts a quarter: well under a full 1500-vs-1500 win from scratch (~+162).
  assert.ok(winner.rating.r - 1500 < 100, `${winner.rating.r}`);
  assert.equal(winner.record.rated.win, 1);
  assert.equal(loser.record.rated.loss, 1);
  assert.deepEqual(winner.opponentOwners, [loser.wallet]);
  assert.deepEqual(winner.establishedOpponents, [], "the opponent was provisional");
  assert.equal(winner.match, null);
});

test("only three rated matches a week between the same pair; the fourth is unrated", async () => {
  const r = rig();
  const a = await fighter(r, MINT, WALLET);
  const b = await fighter(r, MINT2, OTHER);
  let last: Match | undefined;
  for (let i = 0; i < 4; i++) {
    const id = await pair(r, a.token, b.token);
    last = await play(r, id, [
      { token: a.token, pick: (e) => Math.min(e, 7) },
      { token: b.token, pick: () => 1 },
    ]);
    if (i < 3) assert.equal(last.rated, true, `match ${i + 1} is rated`);
  }
  assert.equal(last!.rated, false);
  const fa = stored(r, `arena:fighter:${MINT}`) as Fighter;
  assert.equal(fa.record.rated.win + fa.record.rated.loss + fa.record.rated.draw, 3);
  assert.equal((fa.record.unrated?.win ?? 0) + (fa.record.unrated?.loss ?? 0) + (fa.record.unrated?.draw ?? 0), 1);
});

test("flags for review: fallback-only play, the same pulls again, and repeated losses to one opponent", async () => {
  const r = rig();
  const a = await fighter(r, MINT, WALLET);
  const b = await fighter(r, MINT2, OTHER);
  // The same five rounds every time: a wins the odd rounds (3 against 2) and ties the even ones.
  for (let i = 0; i < 3; i++) {
    const id = await pair(r, a.token, b.token);
    const m = await play(r, id, [
      { token: a.token, pick: (_e, round) => (round % 2 ? 3 : 2) },
      { token: b.token, pick: () => 2 },
    ]);
    assert.equal(m.rounds.length, 5);
  }
  const reasons = (await r.relay.referee.flags()).map((f) => `${f.fighter === MINT ? "a" : "b"}: ${f.reason}`);
  assert.ok(reasons.some((x) => /the same pulls as an earlier match/.test(x)), reasons.join("; "));
  assert.ok(reasons.some((x) => /lost 3 times this week/.test(x)), reasons.join("; "));

  // A fighter that never moves: its fallback plays every round.
  const s = rig();
  const c = await fighter(s, MINT, WALLET);
  const d = await fighter(s, MINT2, OTHER);
  await join(s, c.token);
  const id = (await join(s, d.token)).body.id;
  for (let i = 0; i < 40 && !(stored(s, `arena:match:${id}`) as Match).ending; i++) {
    const v = (await s.call("GET", `/api/arena/state?match=${id}`, undefined, d.token)).body;
    if (v.round !== null && !v.self.moved) await s.call("POST", "/api/arena/move", { match: id, round: v.round, pull: Math.min(3, v.energy[v.you]), nonce: randomHex(16), line: "" }, d.token);
    await s.advance(60_000);
  }
  const flags = await s.relay.referee.flags();
  assert.ok(flags.some((f) => f.fighter === MINT && /played only its fallback/.test(f.reason)), JSON.stringify(flags));
});

test("a fighter that takes on the house leaves the queue, and is never paired while it plays", async () => {
  const r = rig();
  const a = await fighter(r, MINT, WALLET);
  const b = await fighter(r, MINT2, OTHER);
  assert.equal((await join(r, a.token)).body.waiting, true);
  const house = await join(r, a.token, { opponent: "reader" });
  assert.equal(house.body.house?.bot, "reader");
  assert.equal((await r.call("GET", "/api/arena/queue")).body.waiting, 0);
  const b1 = await join(r, b.token);
  assert.equal(b1.body.waiting, true, "a is busy with the house");
  assert.equal((stored(r, `arena:fighter:${MINT}`) as Fighter).match, house.body.id, "a's match is untouched");
});

test("a client that names no opponent (0.14.0's tool) still gets the house at once, never a waiting answer", async () => {
  const r = rig();
  const a = await fighter(r, MINT, WALLET);
  const old = await r.call("POST", "/api/arena/join", { fallback: "zero" }, a.token);
  assert.equal(old.body.house?.bot, "reader", old.text);
});
