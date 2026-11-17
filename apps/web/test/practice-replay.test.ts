import { test } from "node:test";
import assert from "node:assert/strict";
import { practicePath, replayPractice, type Practice } from "highwire-core/arena";
import { AGENT, practiceMatch } from "../lib/arena/practice.ts";

// The practice replay page's data (/line/try/<id>/<pulls>): only a finished match whose every pull was legal.

const SEED = "fedcba9876543210fedcba9876543210";

function playOut(p: Practice, pull: number): number[] {
  const pulls: number[] = [];
  for (;;) {
    const { state } = replayPractice(p, pulls);
    if (state.ending) return pulls;
    pulls.push(Math.min(pull, state.energy[p.side]));
  }
}

test("a finished practice match rebuilds from its link, the house on its own side", () => {
  for (const side of ["a", "b"] as const) {
    const p: Practice = { bot: "reader", side, seed: SEED };
    const pulls = playOut(p, 4);
    const [, , , id, part] = practicePath(p, pulls).split("/");
    const got = practiceMatch(id!, part!);
    assert.ok(got);
    assert.equal(got.path, practicePath(p, pulls));
    const m = got.match;
    assert.equal(m.sides[side].name, AGENT);
    assert.equal(m.sides[side === "a" ? "b" : "a"].kind, "house");
    assert.deepEqual(m.rounds.map((r) => r[side].pull), pulls);
    assert.ok(m.ending);
    assert.deepEqual(m.rounds.at(-1)!.energy, m.energy);
  }
});

test("an unfinished, illegal or malformed match has no page", () => {
  const p: Practice = { bot: "even", side: "a", seed: SEED };
  const pulls = playOut(p, 3);
  const id = `p1.even.a.${SEED}`;
  assert.ok(practiceMatch(id, pulls.join("-")));
  assert.ok(practiceMatch(encodeURIComponent(id), pulls.join("-")), "an encoded id still reads");
  assert.equal(practiceMatch(id, pulls.slice(0, -1).join("-")), null, "unfinished");
  assert.equal(practiceMatch(id, [...pulls, 0].join("-")), null, "a pull past the end");
  assert.equal(practiceMatch(id, "30-30"), null, "more than the energy left");
  assert.equal(practiceMatch("p1.even.x." + SEED, pulls.join("-")), null);
  assert.equal(practiceMatch(id, "a-b"), null);
});
