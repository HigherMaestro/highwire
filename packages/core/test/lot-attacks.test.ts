import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  auditDraws,
  bidCommitment,
  commit,
  commitDeadline,
  drawFrom,
  firstEntropy,
  mixEntropy,
  openLotSeries,
  reveal,
  revealDeadline,
  revealSeed,
  seedCommitment,
  sideOf,
  timeout,
  type LotSeriesConfig,
  type LotSeriesState,
  type Player,
} from "../scripts/games/lot-series.ts";

// The Lot's draw, attacked (docs/research/new-games.md 1.5). Every test is something a player who has read all of this
// code might try, and what must happen instead. The attacker never knows a seed or nonce that hasn't been revealed.

const CONFIG: LotSeriesConfig = { rules: { id: "lot-test", prizes: [1, 2, 3, 4, 5, 6, 7, 8, 9], energy: 30 }, matches: 5, commitSeconds: 120, revealSeconds: 120 };
const rnd = () => randomBytes(32).toString("hex");
const SERIES = "5e".repeat(32);
const OTHER: Record<Player, Player> = { A: "B", B: "A" };

/** A series past its seed step, with round 1 of match 1 open at time 0. */
function opened(seedA = rnd(), seedB = rnd()): LotSeriesState {
  const s = openLotSeries(CONFIG, SERIES, seedCommitment(SERIES, seedA), seedB, 0);
  revealSeed(s, seedA, 0);
  return s;
}

/** The commitment a player would send for the open round. */
const hashFor = (s: LotSeriesState, p: Player, bid: number, nonce: string) => bidCommitment(s.seriesId, s.match, s.game!.rounds.length + 1, sideOf(p, s.match), bid, nonce);

/** Both players commit to these bids with fresh nonces. Returns the nonces, for the reveals. */
function bothCommit(s: LotSeriesState, bids: Record<Player, number>, at = s.phaseOpenedAt): Record<Player, string> {
  const nonce = { A: rnd(), B: rnd() }, round = s.game!.rounds.length + 1;
  commit(s, "A", round, hashFor(s, "A", bids.A, nonce.A), at);
  commit(s, "B", round, hashFor(s, "B", bids.B, nonce.B), at);
  return nonce;
}

/** One honest round: both commit, both reveal. */
function round(s: LotSeriesState, bids: Record<Player, number>, firstToReveal: Player = "A"): void {
  const nonce = bothCommit(s, bids), at = s.phaseOpenedAt;
  reveal(s, firstToReveal, bids[firstToReveal], nonce[firstToReveal], at);
  reveal(s, OTHER[firstToReveal], bids[OTHER[firstToReveal]], nonce[OTHER[firstToReveal]], at);
}

/** A whole honest series of small random bids. */
function honestSeries(): LotSeriesState {
  const s = opened();
  while (!s.ending) {
    const e = s.game!.energy;
    const bid = (p: Player) => Math.min(e[sideOf(p, s.match)], randomBytes(1)[0]! % 6);
    round(s, { A: bid("A"), B: bid("B") }, randomBytes(1)[0]! % 2 ? "A" : "B");
  }
  return s;
}

test("an honest series ends, and every prize checks from the public record alone", () => {
  for (let i = 0; i < 25; i++) {
    const s = honestSeries();
    assert.equal(auditDraws(s), null);
    assert.ok(s.results.length >= 3 && s.results.length <= 5);
    // Tampering with any part of the record is caught.
    const draws = s.draws.map((d) => ({ ...d }));
    const k = draws.findIndex((d) => d.round > 1);
    draws[k]!.prize = draws[k]!.prize === 1 ? 2 : 1;
    assert.match(auditDraws({ ...s, draws })!, /prize isn't the one/);
    const mixed = s.mixed.map((m) => ({ ...m }));
    mixed[0]!.a = rnd();
    assert.match(auditDraws({ ...s, mixed })!, /entropy doesn't follow/);
    assert.match(auditDraws({ ...s, seedA: rnd() })!, /seed isn't the one/);
  }
});

test("the draw doesn't depend on who reveals first, so there's no race to win", () => {
  const seedA = rnd(), seedB = rnd(), nonce = { A: rnd(), B: rnd() };
  const play = (first: Player) => {
    const s = opened(seedA, seedB);
    commit(s, "A", 1, hashFor(s, "A", 3, nonce.A), 0);
    commit(s, "B", 1, hashFor(s, "B", 2, nonce.B), 0);
    reveal(s, first, first === "A" ? 3 : 2, nonce[first], 1);
    reveal(s, OTHER[first], first === "A" ? 2 : 3, nonce[OTHER[first]], 1);
    return s.game!.prize;
  };
  assert.equal(play("A"), play("B"));
});

test("attack: reveal early, to show a nonce before the opponent has committed. Refused", () => {
  const s = opened(), nonce = rnd();
  commit(s, "A", 1, hashFor(s, "A", 3, nonce), 0);
  // If this worked, B could pick its own nonce knowing A's, and choose the next prize.
  assert.throws(() => reveal(s, "A", 3, nonce, 1), /not a reveal phase/);
});

test("attack: replace a commitment after sending it. Refused", () => {
  const s = opened();
  commit(s, "A", 1, hashFor(s, "A", 3, rnd()), 0);
  assert.throws(() => commit(s, "A", 1, hashFor(s, "A", 4, rnd()), 1), /already committed/);
  assert.throws(() => commit(s, "A", 2, hashFor(s, "A", 4, rnd()), 1), /this is round 1/);
});

test("attack: reveal a different bid or nonce than the one committed. Refused, and then it's a forfeit", () => {
  const s = opened(), nonce = bothCommit(s, { A: 3, B: 2 });
  assert.throws(() => reveal(s, "A", 4, nonce.A, 1), /doesn't match the commitment/);
  assert.throws(() => reveal(s, "A", 3, rnd(), 1), /doesn't match the commitment/);
  reveal(s, "B", 2, nonce.B, 1);
  timeout(s, revealDeadline(s) + 1);
  assert.deepEqual(s.results[0], { winner: "B", reason: "missed_reveal" });
});

test("attack: copy the opponent's commitment, to reveal the same nonce after it does. The copy can't be revealed", () => {
  const s = opened(), nonceA = rnd(), hashA = hashFor(s, "A", 3, nonceA);
  commit(s, "A", 1, hashA, 0);
  commit(s, "B", 1, hashA, 0);
  reveal(s, "A", 3, nonceA, 1);
  // B now knows A's bid and nonce, but its commitment names side a.
  assert.throws(() => reveal(s, "B", 3, nonceA, 1), /doesn't match the commitment/);
  timeout(s, revealDeadline(s) + 1);
  assert.deepEqual(s.results[0], { winner: "A", reason: "missed_reveal" });
});

test("attack: reuse a commitment from another round, match or series. It doesn't open here", () => {
  const s = opened(), nonce = rnd();
  const stale = [
    bidCommitment(s.seriesId, s.match, 2, sideOf("A", s.match), 3, nonce),
    bidCommitment(s.seriesId, s.match + 1, 1, sideOf("A", s.match), 3, nonce),
    bidCommitment("77".repeat(32), s.match, 1, sideOf("A", s.match), 3, nonce),
  ];
  for (const hash of stale) {
    const t = opened();
    commit(t, "A", 1, hash, 0);
    commit(t, "B", 1, hashFor(t, "B", 2, rnd()), 0);
    assert.throws(() => reveal(t, "A", 3, nonce, 1), /doesn't match the commitment/);
  }
});

test("attack: see the draw, then refuse to reveal. It forfeits the match, at every point of a match", () => {
  for (let rounds = 0; rounds < 4; rounds++) {
    const s = opened();
    for (let k = 0; k < rounds && !s.results.length; k++) round(s, { A: 1, B: 1 });
    if (s.results.length) continue;
    const nonce = bothCommit(s, { A: 2, B: 1 });
    reveal(s, "A", 2, nonce.A, s.phaseOpenedAt);
    // B can now work out the next prize: A's nonce is public and it knows its own. It has only one other move.
    const entropy = s.entropy!;
    assert.throws(() => timeout(s, revealDeadline(s)), /still open/);
    timeout(s, revealDeadline(s) + 1);
    assert.deepEqual(s.results[0], { winner: "A", reason: "missed_reveal" });
    assert.equal(s.entropy, entropy, "the withheld round's nonces are never mixed in");
    assert.equal(auditDraws(s), null);
  }
});

test("attack: skip a commit, so that only the opponent's nonce feeds the draw. It forfeits the match", () => {
  const s = opened();
  commit(s, "A", 1, hashFor(s, "A", 3, rnd()), 0);
  assert.throws(() => timeout(s, commitDeadline(s) - 1), /still has time/);
  timeout(s, commitDeadline(s));
  assert.deepEqual(s.results[0], { winner: "A", reason: "missed_commit" });
  // Neither side there: no result, and nobody gains.
  const t = opened();
  timeout(t, commitDeadline(t));
  assert.deepEqual(t.results[0], { winner: null, reason: "void" });
});

test("attack: call timeout early to make the opponent forfeit, or move after the deadline. Refused", () => {
  const s = opened();
  assert.throws(() => timeout(s, commitDeadline(s) - 1), /still has time/);
  assert.throws(() => commit(s, "A", 1, hashFor(s, "A", 3, rnd()), commitDeadline(s)), /too late/);
  const nonce = bothCommit(s, { A: 3, B: 2 }, 5);
  assert.throws(() => timeout(s, revealDeadline(s)), /still open/);
  assert.throws(() => reveal(s, "A", 3, nonce.A, revealDeadline(s) + 1), /too late/);
  reveal(s, "A", 3, nonce.A, revealDeadline(s));
  assert.throws(() => reveal(s, "A", 3, nonce.A, revealDeadline(s)), /already revealed/);
});

test("attack: bid more than the energy left, hidden in a commitment. It can't be revealed", () => {
  const s = opened(), nonce = rnd();
  commit(s, "A", 1, hashFor(s, "A", 31, nonce), 0);
  commit(s, "B", 1, hashFor(s, "B", 2, rnd()), 0);
  assert.throws(() => reveal(s, "A", 31, nonce, 1), /illegal bid/);
});

test("the seed step: A can't change its seed, and losing it costs A the first match, not B anything", () => {
  const seedA = rnd(), seedB = rnd();
  const s = openLotSeries(CONFIG, SERIES, seedCommitment(SERIES, seedA), seedB, 0);
  assert.throws(() => commit(s, "A", 1, rnd(), 0), /not a commit phase/, "no bid before the first prize is drawn");
  assert.throws(() => revealSeed(s, rnd(), 0), /isn't the committed seed/);
  assert.throws(() => timeout(s, revealDeadline(s)), /still open/);
  timeout(s, revealDeadline(s) + 1);
  assert.deepEqual(s.results[0], { winner: "B", reason: "missed_seed" });
  assert.equal(s.entropy, firstEntropy(SERIES, null, seedB));
  assert.throws(() => revealSeed(s, seedA, revealDeadline(s) + 2), /already in/);
  assert.equal(auditDraws(s), null);
  // A commitment from another series doesn't open here.
  const t = openLotSeries(CONFIG, SERIES, seedCommitment("77".repeat(32), seedA), seedB, 0);
  assert.throws(() => revealSeed(t, seedA, 0), /isn't the committed seed/);
});

/** How far each of `n` counts is from even, in standard deviations, at worst. */
function worstDeviation(counts: number[], total: number): number {
  const p = 1 / counts.length, sd = Math.sqrt(total * p * (1 - p));
  return Math.max(...counts.map((c) => Math.abs(c - total * p) / sd));
}

test("the draw is even over the prizes left, for every count left", () => {
  for (let n = 2; n <= 9; n++) {
    const left = Array.from({ length: n }, (_, i) => i + 1), counts = new Array<number>(n).fill(0), total = 20_000;
    let entropy = rnd();
    for (let i = 0; i < total; i++) {
      entropy = mixEntropy(entropy, rnd(), rnd());
      counts[drawFrom(entropy, 0, 2, left) - 1]!++;
    }
    assert.ok(worstDeviation(counts, total) < 5, `${n} left: ${counts.join(" ")}`);
  }
});

test("the draw moves with either nonce, either seed, the match and the round: nothing fixes it but all of them", () => {
  const left = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let i = 0; i < 200; i++) {
    const e = rnd(), a = rnd(), b = rnd();
    const base = mixEntropy(e, a, b);
    for (const other of [mixEntropy(e, rnd(), b), mixEntropy(e, a, rnd()), mixEntropy(rnd(), a, b), mixEntropy(e, b, a)]) assert.notEqual(other, base);
    const sa = rnd(), sb = rnd(), first = firstEntropy(SERIES, sa, sb);
    for (const other of [firstEntropy(SERIES, rnd(), sb), firstEntropy(SERIES, sa, rnd()), firstEntropy("77".repeat(32), sa, sb), firstEntropy(SERIES, null, sb)]) assert.notEqual(other, first);
  }
  // The same entropy draws independently for each match and round: over many entropies, the pair is as often equal as chance.
  let same = 0;
  const total = 9_000;
  for (let i = 0; i < total; i++) {
    const e = rnd();
    if (drawFrom(e, 0, 2, left) === drawFrom(e, 0, 3, left)) same++;
  }
  assert.ok(Math.abs(same - total / 9) < 5 * Math.sqrt(total * (1 / 9) * (8 / 9)), `${same} of ${total} equal`);
});

test("attack: grind a nonce for the prize you want. Without the opponent's nonce it's a guess: 1 in the prizes left", () => {
  const left = [1, 2, 3, 4, 5, 6, 7, 8, 9], want = 9, total = 3_000;
  let hits = 0;
  for (let i = 0; i < total; i++) {
    const entropy = rnd(), honest = rnd();
    // The attacker sees the entropy and the opponent's commitment (useless without the nonce in it). It tries 64 nonces
    // and keeps the one that draws its prize if the opponent's nonce were its best guess.
    const guess = "00".repeat(32);
    let mine = rnd();
    for (let k = 0; k < 64; k++) {
      const candidate = rnd();
      if (drawFrom(mixEntropy(entropy, candidate, guess), 0, 2, left) === want) {
        mine = candidate;
        break;
      }
    }
    if (drawFrom(mixEntropy(entropy, mine, honest), 0, 2, left) === want) hits++;
  }
  assert.ok(Math.abs(hits - total / 9) < 5 * Math.sqrt(total * (1 / 9) * (8 / 9)), `${hits} of ${total} hits, against ${Math.round(total / 9)} by chance`);
});

test("attack: B grinds its seed for the first prize. With A's seed hidden it's a guess too", () => {
  const prizes = CONFIG.rules.prizes, want = 9, total = 3_000;
  let hits = 0;
  for (let i = 0; i < total; i++) {
    const seedA = rnd();
    // B sees only A's commitment. It tries 64 seeds against its best guess of A's.
    let seedB = rnd();
    for (let k = 0; k < 64; k++) {
      const candidate = rnd();
      if (drawFrom(firstEntropy(SERIES, "00".repeat(32), candidate), 0, 1, prizes) === want) {
        seedB = candidate;
        break;
      }
    }
    if (opened(seedA, seedB).game!.prize === want) hits++;
  }
  assert.ok(Math.abs(hits - total / 9) < 5 * Math.sqrt(total * (1 / 9) * (8 / 9)), `${hits} of ${total} hits, against ${Math.round(total / 9)} by chance`);
});
