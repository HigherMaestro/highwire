import { type BaseStats, experienceAt, type GameData } from "./data.ts";
import type { Rig, Side } from "./rig.ts";
import { ADDR, PARTY_MON } from "./yellow.ts";

// The format's team (docs/link-battles.md 4.1): three a side, the same three on both sides, at one level, with fixed
// movesets and the best DVs and full stat experience, so nothing but the agents' choices and the dice decides a battle.
// The referee writes it into both games' parties before they're exchanged over the cable (scripts/bootstrap.ts), and the
// game does the rest: the exchange, the send-outs, the first menu. Nothing banned, nothing that desyncs.

export const LEVEL = 50;

/** Internal species numbers and move numbers, as the game stores them. */
export const TEAM: { name: string; species: number; moves: [number, number, number, number] }[] = [
  // Charizard: Flamethrower, Slash, Earthquake, Fly.
  { name: "CHARIZARD", species: 0xb4, moves: [53, 163, 89, 19] },
  // Blastoise: Surf, Ice Beam, Body Slam, Seismic Toss.
  { name: "BLASTOISE", species: 0x1c, moves: [57, 58, 34, 69] },
  // Venusaur: Razor Leaf, Sleep Powder, Leech Seed, Body Slam.
  { name: "VENUSAUR", species: 0x9a, moves: [75, 79, 73, 34] },
];

/** The format's fixed DVs (all 15) and stat experience (all 65,535). */
const DV = 15;
const STAT_EXP = 65535;
const statExpBonus = Math.floor(Math.ceil(Math.sqrt(STAT_EXP)) / 4);

/** Gen 1's stat formula; HP adds the level and 10 instead of 5. */
export function stat(base: number, level: number, hp = false): number {
  return Math.floor((((base + DV) * 2 + statExpBonus) * level) / 100) + (hp ? level + 10 : 5);
}

const ENC: Record<string, number> = {};
for (let i = 0; i < 26; i++) ENC[String.fromCharCode(65 + i)] = 0x80 + i;

/** A name in the game's character set, padded with terminators to 11 bytes. */
function encodeName(name: string): number[] {
  const out = [...name.toUpperCase()].map((c) => ENC[c] ?? 0x7f).slice(0, 10);
  while (out.length < 11) out.push(0x50);
  return out;
}

/** One party record (44 bytes) for the format. */
export function partyRecord(base: BaseStats, species: number, moves: number[], data: GameData, otId: number): Uint8Array {
  const r = new Uint8Array(PARTY_MON.length);
  const put16 = (at: number, v: number) => {
    r[at] = (v >> 8) & 0xff;
    r[at + 1] = v & 0xff;
  };
  const maxHp = stat(base.hp, LEVEL, true);
  const exp = experienceAt(base.growth, LEVEL);
  r[0] = species;
  put16(1, maxHp);
  r[3] = LEVEL;
  r[4] = 0;
  r[5] = base.types[0];
  r[6] = base.types[1];
  r[7] = base.catchRate;
  moves.forEach((m, i) => (r[8 + i] = m));
  put16(12, otId);
  r[14] = (exp >> 16) & 0xff;
  r[15] = (exp >> 8) & 0xff;
  r[16] = exp & 0xff;
  for (let i = 0; i < 5; i++) put16(17 + i * 2, STAT_EXP);
  r[27] = (DV << 4) | DV;
  r[28] = (DV << 4) | DV;
  moves.forEach((m, i) => (r[PARTY_MON.pp + i] = data.move(m)?.pp ?? 0));
  r[PARTY_MON.level] = LEVEL;
  put16(PARTY_MON.maxHp, maxHp);
  put16(36, stat(base.atk, LEVEL));
  put16(38, stat(base.def, LEVEL));
  put16(40, stat(base.spd, LEVEL));
  put16(42, stat(base.spc, LEVEL));
  return r;
}

/**
 * Writes the format's team into one game's own party: count, species list, records, original trainer (this game's
 * player, kept) and nicknames (the species' names). Call while the game is out of battle, before the party exchange.
 */
export function writeTeam(rig: Rig, side: Side, data: GameData): void {
  if (!data.baseStats) throw new Error("The game data can't read base stats.");
  const otId = rig.read16(side, ADDR.playerID);
  const otName = rig.readBytes(side, ADDR.playerName, 11);
  rig.write(side, ADDR.partyCount, TEAM.length);
  TEAM.forEach((m, i) => rig.write(side, ADDR.partySpecies + i, m.species));
  rig.write(side, ADDR.partySpecies + TEAM.length, 0xff);
  TEAM.forEach((m, i) => {
    const base = data.baseStats!(m.species);
    if (!base) throw new Error(`No base stats for ${m.name}.`);
    partyRecord(base, m.species, m.moves, data, otId).forEach((b, j) => rig.write(side, ADDR.partyMons + i * PARTY_MON.length + j, b));
    otName.forEach((b, j) => rig.write(side, ADDR.partyMonOT + i * 11 + j, b));
    encodeName(m.name).forEach((b, j) => rig.write(side, ADDR.partyMonNicks + i * 11 + j, b));
  });
}
