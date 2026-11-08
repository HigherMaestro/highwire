import { sha256 } from "@noble/hashes/sha2";
import {
  chargeClock,
  fallbackPull,
  forfeit as forfeitState,
  houseMove,
  other,
  playRound,
  pullProblem,
  replay,
  seedCommitment,
  type ArenaRules,
  type Fallback,
  type HouseBot,
  type MatchState,
  type Side,
} from "highwire-core/arena";
import { fail } from "../errors.ts";
import type { Match, MatchSide, Outage, PendingMove, Reveal } from "./types.ts";

// A match as pure functions of its document and the time: opening rounds, moves, the lazy chess clock, reveals and
// endings. The referee loads a match, calls these, and writes it back. Nothing here reads the store or the clock.

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const text = (s: string) => new TextEncoder().encode(s);

/** SHA-256 of `match|round|side|pull|nonce`, hex: what a reveal publishes for each side's move. */
export function commitment(matchId: string, round: number, side: Side, pull: number, nonce: string): string {
  return hex(sha256(text(`${matchId}|${round}|${side}|${pull}|${nonce}`)));
}

/** The game's state from the revealed rounds (and the match's own ending, for forfeits and voids). */
export function stateOf(m: Match): MatchState {
  const s = replay(m.rules, m.rounds.map((r) => [r.a.pull, r.b.pull]));
  return m.ending && !s.ending ? { ...s, ending: m.ending } : s;
}

/** Milliseconds of `[start, end)` outside the outages. */
export function activeMs(start: number, end: number, outages: Outage[]): number {
  let t = Math.max(0, end - start);
  for (const o of outages) t -= Math.max(0, Math.min(end, o.to) - Math.max(start, o.from));
  return Math.max(0, t);
}

/** When `ms` of active time will have passed since `start`, skipping the outages. */
export function deadlineAfter(start: number, ms: number, outages: Outage[]): number {
  let t = start + ms;
  // Each outage that starts before the current deadline pushes it back by its overlap; repeat until it settles.
  for (let i = 0; i < 20; i++) {
    const next = start + ms + (t - start - activeMs(start, t, outages));
    if (next === t) break;
    t = next;
  }
  return t;
}

export interface NewHouseMatch {
  id: string;
  rules: ArenaRules;
  now: number;
  fighter: { id: string; name: string; fallback: Fallback };
  fighterSide: Side;
  bot: HouseBot;
  seed: string;
}

export function newHouseMatch(o: NewHouseMatch): Match {
  const houseSide = other(o.fighterSide);
  const bank = o.rules.bankSeconds;
  const fighterSide: MatchSide = { kind: "fighter", id: o.fighter.id, name: o.fighter.name, fallback: o.fighter.fallback, bank, bankShown: bank, bankOut: false };
  const house: MatchSide = { kind: "house", id: o.bot, name: o.bot === "even" ? "Even" : "Reader", fallback: { kind: "zero" }, bank, bankShown: bank, bankOut: false };
  const m: Match = {
    id: o.id,
    rules: o.rules,
    createdAt: o.now,
    sides: o.fighterSide === "a" ? { a: fighterSide, b: house } : { a: house, b: fighterSide },
    house: { bot: o.bot, side: houseSide, seedCommitment: seedCommitment(o.seed), seed: o.seed },
    rounds: [],
    open: null,
    ending: null,
    endedAt: null,
    rated: false,
    settled: false,
  };
  openRound(m, o.now);
  return m;
}

/** The house's nonce for a round: derived from the seed, so it's checkable once the seed is revealed. */
export const houseNonce = (seed: string, round: number) => hex(sha256(text(`highwire-arena|nonce|${seed}|${round}`))).slice(0, 32);

/** Opens the next round at `at`: the house moves now, and so does any side whose bank has run out. */
function openRound(m: Match, at: number): void {
  const state = stateOf(m);
  const round = m.rounds.length + 1;
  m.open = { round, openedAt: at, moves: {} };
  for (const side of ["a", "b"] as const) {
    const s = m.sides[side];
    if (s.kind === "house" && m.house) {
      const pull = houseMove(m.house.bot, state, side, m.house.seed);
      m.open.moves[side] = { pull, nonce: houseNonce(m.house.seed, round), line: "", arrivedAt: at, fallback: false };
    } else if (s.bankOut) {
      m.open.moves[side] = fallbackMove(s, state, side, at);
    }
  }
  // Neither fighter is here at all: no result.
  if (m.sides.a.kind === "fighter" && m.sides.b.kind === "fighter" && m.sides.a.bankOut && m.sides.b.bankOut) {
    m.ending = { winner: null, reason: "void" };
    m.endedAt = at;
    m.open = null;
  }
}

function fallbackMove(s: MatchSide, state: MatchState, side: Side, at: number): PendingMove {
  return { pull: fallbackPull(s.fallback, state, side), nonce: "", line: "", arrivedAt: at, fallback: true };
}

function reveal(m: Match, side: Side, move: PendingMove, openedAt: number, round: number): Reveal {
  return {
    pull: move.pull,
    nonce: move.nonce,
    line: move.line,
    arrivedMs: move.arrivedAt - openedAt,
    fallback: move.fallback,
    commitment: commitment(m.id, round, side, move.pull, move.nonce),
  };
}

/** Both sides have moved: reveal the round, then end the match or open the next round at `at`. */
function resolve(m: Match, at: number): void {
  const o = m.open!;
  const a = o.moves.a!;
  const b = o.moves.b!;
  const next = playRound(stateOf(m), a.pull, b.pull);
  m.rounds.push({
    round: o.round,
    openedAt: o.openedAt,
    a: reveal(m, "a", a, o.openedAt, o.round),
    b: reveal(m, "b", b, o.openedAt, o.round),
    winner: next.rounds.at(-1)!.winner,
    node: next.node,
    energy: next.energy,
  });
  m.sides.a.bankShown = m.sides.a.bank;
  m.sides.b.bankShown = m.sides.b.bank;
  m.open = null;
  if (next.ending) {
    m.ending = next.ending;
    m.endedAt = at;
  } else openRound(m, at);
}

/**
 * Plays the clock forward to `now`: any side whose round time (or bank) ran out gets its fallback, at the moment it ran
 * out, and rounds resolve and open as they would have. Returns whether anything changed.
 */
export function settle(m: Match, now: number, outages: Outage[]): boolean {
  let changed = false;
  while (m.open && !m.ending) {
    const o = m.open;
    for (const side of ["a", "b"] as const) {
      if (o.moves[side]) continue;
      const s = m.sides[side];
      const limit = Math.min(m.rules.roundSeconds, s.bank);
      const deadline = deadlineAfter(o.openedAt, limit * 1000, outages);
      if (now < deadline) continue;
      const charge = chargeClock(m.rules, s.bank, limit);
      s.bank = charge.bank;
      s.bankOut = charge.bankOut;
      o.moves[side] = fallbackMove(s, stateOf(m), side, deadline);
      changed = true;
    }
    if (!o.moves.a || !o.moves.b) break;
    resolve(m, Math.max(o.moves.a.arrivedAt, o.moves.b.arrivedAt));
    changed = true;
  }
  return changed;
}

export interface MoveInput {
  round: number;
  pull: unknown;
  nonce: unknown;
  line: string;
}

/**
 * A side's move for the open round, arriving at `now` (after `settle`). The same move again is accepted as it is; a
 * different one for a round it already moved in is a conflict; a round that's already revealed is late.
 */
export function applyMove(m: Match, side: Side, input: MoveInput, now: number, outages: Outage[]): { repeated: boolean } {
  if (m.ending) fail("late", "The match is over.");
  const o = m.open!;
  if (input.round < o.round) fail("late", `Round ${input.round} is already revealed; the referee played your fallback. This is round ${o.round}.`);
  if (input.round > o.round) fail("bad_request", `This is round ${o.round}, not ${input.round}.`);
  if (typeof input.nonce !== "string" || !/^[0-9a-f]{32}$/.test(input.nonce)) fail("bad_request", "The nonce is 16 random bytes as 32 lowercase hex characters.");
  const nonce = input.nonce as string;
  const mine = o.moves[side];
  if (mine) {
    if (!mine.fallback && mine.pull === input.pull && mine.nonce === nonce && mine.line === input.line) return { repeated: true };
    fail("conflict", `You already moved in round ${o.round}; a move is final.`);
  }
  const problem = pullProblem(stateOf(m), side, input.pull);
  if (problem) fail("bad_request", problem.charAt(0).toUpperCase() + problem.slice(1) + ".");
  const s = m.sides[side];
  const waited = activeMs(o.openedAt, now, outages) / 1000;
  const charge = chargeClock(m.rules, s.bank, waited);
  s.bank = charge.bank;
  s.bankOut = charge.bankOut;
  o.moves[side] = { pull: input.pull as number, nonce, line: input.line, arrivedAt: now, fallback: false };
  if (o.moves.a && o.moves.b) resolve(m, now);
  return { repeated: false };
}

/** A side quits: a loss for it. */
export function forfeitMatch(m: Match, side: Side, now: number): void {
  if (m.ending) return;
  m.ending = forfeitState(stateOf(m), side).ending;
  m.endedAt = now;
  m.open = null;
}

/** Whether a side contested the match: pulled more than 2 in at least 4 rounds (docs/arena.md 7, for draws). */
export function contested(m: Match, side: Side): boolean {
  return m.rounds.filter((r) => r[side].pull > 2).length >= 4;
}
