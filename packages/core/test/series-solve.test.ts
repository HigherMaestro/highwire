import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BEST_OF_5, DUELS_1, MATCH_PAYOFFS, commit, fallbackCommitment, moveCommitment, pullFrom, pullProblem, reveal, revealDeadline, seriesPull, seriesResult,
  seriesScore, seriesScores, sideOf, solve, solveSeries, startSeries, timeout, type Player, type SeriesScore, type SeriesState,
} from "../src/arena/index.ts";
import { bestResponse, matchOdds, scoreKey, seriesOdds, seriesValues, strategyOf } from "../src/arena/series-solve.ts";

// The wager series solved (docs/research/series-equilibrium.md). What the documents now promise rests on two facts
// checked here from the outside, with nothing taken from the solver's own word: no player that knows the score does
// better than 0 against the series equilibrium, and one does about 8% of the stake better against the house's Even.

const CONFIG = { rules: DUELS_1, revealSeconds: 120 };
const ID = "22".repeat(32), SALT = "33".repeat(32), NONCE = "44".repeat(32);
const start = (): SeriesState =>
  startSeries(CONFIG, ID, { A: fallbackCommitment(ID, "A", { kind: "zero" }, SALT), B: fallbackCommitment(ID, "B", { kind: "zero" }, SALT) }, 0);

/** Ends the match in play for `winner` (the other side never reveals), or with no winner (neither does). */
function endMatch(s: SeriesState, winner: Player | null, at: number): number {
  const round = s.game.rounds.length + 1, match = s.match;
  for (const p of ["A", "B"] as const) commit(s, p, round, moveCommitment(ID, match, round, sideOf(p, match), 3, NONCE), at);
  if (winner) reveal(s, winner, { pull: 3, nonce: NONCE }, at + 1);
  const after = revealDeadline(s) + 1;
  timeout(s, after);
  return after + 1;
}

test("the score and the result agree with the series as the program plays it, for every way five matches can go", () => {
  let checked = 0;
  for (let code = 0; code < 3 ** 5; code++) {
    const s = start();
    let at = 0;
    for (let m = 0, c = code; m < 5 && !s.ending; m++, c = Math.floor(c / 3)) {
      for (const p of ["A", "B"] as const) assert.equal(seriesResult(seriesScore(s, p)), null, "still on");
      at = endMatch(s, ([null, "A", "B"] as const)[c % 3]!, at);
    }
    assert.ok(s.ending);
    const a = seriesScore(s, "A"), b = seriesScore(s, "B");
    assert.deepEqual([b.mine, b.theirs, b.left], [a.theirs, a.mine, a.left]);
    assert.equal(seriesResult(a), s.ending.winner === "A" ? 1 : s.ending.winner === "B" ? -1 : 0, JSON.stringify(a));
    assert.equal(seriesResult(b), -seriesResult(a)! || 0);
    checked++;
  }
  assert.equal(checked, 243);
  // 25 scores are still on, and each of them leads only to scores that are on or decided.
  const on = seriesScores();
  assert.equal(on.length, 25);
  assert.ok(on.every((s) => seriesResult(s) === null && s.mine + s.theirs + s.left <= 5));
  assert.deepEqual(BEST_OF_5, { matches: 5, wins: 3 });
});

const mirrored = (s: SeriesScore): SeriesScore => ({ mine: s.theirs, theirs: s.mine, left: s.left });
const START: SeriesScore = { mine: 0, theirs: 0, left: 5 };

test("the series equilibrium: worth 0, the house's game when level, another game when a draw would settle it", () => {
  const sol = solveSeries();
  assert.equal(solveSeries(DUELS_1), sol, "solved once");
  assert.equal(sol.value(START), 0);
  assert.equal(sol.tables, 11);
  assert.ok(sol.symmetryGap < 1e-6, `${sol.symmetryGap}`);
  for (const s of seriesScores()) {
    assert.equal(sol.value(s), -sol.value(mirrored(s)) || 0, scoreKey(s));
    assert.ok(Math.abs(sol.drawWorth(s) + sol.drawWorth(mirrored(s)) - 1) < 1e-9, "a draw is worth to one side what it costs the other");
    if (s.mine === s.theirs) assert.equal(sol.drawWorth(s), 0.5);
    if (s.mine > s.theirs) assert.ok(sol.value(s) > 0 && sol.drawWorth(s) > 0.5, scoreKey(s));
    const mix = sol.mix(s, 0, 0, 30, 30);
    assert.equal(mix.length, 31);
    assert.ok(Math.abs(mix.reduce((n, w) => n + w, 0) - 1) < 1e-5 && mix.every((w) => w >= 0));
  }
  // One up with one to play: a draw wins the series, so it is worth a win, and the series is worth 0.5539 to the leader
  // (two Evens would give it 0.5584: the trailer, knowing a draw is no use to it, takes the draws away).
  const ahead: SeriesScore = { mine: 1, theirs: 0, left: 1 };
  assert.equal(sol.drawWorth(ahead), 1);
  assert.ok(Math.abs(sol.value(ahead) - 0.5539) < 2e-4, `${sol.value(ahead)}`);
  const odds = matchOdds(sol.strategy(ahead), sol.strategy(mirrored(ahead)));
  assert.ok(odds.draw < 0.04, `${odds.draw}`);
  assert.ok(Math.abs(odds.win + odds.draw - sol.value(ahead)) < 1e-4, "the leader takes the series by winning or drawing the match");
  assert.throws(() => sol.value({ mine: 3, theirs: 0, left: 2 }), /no such score/);
  assert.throws(() => sol.mix(START, 15, 0, 30, 30), /no such state/);
  assert.throws(() => sol.mix(START, 0, 0, 31, 30), /no such state/);
});

test("nothing that knows the score beats the series equilibrium, from any score; the same player beats Even by 8% of the stake", () => {
  const sol = solveSeries();
  // The best reply to it, built from the last match back like the equilibrium itself but with no game solved: against
  // a fixed mix every state is a plain maximum.
  const best = seriesValues((s, next) => bestResponse(sol.strategy(mirrored(s)), next).value);
  for (const s of seriesScores()) assert.ok(Math.abs(best.get(scoreKey(s))! - sol.value(s)) < 1e-5, `${scoreKey(s)}: ${best.get(scoreKey(s))} against ${sol.value(s)}`);
  assert.ok(Math.abs(best.get(scoreKey(START))!) < 1e-6);

  // The house's Even, blind to the score. One match: nothing to speak of. A series: 0.0832 stakes.
  const even = strategyOf(solve(DUELS_1));
  const single = bestResponse(even, MATCH_PAYOFFS).value;
  assert.ok(single >= 0 && single < 0.001, `${single}`);
  const againstEven = seriesValues((_s, next) => bestResponse(even, next).value);
  assert.ok(Math.abs(againstEven.get(scoreKey(START))! - 0.0832) < 5e-4, `${againstEven.get(scoreKey(START))}`);
  // And the equilibrium gives Even nothing back: it holds its own against it at every score.
  const odds = seriesOdds((s) => matchOdds(sol.strategy(s), even));
  for (const s of seriesScores()) {
    const o = odds.get(scoreKey(s))!;
    assert.ok(o.win - o.loss > sol.value(s) - 1e-3, scoreKey(s));
  }
  // A rake comes out of the winner's side only.
  const raked = seriesValues((_s, next) => bestResponse(even, next).value, { fee: 0.025 });
  assert.ok(Math.abs(raked.get(scoreKey(START))! - 0.0627) < 5e-4, `${raked.get(scoreKey(START))}`);
});

test("seriesPull draws a legal pull from the score's mix, the same for the same number, and needs a number it can use", () => {
  const sol = solveSeries();
  const s = start();
  // A wins the first match, so the two players are no longer playing the same game.
  let at = endMatch(s, "A", 0);
  assert.deepEqual(seriesScore(s, "A"), { mine: 1, theirs: 0, left: 4 });
  for (const p of ["A", "B"] as const) {
    const side = sideOf(p, s.match);
    const counts = new Array<number>(31).fill(0), n = 2_000;
    for (let i = 0; i < n; i++) {
      const pull = seriesPull(s, p, (i + 0.5) / n);
      assert.equal(pullProblem(s.game, side, pull), null);
      counts[pull]!++;
    }
    const mix = sol.mix(seriesScore(s, p), 0, 0, 30, 30);
    for (let pull = 0; pull <= 30; pull++) assert.ok(Math.abs(counts[pull]! / n - mix[pull]!) < 2e-3, `${p} pull ${pull}`);
    assert.equal(seriesPull(s, p, 0.25), seriesPull(s, p, 0.25, sol));
  }
  // The leader and the trailer don't open alike, and neither opens as Even does.
  const lead = sol.mix({ mine: 1, theirs: 0, left: 4 }, 0, 0, 30, 30), trail = sol.mix({ mine: 0, theirs: 1, left: 4 }, 0, 0, 30, 30);
  assert.ok(lead[3]! > trail[3]! + 0.002, `${lead[3]} and ${trail[3]}`);
  assert.equal(pullFrom([0, 0.5, 0.5], 0.49), 1);
  assert.equal(pullFrom([0, 0.5, 0.5], 0.5), 2);
  assert.equal(pullFrom([0, 2, 6], 0.24), 1);
  for (const u of [1, -0.1, Number.NaN]) assert.throws(() => seriesPull(s, "A", u), /from 0 up to/);
  while (!s.ending) at = endMatch(s, "A", at);
  assert.throws(() => seriesPull(s, "A", 0.5), /over/);
});
