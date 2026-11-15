import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { DICE_LENGTH, LinkMatch, type MatchState, type Side, watch } from "highwire-link";

// A practice battle through the match engine, as the referee will run one (docs/link-battles.md 8.2): side 0 plays the
// house, side 1 a random legal action, and every turn is opened from its packed state, played and packed again. Prints
// side 0's view at the first decision, each turn as both sides and spectators see it, and the sizes the store holds.
//   HIGHWIRE_LINK_ROM=<the game> npm run practice -w highwire-link -- <side 0 state> <side 1 state> [turns]

const romPath = process.env.HIGHWIRE_LINK_ROM;
if (!romPath || !existsSync(romPath)) {
  console.error("Set HIGHWIRE_LINK_ROM to the game's file.");
  process.exit(2);
}
const rom = new Uint8Array(readFileSync(romPath));
const [p0, p1, turnsArg = "200"] = process.argv.slice(2);
let { match, packed } = await LinkMatch.start(rom, [new Uint8Array(readFileSync(p0!)), new Uint8Array(readFileSync(p1!))]);
console.log("side 0's first view:\n" + JSON.stringify(match.view(0), null, 1).slice(0, 2500));
let state: MatchState = match.state;
let biggest = packed.length;
const t0 = performance.now();
for (let n = 0; n < Number(turnsArg) && !state.outcome && !state.void; n++) {
  match = await LinkMatch.open(rom, state, packed);
  const decisions = ([0, 1] as Side[]).map((side) => {
    if (side === 0) return match.house(0);
    const legal = match.legal(1);
    if (!legal) return null;
    const all = legal.kind === "forced" ? legal.switches.map((to) => ({ kind: "switch" as const, to })) : [...legal.moves.map((slot) => ({ kind: "move" as const, slot })), ...(legal.fight ? [{ kind: "fight" as const }] : []), ...legal.switches.map((to) => ({ kind: "switch" as const, to }))];
    return all[Math.floor(Math.random() * all.length)]!;
  }) as Parameters<typeof match.play>[0];
  const result = match.play(decisions, randomBytes(DICE_LENGTH));
  state = result.state;
  if (result.packed) {
    packed = result.packed;
    biggest = Math.max(biggest, packed.length);
  }
  const lines = watch(state, match.data, ["The house's", "Random's"], result.packed ? await LinkMatch.open(rom, state, packed) : undefined)?.turns.at(-1)?.lines ?? [];
  console.log(`turn ${state.turn}: ${JSON.stringify(decisions)}\n  ${lines.join(" ")}`);
}
const ms = performance.now() - t0;
console.log(`\n${state.outcome ? (state.outcome.winner === null ? "draw" : `side ${state.outcome.winner} won`) : state.void ? `void: ${state.void.message}` : "stopped"} after ${state.turn} turns, ${(ms / Math.max(1, state.turn)).toFixed(0)} ms a turn`);
console.log(`packed battle: up to ${biggest} bytes; match state: ${JSON.stringify(state).length} bytes`);
const end = watch(state, match.data, ["The house's", "Random's"]);
if (end) console.log("spectators at the end:", JSON.stringify(end.sides));
