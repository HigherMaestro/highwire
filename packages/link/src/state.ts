import { deflateRawSync, inflateRawSync } from "node:zlib";
import { Battle, type Phase } from "./battle.ts";
import { Rig, type Side } from "./rig.ts";
import { WASM_SHA256 } from "./wasm/version.ts";
import { ADDR, CODE } from "./yellow.ts";

// A paused battle, as the referee stores it (docs/link-battles.md 8.2, 4.3): both games' states at a decision point,
// with the phase each game is in and the turn, compressed, and stamped with the rig's version. A state from another
// version of the rig is refused, never resumed: the same inputs might not give the same turn (the match is voided).

/** The format the rig plays: its rules, team and code addresses are part of what a state means. */
export const FORMAT = "colosseum-1";

const fnv = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
};

/**
 * The battle logic's revision: bump it whenever the engine plays a turn differently (battle.ts, yellow.ts, format.ts,
 * state.ts, rig.ts). test/engine.test.ts fails when those files change and this doesn't, so an old saved battle never
 * resumes under new logic.
 */
export const ENGINE_REVISION = 2;

/** The emulator's build, the code and memory map, the format and the engine's revision: change any and old states stop resuming. */
export const RIG_VERSION = `${WASM_SHA256.slice(0, 12)}.${fnv(JSON.stringify([CODE, ADDR, FORMAT, ENGINE_REVISION]))}`;

const MAGIC = "HWLB";
const PHASES: Phase[] = ["menu", "moves", "party", "switch-menu", "forced", "waiting", "busy"];

export type Paused = { turn: number; phases: [Phase, Phase] };

/** Packs a battle at a decision point: both games' states, their phases and the turn. */
export function pack(rig: Rig, battle: Battle): Uint8Array {
  if (!battle.atDecision()) throw new Error("A battle is packed only at a decision point.");
  const states = [rig.saveState(0), rig.saveState(1)];
  const header = new TextEncoder().encode(`${MAGIC}${RIG_VERSION}`);
  const body = new Uint8Array(header.length + 1 + 2 + 2 + 1 + 8 + states[0]!.length + states[1]!.length);
  const view = new DataView(body.buffer);
  let at = 0;
  body.set(header, at);
  at += header.length;
  body[at++] = header.length;
  view.setUint16(at, battle.turn);
  at += 2;
  body[at++] = PHASES.indexOf(battle.phase(0));
  body[at++] = PHASES.indexOf(battle.phase(1));
  // The cable's bits in flight: a turn nobody chooses is packed while both games are mid-exchange.
  body[at++] = rig.cable;
  for (const state of states) {
    view.setUint32(at, state.length);
    at += 4;
    body.set(state, at);
    at += state.length;
  }
  return deflateRawSync(body, { level: 6 });
}

/** The version a packed battle was made by, without unpacking the rest. */
export function versionOf(packed: Uint8Array): string | null {
  const body = inflateRawSync(packed);
  const text = new TextDecoder().decode(body.subarray(0, 64));
  return text.startsWith(MAGIC) ? text.slice(MAGIC.length, MAGIC.length + RIG_VERSION.length) : null;
}

/** Loads a packed battle into `rig` and returns the battle, resumed at its decision point. Refuses another version. */
export function unpack(rig: Rig, packed: Uint8Array): { battle: Battle } & Paused {
  const body = inflateRawSync(packed);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const headerLength = MAGIC.length + RIG_VERSION.length;
  const header = new TextDecoder().decode(body.subarray(0, headerLength));
  if (header !== `${MAGIC}${RIG_VERSION}` || body[headerLength] !== headerLength) {
    throw new Error(`This battle was saved by another version of the rig (${header.slice(MAGIC.length) || "unknown"}, this is ${RIG_VERSION}).`);
  }
  let at = headerLength + 1;
  const turn = view.getUint16(at);
  at += 2;
  const phases = [PHASES[body[at]!]!, PHASES[body[at + 1]!]!] as [Phase, Phase];
  at += 2;
  const cable = body[at++]!;
  for (const side of [0, 1] as Side[]) {
    const length = view.getUint32(at);
    at += 4;
    rig.loadState(side, body.subarray(at, at + length));
    at += length;
  }
  rig.cable = cable;
  const battle = new Battle(rig, { phases, turn });
  // One frame shows each game's phase again; a packed battle was at a decision point, so it's there at once.
  if (battle.runToDecision(30) || !battle.atDecision()) throw new Error("The packed battle didn't resume at its decision point.");
  return { battle, turn, phases };
}
