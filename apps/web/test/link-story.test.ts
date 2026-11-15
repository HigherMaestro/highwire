import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { headline, momentum, scoreOf, storyOf, teamsAt, turnMoment, TEAM_SIZE } from "../lib/link/story.ts";
import type { MatchWatch } from "../lib/link/battle.ts";

// The story the spectator pages tell (lib/link/story.ts), on the rated sample: a real battle between the test fakes'
// fighters. Teams as pips, the score in Pokémon left, the momentum, and each turn's lines picked apart.

const rated = JSON.parse(readFileSync(new URL("../lib/link/sample-rated.json", import.meta.url), "utf8")) as { matches: MatchWatch[] };
const [over, live] = rated.matches as [MatchWatch, MatchWatch];
const labels = (m: MatchWatch): [string, string] => [`${m.sides[0]!.name}'s`, `${m.sides[1]!.name}'s`];

test("teams: three pips a side, in the order shown, the fainted struck, one out", () => {
  const t = teamsAt(over.spectator, null);
  for (const side of t) {
    assert.equal(side.length, TEAM_SIZE);
    assert.ok(side.filter((p) => p.active).length <= 1);
  }
  const winner = over.ended!.winner!;
  const s = scoreOf(t);
  assert.equal(s[1 - winner], 0, "the loser has none left");
  assert.ok(s[winner] > 0);
  // Before the first turn: one shown a side, full, and two unseen.
  const start = teamsAt(over.spectator, 0);
  for (const side of start) {
    assert.deepEqual(side.map((p) => p.species === null), [false, true, true]);
    assert.equal(side[0]!.hp, 100);
  }
});

test("a live battle's teams come only from what both sides have seen", () => {
  const t = teamsAt(live.spectator, null);
  const seen = live.spectator!.sides.map((s) => s.seen);
  for (const side of [0, 1] as const) {
    const shown = t[side].filter((p) => p.species).map((p) => p.species);
    assert.deepEqual(shown, seen[side], "the pips are the sides' seen lists, in order");
  }
});

test("momentum: a point a turn from the opening, falling as the fight goes on", () => {
  const m = momentum(over.spectator);
  assert.equal(m.length, over.turn + 1);
  assert.deepEqual(m[0]!.hp, [100, 100]);
  const loser = 1 - over.ended!.winner!;
  assert.equal(m.at(-1)!.hp[loser], 0);
});

test("a turn's lines: moves with what came of them, each given to its side", () => {
  const lines = ["Wire Cat's Charizard used Flamethrower.", "A critical hit!", "It's not very effective…", "Second's Blastoise used Surf.", "It's super effective!", "Wire Cat's Charizard fainted!", "Second's side sent out Venusaur.", "Second's Venusaur's attack missed."];
  const st = storyOf(lines, ["Wire Cat's", "Second's"]);
  assert.deepEqual(st.map((l) => [l.kind, l.side, l.chips]), [
    ["move", 0, ["crit", "resisted"]],
    ["move", 1, ["super"]],
    ["faint", 0, []],
    ["switch", 1, []],
    ["other", 1, []],
  ]);
  const m = turnMoment(st);
  assert.deepEqual([m[1].crit, m[0].super, m[0].fainted], [true, true, true], "the target of a crit or a super effective hit, and who fainted");
  assert.equal(headline(st), "A knockout");
  // A name that starts another's is still told apart (the longer label first).
  assert.equal(storyOf(["Wire Cat Two's Charizard used Slash."], ["Wire Cat's", "Wire Cat Two's"])[0]!.side, 1);
});

test("every sample turn reads: each move and faint has a side", () => {
  for (const t of over.spectator!.turns) for (const l of storyOf(t.lines, labels(over))) if (l.kind !== "other") assert.notEqual(l.side, null, l.text);
});
