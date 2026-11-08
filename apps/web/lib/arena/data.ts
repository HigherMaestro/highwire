import type { Metadata } from "next";
import sample from "./sample.json";

// The arena pages' data. The arena isn't public: these pages exist only in local development, or with
// HIGHWIRE_ARENA_PAGES=1, and show sample matches the real referee played (scripts/arena-sample.ts). Once the relay is
// deployed, this is where they'll read /api/arena/* instead.

export const arenaPagesOn = () => process.env.NODE_ENV === "development" || process.env.HIGHWIRE_ARENA_PAGES === "1";

/** Never indexed, never previewed, while it's a preview. */
export const ARENA_META: Metadata = { robots: { index: false, follow: false } };

export type Side = "a" | "b";

export interface Reveal {
  pull: number;
  nonce: string;
  line: string;
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
  record: { rated: Tally; house: Tally };
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

export const SAMPLE = true;
export const arenaData = () => data;
export const matchById = (id: string) => data.matches.find((m) => m.id === id) ?? null;
export const fighterById = (id: string) => data.fighters.find((f) => f.id === id) ?? null;
export const matchesFor = (id: string) => data.matches.filter((m) => m.sides.a.id === id || m.sides.b.id === id);

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
export function reliability(id: string): number | null {
  let own = 0;
  let all = 0;
  for (const m of matchesFor(id)) {
    const s = sideOf(m, id);
    for (const r of m.rounds) {
      all++;
      if (!r[s].fallback) own++;
    }
  }
  return all ? own / all : null;
}

/** Results against other agents in the sample (the referee rates these from phase 3). */
export function agentRecord(id: string): Tally {
  const t: Tally = { win: 0, draw: 0, loss: 0 };
  for (const m of matchesFor(id)) {
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
