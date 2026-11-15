import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beatsOf, colour, deepestDeficit, edgeOf, situation, tally, teamHp, turnCall, headline, highlights, leadSeries, momentum, scoreOf, stepsOf, storyOf, teamsAt, turnMoment, TEAM_SIZE } from "../lib/link/story.ts";
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

test("beats: each move with its species, each switch and faint with theirs, in the game's order", () => {
  const lines = ["Wire Cat's Charizard used Flamethrower.", "A critical hit!", "Second's Blastoise used Surf.", "It's super effective!", "Wire Cat's Charizard fainted!", "Wire Cat's side sent out Venusaur."];
  const L: [string, string] = ["Wire Cat's", "Second's"];
  const b = beatsOf(storyOf(lines, L), L);
  assert.deepEqual(
    b.map((x) => [x.kind, "side" in x ? x.side : null, "species" in x ? x.species : null, x.kind === "move" ? x.move : null]),
    [
      ["move", 0, "Charizard", "Flamethrower"],
      ["move", 1, "Blastoise", "Surf"],
      ["faint", 0, "Charizard", null],
      ["switch", 0, "Venusaur", null],
    ],
  );
});

test("steps: every sample turn ends on its own sides, and no bar ever rises within a turn but by a switch", () => {
  for (const m of [over, live]) {
    const s = m.spectator!;
    const L = labels(m);
    let before = s.start!;
    for (const t of s.turns) {
      const steps = stepsOf(before, t.after!, beatsOf(storyOf(t.lines, L), L), teamsAt(s, t.turn - 1));
      if (steps.length) assert.deepEqual(steps.at(-1)!.sides, t.after, `turn ${t.turn} settles on its sides`);
      let cur = before;
      for (const st of steps.slice(0, -1)) {
        for (const side of [0, 1] as const) {
          if (st.beat.kind === "switch" && st.beat.side === side) continue;
          if (st.sides[side].species === cur[side].species) assert.ok(st.sides[side].hp_percent <= cur[side].hp_percent, `turn ${t.turn}: a bar only falls`);
        }
        if (st.hit) assert.ok(st.hit.amount > 0);
        cur = st.sides;
      }
      before = t.after!;
    }
  }
});

test("steps: a side's loss lands on the last move that hit it, a faint empties the bar", () => {
  const side = (species: string, hp: number) => ({ species, level: 50, hp_percent: hp, status: null, field: [], seen: [species], fainted: 0 });
  const L: [string, string] = ["A's", "B's"];
  const beats = beatsOf(storyOf(["A's Charizard used Slash.", "B's Venusaur used Razor Leaf.", "B's Venusaur fainted!"], L), L);
  const steps = stepsOf([side("Charizard", 80), side("Venusaur", 40)], [side("Charizard", 70), side("Venusaur", 0)], beats, [[], []]);
  assert.deepEqual(steps.map((x) => x.hit), [{ side: 1, amount: 40 }, { side: 0, amount: 10 }, null]);
  assert.equal(steps[2]!.sides[1].hp_percent, 0);
});

test("the lead and the highlights: knockouts and changes of lead, each for the side it was good for", () => {
  const s = over.spectator!;
  const L = labels(over);
  const lead = leadSeries(momentum(s), 0);
  assert.equal(lead[0]!.lead, 0);
  const h = highlights(s, L, 0);
  const kos = h.filter((x) => x.kind === "ko");
  assert.equal(kos.length, s.turns.flatMap((t) => storyOf(t.lines, L)).filter((l) => l.kind === "faint").length);
  for (const x of h) assert.ok(x.turn >= 1 && x.turn <= over.turn);
  assert.ok(deepestDeficit(s, over.ended!.winner!) >= 0);
});

test("the edge and the commentary: from the stage alone, the same whoever has decided", () => {
  const side = (species: string, hp: number) => ({ species, level: 50, hp_percent: hp, status: null, field: [], seen: [species], fainted: 0 });
  const pip = (species: string | null, hp: number, fainted = false, active = false) => ({ species, hp, fainted, active });
  // Two shown (one fainted), one unseen; the one out at 40.
  assert.equal(teamHp([pip("Charizard", 0, true), pip("Blastoise", 60, false, true), pip(null, 100)], side("Blastoise", 40)), 140);
  // One that came in this turn, before the pips have it: it's one of the unseen.
  assert.equal(teamHp([pip("Charizard", 30, false, true), pip(null, 100), pip(null, 100)], side("Venusaur", 100)), 230);
  assert.equal(edgeOf(150, 50), 75);
  assert.equal(edgeOf(0, 0), 50);
  const says = situation(["Wire Cat", "Second"], [2, 3], [side("Blastoise", 71), side("Blastoise", 15)], [171, 215]);
  assert.deepEqual(says, ["Second leads 3–2 in Pokémon left.", "Second's Blastoise is hanging on at 15%.", "Second is ahead by 44 points of team HP."]);
  // The score one way, the HP the other: one sentence says both, and the HP isn't said again.
  assert.deepEqual(situation(["Wire Cat", "Second"], [2, 3], [side("Blastoise", 71), side("Blastoise", 60)], [171, 130]), ["Second has 3 Pokémon left to Wire Cat's 2, but Wire Cat has more HP overall."]);
  assert.deepEqual(situation(["A", "B"], [3, 3], [side("X", 100), side("Y", 100)], [300, 300]), ["Level at 3 Pokémon each.", "Nothing between them on HP."]);
});

test("more to say while they choose: from the turns played, each line about what's public", () => {
  const s = live.spectator!;
  const lines = colour(s, [live.sides[0]!.name, live.sides[1]!.name], labels(live), teamsAt(s, null), [480, 95]);
  assert.ok(lines.length >= 3, "a pool worth rotating");
  assert.ok(lines.some((l) => /needs \d more knockouts?\./.test(l)));
  assert.ok(lines.some((l) => l.includes("1:35 left on its clock")), "a clock under two minutes is said");
  assert.equal(lines.at(-1), "Neither agent can see the other's choice until both are in.");
  assert.equal(new Set(lines).size, lines.length, "no line twice");
  assert.deepEqual(colour(null, ["A", "B"], ["A's", "B's"], [[], []], null), []);
});

test("a turn in one sentence, and a finished battle in numbers that name no winner", () => {
  const L: [string, string] = ["A's", "B's"];
  assert.equal(turnCall(storyOf(["A's Charizard used Slash.", "B's Venusaur used Razor Leaf.", "A's Charizard fainted!"], L)), "A's Charizard fainted!");
  assert.equal(turnCall(storyOf(["A's Charizard used Slash.", "B's Venusaur used Razor Leaf."], L)), "B's Venusaur used Razor Leaf.");
  const t = tally(over.spectator, labels(over), over.turn);
  assert.match(t, /^\d knockouts · (\d lead changes? · )?22 turns$/);
  assert.ok(!t.includes(over.sides[0]!.name) && !t.includes(over.sides[1]!.name));
});

test("a fighter's sigil: the same mint the same mark, mirrored, and a shape", async () => {
  const { sigilCells } = await import("../lib/link/sigil.ts");
  const a = sigilCells("So11111111111111111111111111111111111111112"), b = sigilCells("So11111111111111111111111111111111111111112");
  assert.deepEqual(a, b);
  for (const id of ["a", "b", "mint-one", "mint-two", "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"]) {
    const cells = sigilCells(id);
    assert.ok(cells.length >= 5 && cells.length <= 25);
    const has = new Set(cells.map(([x, y]) => `${x},${y}`));
    for (const [x, y] of cells) assert.ok(has.has(`${4 - x},${y}`), "mirrored left to right");
  }
  assert.notDeepEqual(sigilCells("mint-one"), sigilCells("mint-two"));
  assert.equal(sigilCells(null).length, 13, "the house's H");
});
