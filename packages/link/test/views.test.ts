import { test } from "node:test";
import assert from "node:assert/strict";
import { type Field, type GameData, houseChoice, hpBar, type Mon, narrate, playerView, RIG_VERSION, type SideFacts, spectatorView, type Turn } from "highwire-link";

// The views without the game (docs/link-battles.md 6.1, 13.2): synthetic facts and turns, and fake names. The rule under
// test is the referee's first: a side sees its own screen and never more, and spectators see only what both sides do.

const SPECIES: Record<number, string> = { 1: "Sparky", 2: "Pebble", 3: "Hidden", 4: "Splash" };
const MOVES: Record<number, { name: string; pp: number; power: number; type: number; accuracy: number }> = {
  10: { name: "Zap", pp: 15, power: 90, type: 23, accuracy: 100 },
  11: { name: "Tackle", pp: 35, power: 35, type: 0, accuracy: 95 },
  12: { name: "Growl", pp: 40, power: 0, type: 0, accuracy: 100 },
  13: { name: "Water Gun", pp: 25, power: 40, type: 21, accuracy: 100 },
};
const names = { species: (id: number) => SPECIES[id] ?? `#${id}`, move: (id: number) => MOVES[id] ?? null };

const field = (on: Partial<Field> = {}): Field => ({
  confused: false, substitute: false, seeded: false, reflect: false, lightScreen: false, badlyPoisoned: false,
  transformed: false, recharging: false, mist: false, focusEnergy: false, ...on,
});
const mon = (species: number, hp: number, maxHp: number, extra: Partial<Mon> = {}): Mon => ({
  species, level: 50, hp, maxHp, status: 0, types: [23, 23], stages: [7, 7, 7, 7, 7, 7], field: field(), ...extra,
});

/** Side 0's own facts: Sparky out, Splash in reserve; the other side's active is Pebble at an exact 123 of 211. */
const facts0: SideFacts = {
  team: [
    { species: 1, level: 50, hp: 90, maxHp: 140, status: 0, types: [23, 23], moves: [10, 11, 0, 0], pp: [7, 30, 0, 0] },
    { species: 4, level: 48, hp: 130, maxHp: 130, status: 0, types: [21, 21], moves: [13, 0, 0, 0], pp: [25, 0, 0, 0] },
  ],
  out: 0,
  mine: mon(1, 77, 140, { stages: [8, 7, 7, 7, 7, 7] }),
  theirs: mon(2, 123, 211, { types: [4, 5], field: field({ reflect: true }) }),
  mineMoves: [10, 11, 0, 0],
};

const turn1: Turn = {
  turn: 1,
  decisions: [{ kind: "move", slot: 0 }, { kind: "move", slot: 1 }],
  events: [
    { kind: "acts", side: 1 },
    { kind: "used", side: 1, move: 11 },
    { kind: "resolved", side: 1, move: 11, missed: false, critical: true, effectiveness: 10, damage: 13 },
    { kind: "acts", side: 0 },
    { kind: "used", side: 0, move: 10 },
    { kind: "resolved", side: 0, move: 10, missed: true, critical: false, effectiveness: 0, damage: 0 },
  ],
  sides: [
    { species: [1, 1], hp: [90, 77], maxHp: 140, status: [0, 0], stages: [1, 0, 0, 0, 0, 0], fieldOn: [], fieldOff: [], switched: false, fainted: false },
    { species: [2, 2], hp: [211, 123], maxHp: 211, status: [0, 0], stages: [0, 0, 0, 0, 0, 0], fieldOn: ["reflect"], fieldOff: [], switched: false, fainted: false },
  ],
};

test("a side's view holds its own numbers and never the other side's exact HP, PP or unrevealed team", () => {
  const v = playerView({ side: 0, phase: "choose", turn: 1, facts: facts0, legal: { kind: "turn", moves: [0, 1], fight: false, switches: [1] }, turns: [turn1], opening: [1, 2], names });
  assert.equal(v.you.team[0]!.hp, 77, "the active Pokémon's HP is the battle's, not the party record's");
  assert.deepEqual(v.you.team[0]!.moves, [{ name: "Zap", pp: 7, max_pp: 15 }, { name: "Tackle", pp: 30, max_pp: 35 }]);
  assert.equal(v.them.hp_percent, hpBar(123, 211));
  assert.deepEqual(v.them.seen, ["Pebble"]);
  assert.deepEqual(v.them.field, ["Reflect"]);
  assert.deepEqual(v.you.stages, { Attack: 1 });
  const json = JSON.stringify(v);
  assert.doesNotMatch(json, /\b123\b|\b211\b/, "the other side's exact HP");
  assert.doesNotMatch(json, /Hidden/, "a Pokémon the other side hasn't shown");
  assert.doesNotMatch(json, /decisions/, "any decision, the other side's included");
  assert.deepEqual(v.legal.map((l) => l.label), ["Zap", "Tackle", "switch to Splash"]);
});

test("a side that isn't asked is shown no actions", () => {
  const v = playerView({ side: 0, phase: "waiting", turn: 1, facts: facts0, legal: null, turns: [turn1], opening: [1, 2], names });
  assert.deepEqual(v.legal, []);
});

test("spectators see bars while it's live, exact numbers once it's over, and never a decision", () => {
  const live = spectatorView({ live: true, turn: 1, facts0, turns: [turn1], opening: [1, 2], names, labels: ["Alpha's", "Beta's"] });
  const json = JSON.stringify(live);
  assert.doesNotMatch(json, /\b123\b|\b211\b|\b77\b/, "exact HP while live");
  assert.doesNotMatch(json, /decisions|slot/);
  assert.equal(live.sides[1].hp_percent, hpBar(123, 211));
  const over = spectatorView({ live: false, turn: 1, facts0, turns: [turn1], opening: [1, 2], names, labels: ["Alpha's", "Beta's"] });
  assert.equal(over.sides[1].hp, 123);
  assert.equal(over.sides[0].max_hp, 140);
});

test("a turn is told in order, in plain sentences, without damage numbers", () => {
  const lines = narrate(turn1, names, (s) => (s === 0 ? "Your" : "Their"));
  assert.deepEqual(lines, ["Their Pebble used Tackle.", "A critical hit!", "Your Sparky used Zap.", "It doesn't affect Their Pebble…", "Your Sparky's Attack rose."]);
  assert.doesNotMatch(lines.join(" "), /\b13\b/);
});

test("a side that started its part of the turn and used no move didn't attack", () => {
  const t: Turn = { ...turn1, events: [{ kind: "acts", side: 0 }, { kind: "acts", side: 1 }, { kind: "used", side: 1, move: 11 }], sides: [{ ...turn1.sides[0], stages: [0, 0, 0, 0, 0, 0] }, turn1.sides[1]] };
  assert.deepEqual(narrate(t, names, (s) => (s === 0 ? "Your" : "Their")), ["Your Sparky didn't attack.", "Their Pebble used Tackle."]);
});

test("the HP bar is the game's 48 pixels, and anything left shows", () => {
  assert.equal(hpBar(0, 200), 0);
  assert.equal(hpBar(1, 400), 2);
  assert.equal(hpBar(200, 200), 100);
  assert.equal(hpBar(100, 200), 50);
});

const fakeData = {
  move: (id: number) => (MOVES[id] ? { ...MOVES[id]!, effect: 0 } : null),
  // Electric does nothing to Ground (4) and twice to Water (21); Water twice to Ground and Rock (5).
  effectiveness: (a: number, d: number) => (a === 23 && d === 4 ? 0 : a === 23 && d === 21 ? 2 : a === 21 && (d === 4 || d === 5) ? 2 : 1),
  species: names.species,
  typeName: (t: number) => String(t),
} satisfies GameData;

test("the house takes the strongest expected move, and switches out of a bad match", () => {
  // Against Ground and Rock, Sparky's Zap does nothing and Tackle little; Splash's Water Gun does four times as much.
  const out = houseChoice({ kind: "turn", moves: [0, 1], fight: false, switches: [1] }, facts0, fakeData);
  assert.deepEqual(out, { kind: "switch", to: 1 });
  // Against a Water type, Zap is the move.
  const water: SideFacts = { ...facts0, theirs: { ...facts0.theirs, types: [21, 21] } };
  assert.deepEqual(houseChoice({ kind: "turn", moves: [0, 1], fight: false, switches: [1] }, water, fakeData), { kind: "move", slot: 0 });
  // After a faint, the reserve with the best move against what's out.
  assert.deepEqual(houseChoice({ kind: "forced", switches: [1] }, facts0, fakeData), { kind: "switch", to: 1 });
  // FIGHT that goes straight on, with nowhere to switch.
  assert.deepEqual(houseChoice({ kind: "turn", moves: [], fight: true, switches: [] }, facts0, fakeData), { kind: "fight" });
});

test("the rig's version names the emulator build and the code it watches", () => {
  assert.match(RIG_VERSION, /^[0-9a-f]{12}\.[0-9a-f]{8}$/);
});
