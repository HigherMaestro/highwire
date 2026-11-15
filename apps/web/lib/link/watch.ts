import type { Metadata } from "next";
import { lineRelay } from "../line/server.ts";
import sample from "./sample.json";
import sampleRated from "./sample-rated.json";
import { battleVerdict, fromPractice, type MatchWatch, type PracticeWatch } from "./battle.ts";

// What a link battle's page shows (docs/link-battles.md 13): the referee's spectators' view, never an agent's. Without
// the referee (local development, a preview without The Line's database) the pages show a sample: a real practice
// battle played through the real referee and emulator by `npm run link-sample` with the test fakes' fighter.

export type { LinkSide } from "./battle.ts";
/** A practice battle as the referee serves spectators. */
export type LinkWatch = PracticeWatch;

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
  return battleVerdict(fromPractice(w));
}

// ---------------------------------------------------------------- rated battles (14.7)

/** What the lobby shows: battles live and recent (spectators' cards), and the ladder. */
export interface LinkLobby {
  live: LobbyCard[];
  recent: LobbyCard[];
  ladder: { ranked: LadderRow[]; fighters: LadderRow[]; house: { name: string; rating: number; record: Tally } };
  queue: number;
}
type Tally = { win: number; draw: number; loss: number };
export interface LobbyCard {
  match: string;
  rated: boolean;
  house: boolean;
  sides: MatchWatch["sides"];
  turn: number;
  live: boolean;
  ended: MatchWatch["ended"];
  started_at: number;
}
export interface LadderRow {
  fighter: string;
  name: string;
  ticker: string;
  rating: number;
  provisional: boolean;
  record: { rated: Tally; unrated: Tally; house: Tally };
  operator: boolean;
  score?: number;
}

/** The rated pages exist with rated play on, and in development (or HIGHWIRE_ARENA_PAGES=1) on the sample. */
export const linkRatedPagesOn = () => Boolean(lineRelay()?.linkArena) || process.env.NODE_ENV === "development" || process.env.HIGHWIRE_ARENA_PAGES === "1";
export const usingRatedSample = () => !lineRelay()?.linkArena;

const ratedSample = sampleRated as unknown as { matches: MatchWatch[]; lobby: Omit<LinkLobby, "queue">; };

export async function linkMatchById(id: string): Promise<MatchWatch | null> {
  if (!LINK_ID.test(id)) return null;
  const arena = lineRelay()?.linkArena;
  if (!arena) return ratedSample.matches.find((m) => m.match === id) ?? null;
  try {
    return (await arena.spectate(id)) as unknown as MatchWatch;
  } catch (err) {
    if ((err as { code?: string }).code === "not_found") return null;
    throw err;
  }
}

/** A fighter's link battles, for its page: its record and rating there, and its latest battles. Null when rated play is off or it never played. */
export async function linkFighter(id: string): Promise<(LadderRow & { battles: LobbyCard[] }) | null> {
  const arena = lineRelay()?.linkArena;
  if (!arena) return null;
  return ((await arena.fighter(id).catch(() => null)) as unknown as (LadderRow & { battles: LobbyCard[] }) | null) ?? null;
}

export async function linkLobby(): Promise<LinkLobby> {
  const arena = lineRelay()?.linkArena;
  if (!arena) return { ...ratedSample.lobby, queue: 0 };
  const [m, ladder, queue] = await Promise.all([arena.matches(), arena.leaderboard(), arena.queueSize()]);
  return { live: m.live as unknown as LobbyCard[], recent: m.recent as unknown as LobbyCard[], ladder: ladder as unknown as LinkLobby["ladder"], queue };
}
