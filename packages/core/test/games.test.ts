import { test } from "node:test";
import assert from "node:assert/strict";
import { bidProblem, drawPrize, lotGames, playLot, replayLot, solveLot, startLot, type LotRules } from "../scripts/games/lot.ts";
import { WIRES_DRAFT, playWires, replayWires, solveWires, splitProblem, splits, startWires, type WiresRules } from "../scripts/games/wires.ts";

// The two prototype games (docs/research/new-games.md): their rules, and each one's exact solution on a small size.

const SMALL_LOT: LotRules = { id: "lot-test", prizes: [1, 2, 3, 4], energy: 8 };

function mulberry(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

test("the lot: the bigger bid takes the prize, a tie burns it, and both pay", () => {
  let s = startLot(SMALL_LOT, 3);
  assert.deepEqual(s.left, [1, 2, 4]);
  s = playLot(s, 2, 1, 4);
  assert.deepEqual(s.score, { a: 3, b: 0 });
  assert.deepEqual(s.energy, { a: 6, b: 7 }, "both pay, and nothing comes back");
  assert.deepEqual(s.rounds[0], { prize: 3, bid: { a: 2, b: 1 }, winner: "a" });
  s = playLot(s, 3, 3, 1);
  assert.deepEqual(s.score, { a: 3, b: 0 }, "a tie burns the prize");
  assert.equal(s.rounds[1]!.winner, null);
  assert.deepEqual(s.energy, { a: 3, b: 4 });
  assert.deepEqual(s.left, [2]);
});

test("the lot: a bid is a whole number from 0 to the energy left", () => {
  const s = startLot(SMALL_LOT, 1);
  assert.equal(bidProblem(s, "a", 8), null);
  assert.match(bidProblem(s, "a", 9)!, /8 energy left/);
  assert.match(bidProblem(s, "a", -1)!, /negative/);
  assert.match(bidProblem(s, "a", 1.5)!, /whole number/);
  assert.throws(() => playLot(s, 9, 0, 2), /a: a bid can't be more/);
  assert.throws(() => playLot(s, 0, 0, 1), /isn't left/, "the prize on offer can't be offered again");
  assert.throws(() => playLot(s, 0, 0), /needs the next prize/);
});

test("the lot: it ends when the side behind can't catch up, or when the prizes run out", () => {
  // 4 then 3 to a: 7 against the 3 still open.
  let s = playLot(playLot(startLot(SMALL_LOT, 4), 1, 0, 3), 1, 0, 2);
  assert.deepEqual(s.ending, { winner: "a", reason: "decided" });
  assert.equal(s.prize, null);
  assert.match(bidProblem(s, "a", 0)!, /over/);
  // Every prize tied: a draw.
  s = replayLot(SMALL_LOT, [{ prize: 1, a: 0, b: 0 }, { prize: 2, a: 0, b: 0 }, { prize: 3, a: 0, b: 0 }, { prize: 4, a: 0, b: 0 }]);
  assert.deepEqual(s.ending, { winner: null, reason: "draw" });
  // Level until the last prize decides it.
  s = replayLot(SMALL_LOT, [{ prize: 4, a: 1, b: 0 }, { prize: 3, a: 0, b: 1 }, { prize: 1, a: 0, b: 1 }, { prize: 2, a: 0, b: 1 }]);
  assert.deepEqual(s.ending, { winner: "b", reason: "outscored" });
  assert.throws(() => replayLot(SMALL_LOT, [{ prize: 1, a: 0, b: 0 }, { prize: 1, a: 0, b: 0 }]), /isn't left/);
});

test("the lot: random matches all end, and replay to the same state", () => {
  const rules: LotRules = { id: "lot-test-9", prizes: [1, 2, 3, 4, 5, 6, 7, 8, 9], energy: 30 };
  const r = mulberry(7);
  for (let i = 0; i < 500; i++) {
    let s = startLot(rules, drawPrize(rules.prizes, r()));
    while (!s.ending) {
      s = playLot(s, Math.floor(r() * (s.energy.a + 1)), Math.floor(r() * (s.energy.b + 1)), s.left.length ? drawPrize(s.left, r()) : undefined);
    }
    assert.ok(s.rounds.length <= rules.prizes.length);
    const again = replayLot(rules, s.rounds.map((x) => ({ prize: x.prize, a: x.bid.a, b: x.bid.b })));
    assert.deepEqual(again, s);
  }
});

test("the lot's solution: the start is worth 0, and no bid beats the equilibrium's mix", () => {
  const sol = solveLot(SMALL_LOT);
  assert.equal(sol.games, lotGames(SMALL_LOT), "the count matches the solve");
  const r = mulberry(3);
  for (let i = 0; i < 40; i++) {
    // A state part-way through a random match.
    let s = startLot(SMALL_LOT, drawPrize(SMALL_LOT.prizes, r()));
    for (let k = Math.floor(r() * 3); k > 0 && !s.ending; k--) {
      s = playLot(s, Math.floor(r() * (s.energy.a + 1)), Math.floor(r() * (s.energy.b + 1)), s.left.length ? drawPrize(s.left, r()) : undefined);
    }
    if (s.ending) continue;
    const value = sol.value(s, "a"), mix = sol.mix(s, "a");
    assert.ok(Math.abs(value + sol.value(s, "b")) < 1e-6, "zero-sum: the two views add to 0");
    assert.equal(mix.length, s.energy.a + 1);
    assert.ok(Math.abs(mix.reduce((x, y) => x + y, 0) - 1) < 1e-6, "the mix is a distribution");
    for (let j = 0; j <= s.energy.b; j++) {
      let against = 0;
      for (let b = 0; b < mix.length; b++) if (mix[b]! > 0) against += mix[b]! * sol.after(s, "a", b, j);
      assert.ok(against >= value - 1e-6, `bidding ${j} holds the mix to ${against}, under the value ${value}`);
    }
  }
  for (const first of SMALL_LOT.prizes) assert.ok(Math.abs(sol.value(startLot(SMALL_LOT, first), "a")) < 1e-9, "symmetric at the start");
});

test("three wires: each wire moves toward the bigger pull, and both pay it all", () => {
  let s = startWires();
  s = playWires(s, [5, 0, 2], [3, 4, 2]);
  assert.deepEqual(s.nodes, [-1, 1, 0], "a pulls toward the negative end; a tie leaves the node");
  assert.deepEqual(s.energy, { a: 26, b: 24 }, "both pay everything, then regain 3");
  s = playWires(s, [0, 0, 0], [0, 0, 0]);
  assert.deepEqual(s.energy, { a: 29, b: 27 });
  s = playWires(s, [0, 0, 0], [0, 0, 0]);
  assert.deepEqual(s.energy, { a: 30, b: 30 }, "never above the cap");
});

test("three wires: a split is one whole pull per wire, within the energy, and never on a taken wire", () => {
  let s = startWires();
  assert.equal(splitProblem(s, "a", [10, 10, 10]), null);
  assert.match(splitProblem(s, "a", [10, 10, 11])!, /30 energy left/);
  assert.match(splitProblem(s, "a", [1, 2])!, /3 pulls/);
  assert.match(splitProblem(s, "a", [1, -1, 0])!, /whole number/);
  s = playWires(playWires(s, [1, 0, 0], [0, 0, 0]), [1, 0, 0], [0, 0, 0]);
  assert.deepEqual(s.nodes, [-2, 0, 0]);
  assert.match(splitProblem(s, "b", [1, 0, 0])!, /wire 1 is taken/);
  assert.equal(splitProblem(s, "b", [0, 1, 1]), null);
  assert.throws(() => playWires(s, [1, 0, 0], [0, 0, 0]), /a: wire 1 is taken/);
});

test("three wires: two taken wins at once; when the rounds run out, more wires held wins", () => {
  const two = replayWires(WIRES_DRAFT, [[[1, 1, 0], [0, 0, 5]], [[1, 1, 0], [0, 0, 5]]]);
  assert.deepEqual(two.ending, { winner: "a", reason: "took_most" });
  assert.equal(two.rounds.length, 2);
  const short: WiresRules = { ...WIRES_DRAFT, id: "wires-test", rounds: 2 };
  assert.deepEqual(replayWires(short, [[[1, 0, 0], [0, 1, 1]], [[0, 0, 0], [0, 0, 0]]]).ending, { winner: "b", reason: "rounds_up" });
  assert.deepEqual(replayWires(short, [[[1, 0, 0], [0, 1, 0]], [[0, 0, 0], [0, 0, 0]]]).ending, { winner: null, reason: "draw" });
  assert.equal(replayWires(short, [[[1, 0, 0], [0, 1, 0]]]).ending, null);
});

test("three wires: random matches all end, and replay to the same state", () => {
  const r = mulberry(11);
  for (let i = 0; i < 500; i++) {
    let s = startWires();
    while (!s.ending) {
      const move = (energy: number) => {
        const out = [0, 0, 0];
        for (let left = Math.floor(r() * (energy + 1)); left > 0; left--) {
          const w = Math.floor(r() * 3);
          if (Math.abs(s.nodes[w]!) < s.rules.places) out[w]!++;
        }
        return out;
      };
      s = playWires(s, move(s.energy.a), move(s.energy.b));
    }
    assert.ok(s.rounds.length <= WIRES_DRAFT.rounds);
    assert.deepEqual(replayWires(WIRES_DRAFT, s.rounds.map((x) => [x.pull.a, x.pull.b])), s);
  }
});

test("three wires: the moves a side has, and a small game's exact value", () => {
  assert.equal(splits(30, 3), 5456, "the draft's splits at full energy");
  assert.equal(splits(2, 3), 10);
  const sol = solveWires({ id: "wires-test", wires: 3, places: 2, energy: 4, regen: 1, rounds: 4 });
  assert.ok(Math.abs(sol.value) < 1e-9, "symmetric at the start");
  assert.equal(sol.biggest, 35 * 35, "every split of 4 energy against every split");
});
