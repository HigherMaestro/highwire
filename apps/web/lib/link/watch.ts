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
  /** The spectators' view, for the card's teams and score (absent on cards from before it was carried). */
  spectator?: MatchWatch["spectator"];
  rated: boolean;
  house: boolean;
  staked?: boolean;
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

/** The practice-stake page exists with the stake desk on (docs/link-wager.md), and in development on the sample. */
export const linkStakesOn = () => Boolean(lineRelay()?.linkStakes) || process.env.NODE_ENV === "development" || process.env.HIGHWIRE_ARENA_PAGES === "1";
export const usingStakesSample = () => !lineRelay()?.linkStakes;

export interface StakedBattle {
  match: string;
  at: number;
  fighters: Record<"A" | "B", { id: string; name: string; ticker: string }>;
  outcome: "a" | "b" | "draw" | "void" | null;
}

/** The staked battles that were played, newest first: the battle to watch and who played, never an amount. */
export async function linkStakesPlayed(): Promise<StakedBattle[]> {
  const desk = lineRelay()?.linkStakes;
  if (desk) return desk.played();
  // No desk (local development): the rated sample's finished battles between agents, shown as if they had been staked.
  return ratedSample.lobby.recent
    .filter((c) => !c.house && c.ended)
    .map((c) => ({
      match: c.match,
      at: c.started_at,
      fighters: { A: { id: c.sides[0]!.fighter ?? "", name: c.sides[0]!.name, ticker: "" }, B: { id: c.sides[1]!.fighter ?? "", name: c.sides[1]!.name, ticker: "" } },
      outcome: c.ended!.reason === "void" ? ("void" as const) : c.ended!.winner === null ? ("draw" as const) : c.ended!.winner === 0 ? ("a" as const) : ("b" as const),
    }));
}

/** A fighter's link battles, for its page: its record and rating there, and its latest battles. Null when rated play is off or it never played. */
export async function linkFighter(id: string): Promise<(LadderRow & { battles: LobbyCard[] }) | null> {
  const arena = lineRelay()?.linkArena;
  if (!arena) return null;
  return ((await arena.fighter(id).catch(() => null)) as unknown as (LadderRow & { battles: LobbyCard[] }) | null) ?? null;
}

/** The battles live now, newest first: only what /link/watch needs. */
export async function linkLive(): Promise<LobbyCard[]> {
  const arena = lineRelay()?.linkArena;
  if (!arena) return ratedSample.lobby.live;
  return (await arena.live()) as unknown as LobbyCard[];
}

export async function linkLobby(): Promise<LinkLobby> {
  const arena = lineRelay()?.linkArena;
  if (!arena) {
    // The sample's cards, with each battle's view from the sample itself.
    const withView = (c: LobbyCard) => ({ ...c, spectator: ratedSample.matches.find((m) => m.match === c.match)?.spectator ?? null });
    return { ...ratedSample.lobby, live: ratedSample.lobby.live.map(withView), recent: ratedSample.lobby.recent.map(withView), queue: 0 };
  }
  const [m, ladder, queue] = await Promise.all([arena.matches(), arena.leaderboard(), arena.queueSize()]);
  return { live: m.live as unknown as LobbyCard[], recent: m.recent as unknown as LobbyCard[], ladder: ladder as unknown as LinkLobby["ladder"], queue };
}
