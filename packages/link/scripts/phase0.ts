import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ADDR, disagreements, DICE_LENGTH, LINK_STATE, MODEL, playTestTurn, Rig, snapshot, type Snapshot } from "highwire-link";

// Phase 0's proof (docs/link-battles.md 14): load a paired link battle, choose a move on both sides, resolve the turn
// headless, check both games agree, time it, and show that fresh dice change the turn while the same dice repeat it.
// Needs the game, which is never in the repository:
//   HIGHWIRE_LINK_ROM=<the game> npm run phase0 -w highwire-link -- <side 0 state> <side 1 state>
//   HIGHWIRE_LINK_ROM=<the game> npm run phase0 -w highwire-link -- --survey <side 0 state pattern with N> <side 1 ...>

const romPath = process.env.HIGHWIRE_LINK_ROM;
if (!romPath || !existsSync(romPath)) {
  console.error("Set HIGHWIRE_LINK_ROM to the game's file.");
  process.exit(2);
}
const rom = new Uint8Array(readFileSync(romPath));
const args = process.argv.slice(2);

async function rigWith(states: [Uint8Array, Uint8Array]): Promise<Rig> {
  for (const model of [MODEL.CGB_E, MODEL.AGB_A, MODEL.DMG_B]) {
    const rig = await Rig.create(rom, model);
    try {
      rig.loadState(0, states[0]);
      rig.loadState(1, states[1]);
      return rig;
    } catch {
      // Try the next model.
    }
  }
  throw new Error("No model accepts both states.");
}

const brief = (s: Snapshot) =>
  `link ${s.linkState} battle ${s.isInBattle} result ${s.battleResult} | me ${s.mine.species}:L${s.mine.level} ${s.mine.hp}/${s.mine.maxHp} | them ${s.theirs.species}:L${s.theirs.level} ${s.theirs.hp}/${s.theirs.maxHp} | menu ${s.menu.item} @${s.menu.top} max ${s.menu.max} | sel ${s.selected.mine}/${s.selected.theirs} | dice ${s.dice.join(",")} #${s.diceIndex}`;

if (args[0] === "--survey") {
  const [, pattern0, pattern1] = args;
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const [p0, p1] = [pattern0!.replace("N", String(n)), pattern1!.replace("N", String(n))];
    if (!existsSync(p0) || !existsSync(p1)) continue;
    const rig = await rigWith([new Uint8Array(readFileSync(p0)), new Uint8Array(readFileSync(p1))]);
    console.log(`slot ${n} (model ${rig.model(0).toString(16)})`);
    for (const side of [0, 1] as const) console.log(`  side ${side}: ${brief(snapshot(rig, side))}`);
  }
  process.exit(0);
}

const [path0, path1] = args;
const states: [Uint8Array, Uint8Array] = [new Uint8Array(readFileSync(path0!)), new Uint8Array(readFileSync(path1!))];

/** One turn on a fresh pair from the states: both sides pick move 1, and the games run until both are back at the menu. */
async function turn(dice: Uint8Array | null) {
  const rig = await rigWith(states);
  const first = [snapshot(rig, 0), snapshot(rig, 1)];
  if (first[0]!.linkState !== LINK_STATE.BATTLING || first[1]!.linkState !== LINK_STATE.BATTLING) throw new Error("Not a link battle.");
  // Fast text, no battle animations (docs/link-battles.md 7.1): Yellow keeps them in wOptions.
  if (process.env.FAST) for (const side of [0, 1] as const) rig.write(side, ADDR.options, Number(process.env.FAST));
  return { rig, ...playTestTurn(rig, { dice: dice ?? undefined, bEvery: Number(process.env.B_EVERY ?? 15) }) };
}

console.log(`before: side 0 ${brief(snapshot(await rigWith(states), 0))}`);
const one = await turn(randomBytes(DICE_LENGTH));
console.log(`after:  side 0 ${brief(one.end[0])}`);
console.log(`after:  side 1 ${brief(one.end[1])}`);
console.log(`turn: ${one.frames} frames, ${one.ms.toFixed(0)} ms (${((one.frames / one.ms) * 1000).toFixed(0)} pair-frames a second)${one.stuck ? ", STUCK (budget)" : ""}`);
const differ = disagreements(one.end[0], one.end[1]);
console.log(differ.length ? `DISAGREE:\n  ${differ.join("\n  ")}` : "both games agree");

// The dice: the same dice must repeat the turn exactly; different dice must change it at least once in a few tries.
const fixed = randomBytes(DICE_LENGTH);
const [x, y] = [await turn(fixed), await turn(fixed)];
const outcome = (r: Awaited<ReturnType<typeof turn>>) => JSON.stringify([r.end[0].mine, r.end[0].theirs]);
console.log(`same dice, same turn: ${outcome(x) === outcome(y) ? "yes" : "NO"}`);
const outcomes = new Set<string>();
for (let i = 0; i < 8; i++) outcomes.add(outcome(await turn(randomBytes(DICE_LENGTH))));
console.log(`fresh dice, distinct outcomes in 8 turns: ${outcomes.size}`);
console.log(`state sizes: ${one.rig.saveState(0).length} + ${one.rig.saveState(1).length} bytes; read ${ADDR.linkState.toString(16)} ok`);
