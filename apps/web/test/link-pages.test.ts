import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LINK_ID, linkVerdict, type LinkWatch } from "../lib/link/watch.ts";

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
