import { test } from "node:test";
import assert from "node:assert/strict";
import { randomHex } from "../src/registration.ts";
import { createRelay } from "../src/http.ts";
import { readMetrics, recordMatch, weekStart } from "../src/arena/metrics.ts";
import { MemoryStore } from "../src/store.ts";
import { FakeClock } from "../src/clock.ts";
import type { Fighter, Match } from "../src/arena/types.ts";
import { MINT, rig, WALLET, type Rig } from "./fakes.ts";

// Free play's numbers (docs/arena.md 2, docs/wager-mode.md 13): who played each week, recorded once per match as it
// settles, and read back by the maintainer behind the admin token.

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** Plays the house to the end, moving every round. */
async function playHouse(r: Rig, token: string) {
  let view = (await r.call("POST", "/api/arena/join", { fallback: "zero", opponent: "reader" }, token)).body;
  while (view.round !== null) {
    view = (await r.call("POST", "/api/arena/move", { match: view.id, round: view.round, pull: Math.min(2, view.energy[view.you]), nonce: randomHex(16), line: "" }, token)).body;
  }
  return view;
}

test("weeks start on Monday, UTC", () => {
  assert.equal(weekStart(Date.parse("2026-11-11T12:00:00Z")), "2026-11-09");
  assert.equal(weekStart(Date.parse("2026-11-09T00:00:00Z")), "2026-11-09");
  assert.equal(weekStart(Date.parse("2026-11-15T23:59:59Z")), "2026-11-09");
  assert.equal(weekStart(Date.parse("2026-11-16T00:00:00Z")), "2026-11-16");
  assert.equal(weekStart(Date.parse("2027-01-01T00:00:00Z")), "2026-12-28");
});

test("a fighter that plays the house makes its owner active that week; the admin route reads it, and only with the token", async () => {
  const r = rig();
  const token = await r.register();
  const view = await playHouse(r, token);
  assert.ok(view.ending);
  const admin = createRelay({ store: r.store, clock: r.clock, rpc: r.rpc, coins: r.coins, adminToken: "mod" });
  const get = (p: string, t?: string) => admin.fetch(new Request(`https://x.test${p}`, { headers: t ? { authorization: `Bearer ${t}` } : {} }));
  assert.equal((await r.call("GET", "/api/arena/admin/metrics")).status, 404, "no route without an admin token configured");
  assert.equal((await get("/api/arena/admin/metrics", "wrong")).status, 404);
  const res = await get("/api/arena/admin/metrics?weeks=4", "mod");
  assert.equal(res.status, 200);
  const m: any = await res.json();
  assert.equal(m.weeks.length, 4);
  const now = m.weeks.at(-1);
  assert.equal(now.week, weekStart(r.clock.now()));
  assert.equal(now.complete, false);
  assert.equal(now.activeOwners, 1);
  assert.equal(now.registrations, 1);
  assert.equal(now.matches.all, 1);
  assert.equal(now.matches.againstHouse, 1);
  assert.equal(now.matches.finished, 1);
  assert.equal(now.matches.finishedRate, 1);
  assert.deepEqual(m.retention, [{ cohort: now.week, owners: 1, retained: 0, due: false }]);
  assert.equal(m.gate.met, false);
  assert.equal(m.gate.weeksAtOrAbove, 0);
  assert.equal(m.gate.retention, null);
  assert.ok(!JSON.stringify(m).includes(token), "no token in the numbers");
});

test("an owner whose fighter only played its fallback isn't active, though the match counts", async () => {
  const r = rig();
  const token = await r.register();
  const view = (await r.call("POST", "/api/arena/join", { fallback: "steady:2", opponent: "reader" }, token)).body;
  await r.advance(5 * 120_000);
  assert.ok((await r.call("GET", `/api/arena/state?match=${view.id}`, undefined, token)).body.ending);
  const now = (await r.relay.referee.metrics(1)).weeks[0]!;
  assert.equal(now.activeOwners, 0);
  assert.equal(now.matches.all, 1);
});

test("operator coins are counted apart, never toward the gate", async () => {
  const r = rig({ operatorWallets: [WALLET] });
  const token = await r.register();
  await playHouse(r, token);
  const now = (await r.relay.referee.metrics(1)).weeks[0]!;
  assert.equal(now.activeOwners, 0);
  assert.equal(now.operatorOwners, 1);
  assert.equal(now.registrations, 0, "an operator's registration isn't counted either");
});

test("recording a match again changes nothing, so the backfill is safe to run twice", async () => {
  const r = rig();
  const token = await r.register();
  await playHouse(r, token);
  const before = await r.relay.referee.metrics(2);
  // Lose the numbers, as if the match had settled before they existed, then backfill twice.
  for (const k of Object.keys(r.store.dump())) if (k.startsWith("arena:metrics:")) await r.store.del(k);
  assert.equal((await r.relay.referee.metrics(2)).weeks.at(-1)!.activeOwners, 0);
  assert.deepEqual(await r.relay.referee.backfillMetrics(), { matches: 1 });
  assert.deepEqual(await r.relay.referee.backfillMetrics(), { matches: 1 });
  assert.deepEqual(await r.relay.referee.metrics(2), before);
});

// The gate, from matches recorded directly over weeks.

const fighter = (i: number): Fighter => ({ id: `mint${i}`, wallet: `owner${i}`, operator: false, registeredAt: 0 }) as Fighter;

function match(id: string, at: number, a: Fighter, ending: Match["ending"] = { winner: "a", reason: "rounds_up" }, moved = true): Match {
  return {
    id,
    createdAt: at,
    house: { bot: "even" },
    sides: { a: { kind: "fighter", id: a.id }, b: { kind: "house", id: "even" } },
    rounds: [{ a: { fallback: !moved }, b: { fallback: true } }],
    ending,
  } as unknown as Match;
}

test("the gate: 50 weekly active owners for 4 complete weeks in a row, and 30% still playing a month after their first match", async () => {
  const clock = new FakeClock();
  const store = new MemoryStore(clock);
  const monday = Date.parse("2026-11-02T10:00:00Z");
  const owners = Array.from({ length: 60 }, (_, i) => fighter(i));
  const byId = Object.fromEntries(owners.map((f) => [f.id, f]));
  // Weeks 0 to 5: 50 owners each week, the same 50 (0..49); in week 5 also 10 newcomers (50..59).
  for (let w = 0; w < 6; w++) {
    const active = w === 5 ? owners : owners.slice(0, 50);
    for (const f of active) await recordMatch(store, match(`${w}-${f.id}`, monday + w * WEEK, f), byId);
  }
  // A forfeit and a void that week count as unfinished matches.
  await recordMatch(store, match("forfeit", monday + 5 * WEEK, owners[0]!, { winner: "b", reason: "forfeit" }), byId);
  await recordMatch(store, match("void", monday + 5 * WEEK, owners[1]!, { winner: null, reason: "void" }), byId);

  // Read as of week 6's Tuesday: weeks 0 to 5 are complete.
  const m = await readMetrics(store, monday + 6 * WEEK + DAY, owners, 8);
  const byWeek = Object.fromEntries(m.weeks.map((w) => [w.week, w]));
  assert.equal(byWeek["2026-11-02"]!.activeOwners, 50);
  assert.equal(byWeek["2026-12-07"]!.activeOwners, 60);
  assert.equal(byWeek["2026-12-07"]!.matches.all, 62);
  assert.equal(byWeek["2026-12-07"]!.matches.finished, 60);
  assert.equal(byWeek["2026-12-14"]!.complete, false);
  assert.equal(m.gate.weeksAtOrAbove, 6);
  // The first cohort (week 0, 50 owners) is due and all came back from week 4 on; week 5's newcomers aren't due.
  assert.deepEqual(m.retention, [
    { cohort: "2026-11-02", owners: 50, retained: 50, due: true },
    { cohort: "2026-12-07", owners: 10, retained: 0, due: false },
  ]);
  assert.equal(m.gate.retention, 1);
  assert.equal(m.gate.met, true);

  // One week under the line breaks the run.
  const thin = new MemoryStore(clock);
  for (let w = 0; w < 6; w++) {
    const active = owners.slice(0, w === 3 ? 49 : 50);
    for (const f of active) await recordMatch(thin, match(`${w}-${f.id}`, monday + w * WEEK, f), byId);
  }
  const t = await readMetrics(thin, monday + 6 * WEEK + DAY, owners, 8);
  assert.equal(t.gate.weeksAtOrAbove, 2);
  assert.equal(t.gate.met, false);

  // Nobody returning a month on fails the retention half, however many play each week.
  const crowd = Array.from({ length: 100 }, (_, i) => fighter(i));
  const crowdById = Object.fromEntries(crowd.map((f) => [f.id, f]));
  const gone = new MemoryStore(clock);
  for (let w = 0; w < 6; w++) {
    const active = w < 4 ? crowd.slice(0, 50) : crowd.slice(50);
    for (const f of active) await recordMatch(gone, match(`${w}-${f.id}`, monday + w * WEEK, f), crowdById);
  }
  const g = await readMetrics(gone, monday + 6 * WEEK + DAY, crowd, 8);
  assert.equal(g.gate.weeksAtOrAbove, 6);
  assert.equal(g.gate.retention, 0);
  assert.equal(g.gate.met, false);
});
