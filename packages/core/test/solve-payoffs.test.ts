import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DUELS_1, MATCH_PAYOFFS, solve, solveMatrix, type ArenaRules, type Payoffs } from "../src/arena/index.ts";

// `solve` takes what a win, a draw and a loss are worth, for research (docs/research/series-equilibrium.md). The house
// and the referee never pass them, so the first test pins what they get: the tables as they were before the option
// existed, bit for bit. If it fails, Even's play has changed, and so has every replay of a house match. Other worths
// go through the careful simplex, which is right to about 1e-8 a state (it checks itself to 1e-6), not to the last bit.

test("the default tables are bit for bit what they were before the worths became an option", () => {
  const sol = solve(DUELS_1);
  const { places: D, energy: E, rounds: R } = DUELS_1;
  const values = createHash("sha256"), mixes = createHash("sha256");
  let states = 0;
  for (let r = 0; r < R; r++) for (let p = -(D - 1); p <= D - 1; p++) for (let a = 0; a <= E; a++) for (let b = 0; b <= E; b++) {
    values.update(new Uint8Array(Float64Array.of(sol.value(r, p, a, b)).buffer));
    const m = sol.mix(r, p, a, b);
    mixes.update(new Uint8Array(m.buffer, m.byteOffset, m.byteLength));
    states++;
  }
  assert.equal(states, 72_075);
  // Recorded from the solver at 70626d5, the commit before the option was added.
  assert.equal(values.digest("hex"), "be994b5aeb7e960c1bc1ff38726fd3ffabdf7a712c08bae621ccc7d6dddf1a07");
  assert.equal(mixes.digest("hex"), "527aa70f055af0b89a6f164970d6e4389a4c6035b5f84b98bbb6f2aac58722df");
  assert.deepEqual(sol.payoffs, MATCH_PAYOFFS);
  assert.equal(solve(DUELS_1, { win: 1, draw: 0, loss: -1 }), sol, "the default worths, spelled out, are the same cached table");
});

// A small game, so the other worths solve in milliseconds.
const SMALL: ArenaRules = { ...DUELS_1, id: "small", places: 2, energy: 6, regen: 1, rounds: 5 };
const start = (p: Payoffs) => solve(SMALL, p).value(0, 0, SMALL.energy, SMALL.energy);

test("other worths: the match stays zero-sum, scales, and is worth a sure thing when nothing is at stake", () => {
  assert.ok(Math.abs(start(MATCH_PAYOFFS)) < 1e-9, "symmetric worths: the start is worth nothing");
  // Whatever one side's worths, the other side's are the negatives, and the two values cancel.
  for (const p of [{ win: 1, draw: 1, loss: 0 }, { win: 0.8, draw: 0.3, loss: -0.5 }, { win: 1, draw: -1, loss: -1 }]) {
    assert.ok(Math.abs(start(p) + start({ win: -p.loss, draw: -p.draw, loss: -p.win })) < 1e-6, JSON.stringify(p));
  }
  // Doubling and shifting the worths doubles and shifts the value, whatever their range.
  const base = start({ win: 1, draw: 0.4, loss: -1 });
  assert.ok(Math.abs(start({ win: 2 - 3, draw: 0.8 - 3, loss: -2 - 3 }) - (2 * base - 3)) < 1e-6);
  assert.equal(start({ win: 0.25, draw: 0.25, loss: 0.25 }), 0.25);
  // A draw that counts as a win is worth more than a draw that counts as a loss.
  assert.ok(start({ win: 1, draw: 1, loss: -1 }) > 0.05 && start({ win: 1, draw: -1, loss: -1 }) < -0.05);
  assert.deepEqual(solve(SMALL, { win: 1, draw: 1, loss: 0 }).payoffs, { win: 1, draw: 1, loss: 0 });
});

test("other worths are solved afresh, never cached over the house's table, and must be numbers", () => {
  const odd = { win: 1, draw: 1, loss: 0 };
  assert.notEqual(solve(SMALL, odd), solve(SMALL, odd));
  assert.equal(solve(SMALL), solve(SMALL));
  assert.ok(Math.abs(solve(SMALL).value(0, 0, SMALL.energy, SMALL.energy)) < 1e-9, "the default table is still the default after the others");
  assert.throws(() => solve(SMALL, { win: 1, draw: Number.NaN, loss: -1 }), /finite/);
  assert.throws(() => solve(SMALL, { win: Infinity, draw: 0, loss: -1 }), /finite/);
});

test("the careful pivot rule gets textbook games right, and solves worths the house's rule fails on", () => {
  const rps = solveMatrix([[0, -1, 1], [1, 0, -1], [-1, 1, 0]], true);
  assert.ok(Math.abs(rps.value) < 1e-7);
  for (const w of [...rps.row, ...rps.col]) assert.ok(Math.abs(w - 1 / 3) < 1e-7);
  const pennies = solveMatrix([[1, -1], [-0.5, 0.5]], true);
  assert.ok(Math.abs(pennies.value) < 1e-7 && Math.abs(pennies.row[0]! - 1 / 3) < 1e-7 && Math.abs(pennies.col[0]! - 0.5) < 1e-7);
  assert.deepEqual(solveMatrix([[3, 1], [4, 2]], true), { value: 2, row: [0, 1], col: [0, 1] });
  // A match where a draw is as bad as a loss (the trailing side with one match left): the house's rule, given these
  // worths, pivots on rounding error in one state and reports the game unbounded. And its mirror, a draw as good as a
  // win: between them the two sides' values cancel.
  const behind = solve(DUELS_1, { win: 1, draw: -1, loss: -1 }), ahead = solve(DUELS_1, { win: 1, draw: 1, loss: -1 });
  const [b, a] = [behind.value(0, 0, 30, 30), ahead.value(0, 0, 30, 30)];
  assert.ok(Math.abs(a + b) < 1e-6, `${a} and ${b}`);
  assert.ok(Math.abs(a - 0.10775) < 1e-4, `${a}`);
  // A draw worth a hair more than half a win: nearly Even's own game, and nearly degenerate. A pivot rule that only
  // prefers large pivots still fails here; the nudged one doesn't.
  const hair = solve(DUELS_1, { win: 1, draw: 2 * 0.5000415932428188 - 1, loss: -1 }).value(0, 0, 30, 30);
  assert.ok(hair > 0 && hair < 2e-5, `${hair}`);
});
