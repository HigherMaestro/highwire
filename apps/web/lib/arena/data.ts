import type { Metadata } from "next";
import { RelayError } from "highwire-relay";
import { lineConfigured, lineRelay } from "../line/server.ts";
import sample from "./sample.json";

// The Line's pages' data: the referee's (lib/line/server.ts) once its database is connected, and otherwise, in local
// development, sample matches the real referee played between invented fighters (scripts/arena-sample.ts). Until the
// first real match, the live pages show one sample match, labelled as an example.

export const arenaPagesOn = () => lineConfigured() || process.env.NODE_ENV === "development" || process.env.HIGHWIRE_ARENA_PAGES === "1";

/** Sample pages are never indexed or previewed. */
export const ARENA_META: Metadata = { robots: { index: false, follow: false } };

export type Side = "a" | "b";

export interface Reveal {
  pull: number;
  nonce: string;
  line: string;
  hidden?: boolean;
  arrivedMs: number;
  fallback: boolean;
  commitment: string;
}

export interface Round {
  round: number;
  openedAt: number;
  a: Reveal;
  b: Reveal;
  winner: Side | null;
  node: number;
  energy: Record<Side, number>;
}

export interface ArenaMatch {
  id: string;
  rules: string;
  sides: Record<Side, { kind: "fighter" | "house"; id: string; name: string; bank: number }>;
  round: number | null;
  node: number;
  energy: Record<Side, number>;
  spent: Record<Side, number>;
  rounds: Round[];
  house: { bot: string; side: Side; seedCommitment: string; seed: string | null } | null;
  ending: { winner: Side | null; reason: string } | null;
  endedAt: number | null;
}

export interface Tally {
  win: number;
  draw: number;
  loss: number;
}

export interface ArenaFighter {
  id: string;
  name: string;
  ticker: string;
  rating: number;
  deviation: number;
  provisional: boolean;
  record: { rated: Tally; house: Tally; unrated?: Tally };
  operator: boolean;
  listed: boolean;
}

interface Sample {
  note: string;
  generatedAt: string;
  fighters: ArenaFighter[];
  house: { bot: string; name: string; rating: number; record: Tally }[];
  matches: ArenaMatch[];
}

const data = sample as unknown as Sample;

export interface LineData {
  /** Sample data, not the referee's. */
  sample: boolean;
  live: ArenaMatch[];
  recent: ArenaMatch[];
  fighters: ArenaFighter[];
  house: Sample["house"];
  /** A sample match to show while nothing real has been played. */
  example: ArenaMatch;
  /** Fighters waiting for an opponent. */
  queue: number;
}

/** Everything a fighter has played against agents, rated or not. */
export const vsAgents = (f: ArenaFighter): Tally => {
  const u = f.record.unrated ?? { win: 0, draw: 0, loss: 0 };
  return { win: f.record.rated.win + u.win, draw: f.record.rated.draw + u.draw, loss: f.record.rated.loss + u.loss };
};

const example = () => data.matches.find((m) => !m.house && m.rounds.length >= 10) ?? data.matches[0]!;
const notFound = (err: unknown) => err instanceof RelayError && err.code === "not_found";

export async function lineData(): Promise<LineData> {
  const r = lineRelay();
  if (!r) return { sample: true, live: [], recent: data.matches, fighters: data.fighters, house: data.house, example: example(), queue: 0 };
  const [{ live, recent }, board, queue] = await Promise.all([r.referee.matches(), r.referee.leaderboard(), r.referee.queueSize()]);
  return { sample: false, live: live as unknown as ArenaMatch[], recent: recent as unknown as ArenaMatch[], fighters: board.fighters, house: board.house, example: example(), queue };
}

export async function matchById(id: string): Promise<ArenaMatch | null> {
  const r = lineRelay();
  if (!r) return data.matches.find((m) => m.id === id) ?? null;
  return (await r.referee.spectate(id).catch((err) => (notFound(err) ? null : Promise.reject(err)))) as unknown as ArenaMatch | null;
}

export async function fighterById(id: string): Promise<ArenaFighter | null> {
  const r = lineRelay();
  if (!r) return data.fighters.find((f) => f.id === id) ?? null;
  return r.referee.fighter(id).catch((err) => (notFound(err) ? null : Promise.reject(err)));
}

export async function matchesFor(id: string): Promise<ArenaMatch[]> {
  const r = lineRelay();
  if (!r) return data.matches.filter((m) => m.sides.a.id === id || m.sides.b.id === id);
  return (await r.referee.fighterMatches(id)) as unknown as ArenaMatch[];
}

export const sideOf = (m: ArenaMatch, id: string): Side => (m.sides.a.id === id ? "a" : "b");

/** "win", "loss", "draw" or "void", for one side. */
export function resultFor(m: ArenaMatch, side: Side): "win" | "loss" | "draw" | "void" | null {
  if (!m.ending) return null;
  if (m.ending.reason === "void") return "void";
  if (m.ending.winner === null) return "draw";
  return m.ending.winner === side ? "win" : "loss";
}

export const REASON: Record<string, string> = {
  reached_end: "reached the end",
  rounds_up: "ahead after 15 rounds",
  draw: "level after 15 rounds",
  forfeit: "the other side retired",
  void: "neither side showed up",
  tie_break: "on the tie-break",
};

/** One line on how a match ended. */
export function verdict(m: ArenaMatch): string {
  if (!m.ending) return "Under way";
  if (m.ending.reason === "void") return "Void: neither side showed up";
  if (m.ending.winner === null) return "Draw: level after 15 rounds";
  return `${m.sides[m.ending.winner].name} won, ${REASON[m.ending.reason] ?? m.ending.reason}`;
}

/** The share of a fighter's rounds it played itself, rather than its fallback. */
export function reliability(id: string, matches: ArenaMatch[]): number | null {
  let own = 0;
  let all = 0;
  for (const m of matches) {
    const s = sideOf(m, id);
    for (const r of m.rounds) {
      all++;
      if (!r[s].fallback) own++;
    }
  }
  return all ? own / all : null;
}

/** Results against other agents (the referee rates these from phase 3). */
export function agentRecord(id: string, matches: ArenaMatch[]): Tally {
  const t: Tally = { win: 0, draw: 0, loss: 0 };
  for (const m of matches) {
    if (m.house) continue;
    const r = resultFor(m, sideOf(m, id));
    if (r === "win") t.win++;
    else if (r === "loss") t.loss++;
    else if (r === "draw") t.draw++;
  }
  return t;
}

export const when = (ms: number | null) =>
  ms === null ? "" : new Date(ms).toLocaleString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " UTC";
