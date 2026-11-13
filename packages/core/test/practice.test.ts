import { test } from "node:test";
import assert from "node:assert/strict";
import { houseMove, parsePracticeId, parsePracticePulls, playRound, practiceId, practicePath, replayPractice, startMatch, DUELS_1, type Practice } from "highwire-core/arena";

// Practice matches (arena/practice.ts): the id and the pulls are the whole match, for line_practice and the site's
// replay page alike.

const SEED = "0123456789abcdef0123456789abcdef";

/** Plays a whole practice match, pulling `pull` (or what's left) each round. */
function playOut(p: Practice, pull: number): number[] {
  const pulls: number[] = [];
  for (;;) {
    const { state } = replayPractice(p, pulls);
    if (state.ending) return pulls;
    pulls.push(Math.min(pull, state.energy[p.side]));
  }
}

test("a practice id round-trips, and only the right shape parses", () => {
  const p: Practice = { bot: "reader", side: "b", seed: SEED };
  assert.equal(practiceId(p), `p1.reader.b.${SEED}`);
  assert.deepEqual(parsePracticeId(practiceId(p)), p);
  for (const bad of ["p1.reader.c." + SEED, "p1.house.a." + SEED, "p2.even.a." + SEED, "p1.even.a." + SEED.slice(1), "p1.even.a." + SEED.toUpperCase()]) {
    assert.equal(parsePracticeId(bad), null, bad);
  }
});

test("the replay plays the house's real moves from the seed, with each round's energy", () => {
  for (const side of ["a", "b"] as const) {
    const p: Practice = { bot: "even", side, seed: SEED };
    const pulls = playOut(p, 4);
    const { state, energy, problem } = replayPractice(p, pulls);
    assert.equal(problem, null);
    assert.ok(state.ending);
    assert.equal(energy.length, pulls.length);
    // The same match, by hand.
    let s = startMatch(DUELS_1);
    pulls.forEach((mine, i) => {
      const house = houseMove("even", s, side === "a" ? "b" : "a", SEED);
      s = side === "a" ? playRound(s, mine, house) : playRound(s, house, mine);
      assert.deepEqual(energy[i], s.energy);
    });
    assert.deepEqual(s, state);
  }
});

test("a replay names the first pull it can't play", () => {
  const p: Practice = { bot: "reader", side: "a", seed: SEED };
  assert.match(replayPractice(p, [30, 30]).problem ?? "", /^Round 2: /);
  const pulls = playOut(p, 3);
  assert.match(replayPractice(p, [...pulls, 0]).problem ?? "", /ended after round/);
});

test("a finished match's path carries its id and pulls, and its pulls parse back", () => {
  const p: Practice = { bot: "reader", side: "a", seed: SEED };
  const pulls = playOut(p, 5);
  const path = practicePath(p, pulls);
  assert.equal(path, `/line/try/p1.reader.a.${SEED}/${pulls.join("-")}`);
  assert.deepEqual(parsePracticePulls(path.split("/").at(-1)!), pulls);
  for (const bad of ["", "3-", "-3", "3--4", "123", "3.4", "a", Array(16).fill(1).join("-")]) assert.equal(parsePracticePulls(bad), null, bad);
});
