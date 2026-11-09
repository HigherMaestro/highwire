import { sha256 } from "@noble/hashes/sha2";
import { chargeClock, fallbackPull, other, playRound, startMatch, type ArenaRules, type Fallback, type MatchState, type Side } from "./rules.ts";

// A wager series (docs/wager-mode.md 4.2, 7.2): five matches of the arena's rules between two players, played as the
// on-chain program plays them. Each round is two phases: both sides commit to a hidden pull, then both reveal. A side
// that misses its commit plays its declared fallback, which it committed to when the series started and reveals in the
// reveal phase; a side that commits (or owes a fallback) and doesn't reveal in time forfeits the match. A side whose
// bank runs out stays on its fallback for the rest of the series. This file is the program's twin: the Rust in
// programs/line-wager replays fixtures generated from it, and replays in the browser use it. Times are whole seconds
// (the chain's clock), never earlier than the phase they act in. Pure: no I/O, no clock of its own.

export type Player = "A" | "B";
export const MATCHES = 5;

export interface SeriesConfig {
  rules: ArenaRules;
  /** How long both sides have to reveal once both commits are in (docs/wager-mode.md 7.2.1). */
  revealSeconds: number;
}

/** Player A takes side "a" in matches 0, 2 and 4, side "b" in 1 and 3. */
export const sideOf = (player: Player, match: number): Side => ((player === "A") === (match % 2 === 0) ? "a" : "b");
export const playerOf = (side: Side, match: number): Player => (sideOf("A", match) === side ? "A" : "B");

export type MatchResult = { winner: Player | null; reason: "reached_end" | "rounds_up" | "tie_break" | "draw" | "missed_reveal" | "void" };
export type SeriesEnding = { winner: Player | null; reason: "decided" | "draw" | "retired" };

interface SideRound {
  /** The commitment, once sent. */
  hash: string | null;
  /** The side missed its commit (or its bank is out): it owes its fallback's reveal. */
  owesFallback: boolean;
  /** The pull, once revealed (or computed from the revealed fallback). */
  pull: number | null;
}

export interface SeriesState {
  config: SeriesConfig;
  seriesId: string;
  /** Each player's fallback commitment, from open and accept. */
  fallbackHash: Record<Player, string>;
  /** Each player's fallback once revealed: public for the rest of the series. */
  fallback: Record<Player, Fallback | null>;
  match: number;
  game: MatchState;
  /** Each player's bank in this match, in seconds, and whether it's out. */
  bank: Record<Player, number>;
  bankOut: Record<Player, boolean>;
  phase: "commit" | "reveal";
  phaseOpenedAt: number;
  round: Record<Side, SideRound>;
  results: MatchResult[];
  ending: SeriesEnding | null;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const FALLBACK_KIND: Record<Fallback["kind"], number> = { zero: 0, steady: 1, mirror: 2 };

const isByte = (n: number) => Number.isInteger(n) && n >= 0 && n <= 255;

/** A move's commitment: SHA-256 of the series id (32 bytes), the match, the round, the side (0 a, 1 b), the pull and a 32-byte nonce. */
export function moveCommitment(seriesId: string, match: number, round: number, side: Side, pull: number, nonce: string): string {
  if (!/^[0-9a-f]{64}$/.test(seriesId) || !/^[0-9a-f]{64}$/.test(nonce)) throw new Error("the series id and the nonce are 32 bytes of hex");
  if (!isByte(match) || !isByte(round) || !isByte(pull)) throw new Error("the match, the round and the pull are whole numbers from 0 to 255");
  if (side !== "a" && side !== "b") throw new Error('the side is "a" or "b"');
  return hex(sha256(Uint8Array.from([...bytes(seriesId), match, round, side === "a" ? 0 : 1, pull, ...bytes(nonce)])));
}

/** A fallback the program accepts: a known kind; steady's pull a whole number from 0 to 99; no pull for zero or mirror. */
export function validFallback(f: Fallback): boolean {
  if (f.kind === "zero" || f.kind === "mirror") return !("pull" in f) || (f as { pull?: unknown }).pull === undefined || (f as { pull?: unknown }).pull === 0;
  return f.kind === "steady" && Number.isInteger(f.pull) && f.pull >= 0 && f.pull <= 99;
}

/** A fallback's commitment: SHA-256 of "fb", the series id, the player (0 A, 1 B), the kind, its pull and a 32-byte salt (fresh per series). */
export function fallbackCommitment(seriesId: string, player: Player, f: Fallback, salt: string): string {
  if (!/^[0-9a-f]{64}$/.test(seriesId) || !/^[0-9a-f]{64}$/.test(salt)) throw new Error("the series id and the salt are 32 bytes of hex");
  if (!validFallback(f)) throw new Error("not a fallback the program accepts");
  const steady = f.kind === "steady" ? f.pull : 0;
  return hex(sha256(Uint8Array.from([0x66, 0x62, ...bytes(seriesId), player === "A" ? 0 : 1, FALLBACK_KIND[f.kind], steady, ...bytes(salt)])));
}

const fresh = (): Record<Side, SideRound> => ({ a: { hash: null, owesFallback: false, pull: null }, b: { hash: null, owesFallback: false, pull: null } });

/** A series once both stakes are in: round 1 of match 1 opens at `at`. */
export function startSeries(config: SeriesConfig, seriesId: string, fallbackHash: Record<Player, string>, at: number): SeriesState {
  const s: SeriesState = {
    config, seriesId, fallbackHash, fallback: { A: null, B: null },
    match: 0, game: startMatch(config.rules), bank: { A: config.rules.bankSeconds, B: config.rules.bankSeconds }, bankOut: { A: false, B: false },
    phase: "commit", phaseOpenedAt: at, round: fresh(), results: [], ending: null,
  };
  openCommit(s, at);
  return s;
}

/** Opens a commit phase: a side whose bank is out owes its fallback at once. */
function openCommit(s: SeriesState, at: number): void {
  s.phase = "commit";
  s.phaseOpenedAt = at;
  s.round = fresh();
  for (const side of ["a", "b"] as const) if (s.bankOut[playerOf(side, s.match)]) s.round[side].owesFallback = true;
  // Both banks out: neither side is there, so the match is void, as in free play.
  if (s.round.a.owesFallback && s.round.b.owesFallback) return endMatch(s, { winner: null, reason: "void" }, at);
  // One bank out with its fallback known plays it as soon as the other side commits (maybeReveal).
}

/** The latest a side may commit in the open phase. */
export function commitDeadline(s: SeriesState, side: Side): number {
  const p = playerOf(side, s.match);
  return s.phaseOpenedAt + Math.min(s.config.rules.roundSeconds, s.bank[p]);
}
export const revealDeadline = (s: SeriesState) => s.phaseOpenedAt + s.config.revealSeconds;

const fail = (m: string): never => { throw new Error(m); };
const checkPlayer = (p: Player) => { if (p !== "A" && p !== "B") fail('the player is "A" or "B"'); };
/** Every act's time: a whole number of seconds, never before the phase it acts in (the chain's clock doesn't go back). */
const checkTime = (s: SeriesState, at: number) => {
  if (!Number.isInteger(at)) fail("the time is a whole number of seconds");
  if (at < s.phaseOpenedAt) fail("the clock went backward");
};
const committedOrOwed = (r: SideRound) => r.hash !== null || r.owesFallback;

/**
 * Once both sides have committed or owe their fallback, the reveal phase opens. A fallback already revealed earlier in
 * the series is public, so it plays at once, from the state now that both sides are in.
 */
function maybeReveal(s: SeriesState, at: number): void {
  if (!(committedOrOwed(s.round.a) && committedOrOwed(s.round.b))) return;
  s.phase = "reveal";
  s.phaseOpenedAt = at;
  for (const side of ["a", "b"] as const) {
    const r = s.round[side], f = s.fallback[playerOf(side, s.match)];
    if (r.owesFallback && f) r.pull = fallbackPull(f, s.game, side);
  }
  if (s.round.a.pull !== null && s.round.b.pull !== null) resolve(s, at);
}

/** A side commits to its pull for the open round. */
export function commit(s: SeriesState, player: Player, round: number, hash: string, at: number): void {
  checkPlayer(player);
  if (s.ending) fail("the series is over");
  if (s.phase !== "commit") fail("not a commit phase");
  checkTime(s, at);
  if (round !== s.game.rounds.length + 1) fail(`this is round ${s.game.rounds.length + 1}`);
  if (!/^[0-9a-f]{64}$/.test(hash)) fail("a commitment is 32 bytes of hex");
  const side = sideOf(player, s.match), r = s.round[side];
  if (committedOrOwed(r)) fail("already committed this round");
  // As free play's clock: a move must land before the round's time (or the bank) runs out, never on it.
  if (at >= commitDeadline(s, side)) fail("too late: the fallback plays");
  const charge = chargeClock(s.config.rules, s.bank[player], at - s.phaseOpenedAt);
  s.bank[player] = charge.bank;
  s.bankOut[player] = charge.bankOut;
  r.hash = hash;
  maybeReveal(s, at);
}

/** A side reveals its pull and nonce, or (when it owes its fallback) its fallback and salt. */
export function reveal(s: SeriesState, player: Player, input: { pull: number; nonce: string } | { fallback: Fallback; salt: string }, at: number): void {
  checkPlayer(player);
  if (s.ending) fail("the series is over");
  if (s.phase !== "reveal") fail("not a reveal phase");
  checkTime(s, at);
  if (at > revealDeadline(s)) fail("too late: the reveal window has closed");
  const side = sideOf(player, s.match), r = s.round[side];
  if (r.pull !== null) fail("already revealed this round");
  if ("fallback" in input) {
    if (!r.owesFallback) fail("this side committed a pull; reveal it");
    if (!validFallback(input.fallback)) fail("that isn't the committed fallback");
    if (fallbackCommitment(s.seriesId, player, input.fallback, input.salt) !== s.fallbackHash[player]) fail("that isn't the committed fallback");
    s.fallback[player] = input.fallback;
    r.pull = fallbackPull(input.fallback, s.game, side);
  } else {
    if (r.owesFallback) fail("this side owes its fallback");
    if (moveCommitment(s.seriesId, s.match, s.game.rounds.length + 1, side, input.pull, input.nonce) !== r.hash) fail("that doesn't match the commitment");
    if (!Number.isInteger(input.pull) || input.pull < 0 || input.pull > s.game.energy[side]) fail("an illegal pull: it can't be more than the energy left");
    r.pull = input.pull;
  }
  if (s.round.a.pull !== null && s.round.b.pull !== null) resolve(s, at);
}

function resolve(s: SeriesState, at: number): void {
  s.game = playRound(s.game, s.round.a.pull!, s.round.b.pull!);
  const e = s.game.ending;
  if (e) {
    const winner = e.winner ? playerOf(e.winner, s.match) : null;
    endMatch(s, { winner, reason: e.reason as MatchResult["reason"] }, at);
  } else openCommit(s, at);
}

function endMatch(s: SeriesState, result: MatchResult, at: number): void {
  s.results.push(result);
  const wins = (p: Player) => s.results.filter((r) => r.winner === p).length;
  const left = MATCHES - s.results.length;
  const [a, b] = [wins("A"), wins("B")];
  if (a > b + left) s.ending = { winner: "A", reason: "decided" };
  else if (b > a + left) s.ending = { winner: "B", reason: "decided" };
  else if (left === 0) s.ending = a === b ? { winner: null, reason: "draw" } : { winner: a > b ? "A" : "B", reason: "decided" };
  if (s.ending) return;
  s.match += 1;
  s.game = startMatch(s.config.rules);
  // Banks refill each match, but a side whose bank ran out stays on its fallback for the rest of the series.
  s.bank = { A: s.bankOut.A ? 0 : s.config.rules.bankSeconds, B: s.bankOut.B ? 0 : s.config.rules.bankSeconds };
  openCommit(s, at);
}

/**
 * Anyone may call this after a deadline. In a commit phase, it applies only once every side that hasn't committed is
 * past its own deadline, so nothing about one side is published while the other can still move; each late side then
 * owes its fallback, its bank charged for its whole time. In a reveal phase past the window, a side that hasn't
 * revealed forfeits the match; both missing makes the match void.
 */
export function timeout(s: SeriesState, at: number): void {
  if (s.ending) fail("the series is over");
  checkTime(s, at);
  if (s.phase === "commit") {
    const late = (["a", "b"] as const).filter((side) => !committedOrOwed(s.round[side]));
    if (!late.length) fail("nothing has timed out yet");
    if (late.some((side) => at < commitDeadline(s, side))) fail("a side still has time to commit");
    for (const side of late) {
      const p = playerOf(side, s.match);
      const charge = chargeClock(s.config.rules, s.bank[p], commitDeadline(s, side) - s.phaseOpenedAt);
      s.bank[p] = charge.bank;
      s.bankOut[p] = charge.bankOut;
      s.round[side].owesFallback = true;
    }
    maybeReveal(s, at);
    return;
  }
  if (at <= revealDeadline(s)) fail("the reveal window is still open");
  const missed = (["a", "b"] as const).filter((side) => s.round[side].pull === null);
  if (missed.length === 2) endMatch(s, { winner: null, reason: "void" }, at);
  else endMatch(s, { winner: playerOf(other(missed[0]!), s.match), reason: "missed_reveal" }, at);
}

/** A player retires: it forfeits the series. */
export function retire(s: SeriesState, player: Player): void {
  checkPlayer(player);
  if (s.ending) fail("the series is over");
  s.ending = { winner: player === "A" ? "B" : "A", reason: "retired" };
}
