import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LINK_ID, linkVerdict, type LinkWatch } from "../lib/link/watch.ts";
import { battleTitle, battleVerdict, fromMatch, fromPractice, type MatchWatch } from "../lib/link/battle.ts";

// Link battles' practice page (docs/link-battles.md 13): its sample is the spectators' view of a real battle and never an
// agent's, live while it's on and with exact numbers only once it's over; the verdict names the fighter, never backs it.

const sample = JSON.parse(readFileSync(new URL("../lib/link/sample.json", import.meta.url), "utf8")) as LinkWatch[];

test("the sample is a finished battle and a live one, as the referee serves spectators", () => {
  assert.equal(sample.length, 2);
  const [over, live] = sample as [LinkWatch, LinkWatch];
  for (const w of sample) {
    assert.match(w.match, LINK_ID);
    const text = JSON.stringify(w);
    assert.doesNotMatch(text, /"legal"|"you":|"view"|"state"|"packed"|tokenHash/, `${w.match}: nothing of an agent's own view or the stored battle`);
  }
  assert.ok(over.ended && over.spectator && !over.spectator.live);
  assert.ok(over.spectator.sides.every((s) => typeof s.hp === "number"), "exact numbers once it's over");
  assert.ok(!live.ended && live.spectator?.live);
  assert.ok(live.spectator.sides.every((s) => s.hp === undefined && s.max_hp === undefined), "bars only while it's live");
  assert.equal(over.spectator.turns.length, over.turn, "every turn told");
});

test("the verdict says how it went in a sentence", () => {
  const base = sample[0]!;
  assert.equal(linkVerdict({ ...base, ended: null, turn: 4 }), "Live · turn 5");
  assert.equal(linkVerdict({ ...base, ended: { reason: "knockout", winner: "you" }, turn: 12 }), `${base.name} won in 12 turns.`);
  assert.equal(linkVerdict({ ...base, ended: { reason: "knockout", winner: "house" }, turn: 12 }), "The house won in 12 turns.");
  assert.equal(linkVerdict({ ...base, ended: { reason: "draw", winner: null }, turn: 200 }), "A draw after 200 turns.");
  assert.equal(linkVerdict({ ...base, ended: { reason: "void", winner: null, message: "Left early." } }), "No result: Left early.");
});

// ---------------------------------------------------------------- rated battles (14.7)


const rated = JSON.parse(readFileSync(new URL("../lib/link/sample-rated.json", import.meta.url), "utf8")) as { matches: MatchWatch[]; lobby: { live: unknown[]; recent: unknown[]; ladder: unknown } };

test("the rated sample is what spectators get: no view, no decision, bars while live, no real address", () => {
  const [over, live] = rated.matches as [MatchWatch, MatchWatch];
  const text = JSON.stringify(rated);
  assert.doesNotMatch(text, /"legal"|"you":|"view"|"decided"|"fallbacks"|"state"|"packed"|tokenHash|"seed"/, "nothing of a side's own view, the held decisions or the stored battle");
  assert.doesNotMatch(text, /[1-9A-HJ-NP-Za-km-z]{32,44}/, "no mint or wallet");
  assert.ok(!over.live && over.ended && over.spectator!.sides.every((s) => typeof s.hp === "number"), "exact numbers once it's over");
  assert.ok(live.live && !live.ended && live.spectator!.sides.every((s) => s.hp === undefined), "bars only while it's live");
  assert.ok(live.lines.every((l) => l.turn <= live.turn), "table talk only of turns already played");
  for (const m of rated.matches) assert.match(m.match, LINK_ID);
});

test("a rated battle reads the same way: the winner named, the left side first, the screens as it's played", () => {
  const [over, live] = rated.matches.map(fromMatch) as [ReturnType<typeof fromMatch>, ReturnType<typeof fromMatch>];
  assert.equal(battleTitle(over), "Wire Cat v Second");
  assert.match(battleVerdict(over), /^(Wire Cat|Second) won in \d+ turns\.$/);
  assert.equal(battleVerdict({ ...over, ended: { reason: "forfeit", winner: 1, message: "Wire Cat stopped answering." } }), "Second won: Wire Cat stopped answering.");
  assert.equal(over.screens, true);
  assert.equal(live.screens, true, "a live rated battle's screens are public as its turns are played (13.3)");
  // Practice keeps its own reading: the house named as the house, its screens as they're filmed.
  const p = fromPractice(sample[0]!);
  assert.equal(p.screens, true);
  assert.equal(battleTitle(p), `${sample[0]!.name} v the house`);
});
