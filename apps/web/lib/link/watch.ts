import type { Metadata } from "next";
import { lineRelay } from "../line/server.ts";
import sample from "./sample.json";

// What a link battle's page shows (docs/link-battles.md 13): the referee's spectators' view, never an agent's. Without
// the referee (local development, a preview without The Line's database) the pages show a sample: a real practice
// battle played through the real referee and emulator by `npm run link-sample` with the test fakes' fighter.

export interface LinkSide {
  species: string;
  level: number;
  hp_percent: number;
  status: string | null;
  field: string[];
  seen: string[];
  fainted: number;
  /** Exact numbers, only once the battle is over. */
  hp?: number;
  max_hp?: number;
}

export interface LinkWatch {
  match: string;
  practice: true;
  fighter: string;
  /** The fighter's name: a coin name, creator content. */
  name: string;
  house_side: 0 | 1;
  turn: number;
  ended: null | { reason: "knockout" | "draw" | "void"; winner: "you" | "house" | null; message?: string };
  spectator: { live: boolean; turn: number; sides: [LinkSide, LinkSide]; turns: { turn: number; lines: string[] }[] } | null;
  /** The fighter's table talk: its own words. */
  lines: { turn: number; line: string }[];
}

export const LINK_ID = /^[a-z2-9]{10}$/;

/** The pages exist with the referee, and in development or with HIGHWIRE_ARENA_PAGES=1 on the sample. */
export const linkPagesOn = () => Boolean(lineRelay()?.link) || process.env.NODE_ENV === "development" || process.env.HIGHWIRE_ARENA_PAGES === "1";

/** Practice battles are unlisted: never indexed (13.4). */
export const LINK_META: Metadata = { robots: { index: false, follow: false } };

export const usingSample = () => !lineRelay()?.link;

export async function linkPracticeById(id: string): Promise<LinkWatch | null> {
  if (!LINK_ID.test(id)) return null;
  const link = lineRelay()?.link;
  if (!link) return ((sample as unknown as LinkWatch[]).find((m) => m.match === id) ?? null);
  try {
    return (await link.watchPractice(id)) as LinkWatch;
  } catch (err) {
    if ((err as { code?: string }).code === "not_found") return null;
    throw err;
  }
}

/** The battle's result in a sentence, from the house's side of things never: the fighter is the subject. */
export function linkVerdict(w: LinkWatch): string {
  const e = w.ended;
  if (!e) return `Live · turn ${w.turn + 1}`;
  if (e.reason === "void") return e.message ? `No result: ${e.message.replace(/\.$/, "")}.` : "No result.";
  if (e.reason === "draw") return `A draw after ${w.turn} turns.`;
  return e.winner === "you" ? `${w.name} won in ${w.turn} turns.` : `The house won in ${w.turn} turns.`;
}
