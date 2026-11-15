// The game's own data, read from the cartridge at runtime (docs/link-battles.md 6.1, 9): names, each move's power, type,
// accuracy and PP, and the type chart. Nothing of the game is copied into the repository; the tables' places are the
// public disassembly's symbols for this release (yellow.ts's checkGame makes sure it's that release).

/** A ROM bank and address, as the symbols give them, turned into an offset in the cartridge. */
const offset = (bank: number, addr: number) => bank * 0x4000 + (addr - (bank ? 0x4000 : 0));

const TABLES = {
  monsterNames: offset(0x3a, 0x4000),
  moveNames: offset(0x2f, 0x4000),
  moves: offset(0x0e, 0x4000),
  typeNames: offset(0x09, 0x7d63),
  typeEffects: offset(0x0f, 0x65fa),
  baseStats: offset(0x0e, 0x43de),
  pokedexOrder: offset(0x10, 0x50b1),
} as const;

/** A species' base data, from the cartridge's BaseStats table (by Pokédex number). */
export type BaseStats = { dex: number; hp: number; atk: number; def: number; spd: number; spc: number; types: [number, number]; catchRate: number; growth: number };

/** Gen 1's growth rates: experience for level n is a/b n³ + c n² + d n − e (GrowthRateTable). */
const GROWTH: [number, number, number, number, number][] = [
  [1, 1, 0, 0, 0],
  [3, 4, 10, 0, 30],
  [3, 4, 20, 0, 70],
  [6, 5, -15, 100, 140],
  [4, 5, 0, 0, 0],
  [5, 4, 0, 0, 0],
];

/** The experience a Pokémon of `growth` has at the start of `level`, as the game computes it. */
export function experienceAt(growth: number, level: number): number {
  const [a, b, c, d, e] = GROWTH[growth] ?? GROWTH[0]!;
  return Math.max(0, Math.floor((a * level ** 3) / b) + c * level ** 2 + d * level - e);
}

const NUM_SPECIES = 190; // internal species numbers 1..190, gaps included
const NUM_MOVES = 165;
const NAME_LENGTH = 10;
const TERMINATOR = 0x50;

/** The game's character set, the parts names use. */
const CHARS: Record<number, string> = { 0x7f: " ", 0x9a: "(", 0x9b: ")", 0x9c: ":", 0xba: "é", 0xe0: "'", 0xe3: "-", 0xe6: "?", 0xe7: "!", 0xe8: ".", 0xef: "♂", 0xf2: ".", 0xf3: "/", 0xf4: ",", 0xf5: "♀", 0x54: "POKé", 0xe1: "PK", 0xe2: "MN" };
for (let i = 0; i < 26; i++) {
  CHARS[0x80 + i] = String.fromCharCode(65 + i);
  CHARS[0xa0 + i] = String.fromCharCode(97 + i);
}
for (let i = 0; i < 10; i++) CHARS[0xf6 + i] = String(i);
Object.assign(CHARS, { 0xbb: "'d", 0xbc: "'l", 0xbd: "'s", 0xbe: "'t", 0xbf: "'v", 0xe4: "'r", 0xe5: "'m" });

/** Decodes the game's text up to its terminator. */
export function decodeText(bytes: ArrayLike<number>, start = 0, max = 32): string {
  let out = "";
  for (let i = start; i < Math.min(bytes.length, start + max); i++) {
    const b = bytes[i]!;
    if (b === TERMINATOR) break;
    out += CHARS[b] ?? "?";
  }
  return out;
}

/** The type ids' names as people write them. */
export type MoveData = { name: string; power: number; type: number; accuracy: number; pp: number; effect: number };

export interface GameData {
  species(id: number): string;
  /** Base stats by internal species number (Mew's table isn't read: no format uses it). */
  baseStats?(id: number): BaseStats | null;
  move(id: number): MoveData | null;
  typeName(id: number): string;
  /** The type chart's multiplier for a move of `attack` against a Pokémon of `defend`: 0, 0.5, 1 or 2. */
  effectiveness(attack: number, defend: number): number;
}

/** Reads the tables the referee and the house need from the cartridge. */
export function gameData(rom: Uint8Array): GameData {
  const species = Array.from({ length: NUM_SPECIES + 1 }, (_, id) =>
    id === 0 ? "" : titleCase(decodeText(rom, TABLES.monsterNames + (id - 1) * NAME_LENGTH, NAME_LENGTH)),
  );
  const moveNames: string[] = [""];
  for (let p = TABLES.moveNames; moveNames.length <= NUM_MOVES; p++) {
    const start = p;
    while (rom[p] !== TERMINATOR && p - start < 20) p++;
    moveNames.push(titleCase(decodeText(rom, start, 20)));
  }
  const moves: MoveData[] = moveNames.map((name, id) => {
    const at = TABLES.moves + (id - 1) * 6;
    return { name, effect: rom[at + 1] ?? 0, power: rom[at + 2] ?? 0, type: rom[at + 3] ?? 0, accuracy: Math.round(((rom[at + 4] ?? 0) / 255) * 100), pp: rom[at + 5] ?? 0 };
  });
  const typeNames = new Map<number, string>();
  for (let id = 0; id <= 0x1a; id++) {
    const ptr = (rom[TABLES.typeNames + id * 2] ?? 0) | ((rom[TABLES.typeNames + id * 2 + 1] ?? 0) << 8);
    if (ptr >= 0x4000 && ptr < 0x8000) typeNames.set(id, titleCase(decodeText(rom, offset(0x09, ptr), 12)));
  }
  const chart = new Map<number, number>();
  for (let p = TABLES.typeEffects; rom[p] !== 0xff && p < TABLES.typeEffects + 3 * 100; p += 3) {
    chart.set((rom[p]! << 8) | rom[p + 1]!, rom[p + 2]! / 10);
  }
  const baseStats = (id: number): BaseStats | null => {
    const dex = rom[TABLES.pokedexOrder + id - 1] ?? 0;
    if (id < 1 || id > NUM_SPECIES || dex < 1 || dex > 150) return null;
    const at = TABLES.baseStats + (dex - 1) * 28;
    const b = (i: number) => rom[at + i] ?? 0;
    if (b(0) !== dex) return null;
    return { dex, hp: b(1), atk: b(2), def: b(3), spd: b(4), spc: b(5), types: [b(6), b(7)], catchRate: b(8), growth: b(19) };
  };
  return {
    baseStats,
    species: (id) => species[id] ?? `#${id}`,
    move: (id) => (id >= 1 && id <= NUM_MOVES ? moves[id]! : null),
    typeName: (id) => typeNames.get(id) ?? `type ${id}`,
    effectiveness: (attack, defend) => chart.get((attack << 8) | defend) ?? 1,
  };
}

/** "THUNDERBOLT" to "Thunderbolt", "MR.MIME" to "Mr.Mime": the game shouts its names. */
function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s.-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase()).replace(/Poké/g, "Poké");
}
