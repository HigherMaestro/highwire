import { update, type Store } from "../store.ts";
import type { Fighter, Match } from "./types.ts";

// Free play's numbers (docs/arena.md 2, docs/wager-mode.md 13): weekly active owners, registrations, the finished-match
// rate, and how many owners are still playing a month after their first match. The referee records each match once,
// as it settles, into a document for the week it started; every write is a set union or a minimum, so recording a
// match twice (a retry, the backfill) changes nothing. Owners are registering wallets, which are public already.
//
// An owner is active in a week when one of its fighters moved itself (not by fallback) in a match that started that
// week. Operator coins (the maintainer's and Highwire's own) are counted apart and never toward the gate.

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const week = (start: string) => `arena:metrics:week:${start}`;
const FIRST = "arena:metrics:first";

/** What one match adds to its week. */
interface MatchFact {
  /** Ended without a forfeit or a void. */
  finished: boolean;
  house: boolean;
}

interface WeekDoc {
  owners: string[];
  operators: string[];
  matches: Record<string, MatchFact>;
}

/** The Monday (UTC) that starts the week holding `ms`, as YYYY-MM-DD. */
export function weekStart(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

const startMs = (w: string) => Date.parse(`${w}T00:00:00Z`);

/** Records an ended match in its week. `fighters` are its sides' fighters, by mint, as they were when it settled. */
export async function recordMatch(store: Store, m: Match, fighters: Record<string, Fighter | undefined>): Promise<void> {
  if (!m.ending) return;
  const owners: string[] = [];
  const operators: string[] = [];
  for (const s of ["a", "b"] as const) {
    const side = m.sides[s];
    const f = side.kind === "fighter" ? fighters[side.id] : undefined;
    if (!f || !m.rounds.some((r) => !r[s].fallback)) continue;
    (f.operator ? operators : owners).push(f.wallet);
  }
  const fact: MatchFact = { finished: m.ending.reason !== "forfeit" && m.ending.reason !== "void", house: Boolean(m.house) };
  const w = weekStart(m.createdAt);
  await update<WeekDoc>(store, week(w), (cur) => {
    const doc = cur ?? { owners: [], operators: [], matches: {} };
    const next = {
      owners: [...new Set([...doc.owners, ...owners])],
      operators: [...new Set([...doc.operators, ...operators])],
      matches: { ...doc.matches, [m.id]: fact },
    };
    return JSON.stringify(next) === JSON.stringify(doc) ? undefined : next;
  });
  if (!owners.length) return;
  await update<Record<string, string>>(store, FIRST, (cur) => {
    const map = cur ?? {};
    const changed = owners.filter((o) => !map[o] || map[o]! > w);
    if (!changed.length) return undefined;
    return { ...map, ...Object.fromEntries(changed.map((o) => [o, w])) };
  });
}

export interface WeekMetrics {
  /** The Monday it starts, UTC. */
  week: string;
  /** False for the week still under way. */
  complete: boolean;
  activeOwners: number;
  /** Operator coins' owners, never counted toward the gate. */
  operatorOwners: number;
  /** Fighters registered, not operators'. */
  registrations: number;
  matches: { all: number; againstAgents: number; againstHouse: number; finished: number; finishedRate: number | null };
}

export interface Metrics {
  asOf: string;
  weeks: WeekMetrics[];
  /** Owners by the week of their first match: how many played again 4 or more weeks after it. */
  retention: { cohort: string; owners: number; retained: number; due: boolean }[];
  gate: {
    /** docs/wager-mode.md 13: 50 weekly active owners for 4 consecutive complete weeks, 30% still playing a month on. */
    activeOwnersNeeded: number;
    weeksNeeded: number;
    /** Consecutive complete weeks, ending with the last one, at or above the line. */
    weeksAtOrAbove: number;
    retentionNeeded: number;
    /** Over cohorts that are due, or null before any is. */
    retention: number | null;
    met: boolean;
  };
  /** docs/arena.md 2: rethink below 15 weekly active owners or a 70% finished-match rate after 8 weeks. */
  killLine: { activeOwners: number; finishedRate: number };
  notTracked: string[];
}

/** The last `weeks` weeks' numbers, the current one included. */
export async function readMetrics(store: Store, now: number, fighters: Fighter[], weeks = 12): Promise<Metrics> {
  const current = weekStart(now);
  const starts = Array.from({ length: weeks }, (_, i) => weekStart(startMs(current) - (weeks - 1 - i) * WEEK_MS));
  const docs = new Map<string, WeekDoc>();
  for (const w of starts) docs.set(w, (await store.get<WeekDoc>(week(w)))?.value ?? { owners: [], operators: [], matches: {} });
  const first = (await store.get<Record<string, string>>(FIRST))?.value ?? {};

  const rows: WeekMetrics[] = starts.map((w) => {
    const doc = docs.get(w)!;
    const facts = Object.values(doc.matches);
    const finished = facts.filter((f) => f.finished).length;
    const registrations = fighters.filter((f) => !f.operator && weekStart(f.registeredAt) === w).length;
    return {
      week: w,
      complete: w !== current,
      activeOwners: doc.owners.length,
      operatorOwners: doc.operators.length,
      registrations,
      matches: {
        all: facts.length,
        againstAgents: facts.filter((f) => !f.house).length,
        againstHouse: facts.filter((f) => f.house).length,
        finished,
        finishedRate: facts.length ? Math.round((finished / facts.length) * 1000) / 1000 : null,
      },
    };
  });

  const retention = starts
    .map((w) => {
      const cohort = Object.entries(first).filter(([, f]) => f === w).map(([o]) => o);
      const later = starts.filter((x) => startMs(x) >= startMs(w) + 4 * WEEK_MS);
      const retained = cohort.filter((o) => later.some((x) => docs.get(x)!.owners.includes(o))).length;
      // Due once the week four weeks on has ended: an owner has had that whole week to come back.
      return { cohort: w, owners: cohort.length, retained, due: startMs(w) + 5 * WEEK_MS <= startMs(current) };
    })
    .filter((c) => c.owners > 0);

  const NEEDED = 50, WEEKS = 4, RETAIN = 0.3;
  let run = 0;
  for (const row of rows.filter((r) => r.complete).reverse()) {
    if (row.activeOwners < NEEDED) break;
    run++;
  }
  const due = retention.filter((c) => c.due);
  const dueOwners = due.reduce((n, c) => n + c.owners, 0);
  const rate = dueOwners ? Math.round((due.reduce((n, c) => n + c.retained, 0) / dueOwners) * 1000) / 1000 : null;
  return {
    asOf: new Date(now).toISOString(),
    weeks: rows,
    retention,
    gate: { activeOwnersNeeded: NEEDED, weeksNeeded: WEEKS, weeksAtOrAbove: run, retentionNeeded: RETAIN, retention: rate, met: run >= WEEKS && rate !== null && rate >= RETAIN },
    killLine: { activeOwners: 15, finishedRate: 0.7 },
    notTracked: ["spectators per match", "launches whose first registration is an arena one", "owners asking for stakes unprompted"],
  };
}
