import type { Side } from "highwire-core/arena";
import { deadlineAfter, stateOf } from "./match.ts";
import type { Fighter, Match, Outage } from "./types.ts";

// What leaves the referee. A match view is built from the revealed rounds and, for a fighter looking at its own match,
// what is true of its own side. Nothing about the open round's other side is ever read here: not its move, not
// whether it has arrived, not its bank since the last reveal. A spectator sees exactly what either side sees of the
// other. (test/referee.test.ts compares views with and without a pending move, byte for byte.)

export interface MatchView {
  id: string;
  rules: string;
  /** The side this view is for, or null for a spectator. */
  you: Side | null;
  sides: Record<Side, { kind: "fighter" | "house"; id: string; name: string; bank: number }>;
  /** The round being played now, or null when the match is over. */
  round: number | null;
  node: number;
  energy: Record<Side, number>;
  spent: Record<Side, number>;
  rounds: Match["rounds"];
  house: { bot: string; side: Side; seedCommitment: string; seed: string | null } | null;
  ending: Match["ending"];
  endedAt: number | null;
  /** Only in a fighter's own view, about its own side. */
  self?: {
    fallback: string;
    bank: number;
    /** Whether its move for this round is in. */
    moved: boolean;
    /** When its fallback plays if it doesn't move (ms since the epoch), while the round waits on it. */
    deadline: number | null;
  };
}

export const fallbackText = (f: Match["sides"]["a"]["fallback"]) => (f.kind === "steady" ? `steady:${f.pull}` : f.kind);

export function viewMatch(m: Match, you: Side | null, outages: Outage[]): MatchView {
  const s = stateOf(m);
  const side = (x: Side) => ({ kind: m.sides[x].kind, id: m.sides[x].id, name: m.sides[x].name, bank: m.sides[x].bankShown });
  const v: MatchView = {
    id: m.id,
    rules: m.rules.id,
    you,
    sides: { a: side("a"), b: side("b") },
    round: m.ending ? null : (m.open?.round ?? null),
    node: s.node,
    energy: s.energy,
    spent: s.spent,
    rounds: m.rounds,
    house: m.house ? { bot: m.house.bot, side: m.house.side, seedCommitment: m.house.seedCommitment, seed: m.ending ? m.house.seed : null } : null,
    ending: m.ending,
    endedAt: m.endedAt,
  };
  if (you) {
    const me = m.sides[you];
    const mine = m.open?.moves[you];
    v.self = {
      fallback: fallbackText(me.fallback),
      bank: me.bank,
      moved: Boolean(mine),
      deadline: m.open && !mine ? deadlineAfter(m.open.openedAt, Math.min(m.rules.roundSeconds, me.bank) * 1000, outages) : null,
    };
  }
  return v;
}

export interface FighterView {
  id: string;
  name: string;
  ticker: string;
  rating: number;
  deviation: number;
  provisional: boolean;
  record: Fighter["record"];
  operator: boolean;
  /** Whether it may have a leaderboard row and a coin link now. */
  listed: boolean;
  match: string | null;
}

export function viewFighter(f: Fighter, provisionalRd: number): FighterView {
  return {
    id: f.id,
    name: f.name,
    ticker: f.ticker,
    rating: Math.round(f.rating.r),
    deviation: Math.round(f.rating.rd),
    provisional: f.rating.rd >= provisionalRd,
    record: f.record,
    operator: f.operator,
    listed: Boolean(f.standing?.listedOk),
    match: f.match,
  };
}
