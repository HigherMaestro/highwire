import type { Side } from "./rig.ts";

// The trainers' names in both games (docs/link-battles.md 14.6): each game keeps its own player's name and the other
// player's, received over the cable in the Cable Club. The bootstrap's came from its save, so every battle read "Ash
// sent out…" and ended "Ash defeated Ash!". A battle's start writes each side's name, so the game's own text names the
// fighters. Names change only text: no turn plays differently, so the engine's revision is unchanged.
//
// Where they are, found in the bootstrap's memory (the public disassembly's symbols for this release, one byte lower
// than the red/blue release's from wPlayerName on): the player's name, the other player's as the cable brought it, the
// copy the battle's text reads, and the original trainer of each Pokémon on both teams. The OT names are set too, so
// each team's original trainer stays its own player, as it was in the bootstrap (where all of them were "Ash").

const NAME_LENGTH = 11;
const PLAYER_NAME = 0xd157;
const TRAINER_NAME = 0xd049;
const LINK_ENEMY_TRAINER_NAME = 0xd886;
const PARTY_OT = 0xd272;
const ENEMY_PARTY_OT = 0xd9ab;
const TERMINATOR = 0x50;

/** The longest name the game's text has room for (its own naming screen's limit). */
export const TRAINER_NAME_MAX = 7;

/**
 * A name the game can show: letters, digits and single spaces, at most seven characters, or `fallback` when nothing is
 * left. Names are creator content (a coin's ticker), so anything else is dropped, never mapped to a control code.
 */
export function trainerName(text: string, fallback: string): string {
  const kept = text
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TRAINER_NAME_MAX)
    .trim();
  return kept || fallback;
}

/** A name in the game's characters, padded with its terminator to the game's name length. */
export function encodeName(name: string): Uint8Array {
  const out = new Uint8Array(NAME_LENGTH).fill(TERMINATOR);
  [...trainerName(name, "?")].forEach((ch, i) => {
    const c = ch.charCodeAt(0);
    out[i] =
      ch === " " ? 0x7f
      : c >= 65 && c <= 90 ? 0x80 + c - 65
      : c >= 97 && c <= 122 ? 0xa0 + c - 97
      : c >= 48 && c <= 57 ? 0xf6 + c - 48
      : 0x7f;
  });
  return out;
}

/** What the writes need of the rig: direct writes into a game's memory. */
export interface NameWriter {
  write(side: Side, addr: number, value: number): void;
}

/** Writes both trainers' names into both games: each game's player is `names[side]`, its opponent the other's. */
export function writeTrainers(rig: NameWriter, names: readonly [string, string]): void {
  const put = (side: Side, at: number, bytes: Uint8Array) => bytes.forEach((b, i) => rig.write(side, at + i, b));
  for (const side of [0, 1] as const) {
    const own = encodeName(names[side]);
    const other = encodeName(names[1 - side]!);
    put(side, PLAYER_NAME, own);
    for (let i = 0; i < 6; i++) put(side, PARTY_OT + i * NAME_LENGTH, own);
    put(side, LINK_ENEMY_TRAINER_NAME, other);
    put(side, TRAINER_NAME, other);
    for (let i = 0; i < 6; i++) put(side, ENEMY_PARTY_OT + i * NAME_LENGTH, other);
  }
}
