// How a staked series of The Lot would run on-chain, and where its prizes come from (docs/research/new-games.md 1.4).
// A prototype of the protocol, not a program: it follows src/arena/series.ts, the wager program's twin for the wire,
// and differs where a random draw forces it to.
//
// Every prize is drawn from an entropy value that both players feed and neither controls:
//   - It starts from two seeds. A commits to its seed when it opens the series, B posts its seed in the clear when it
//     accepts (A's is still hidden), and A then reveals. A can't change its seed; B can't see A's when choosing its own.
//   - Each round both sides commit to a bid with a 32-byte nonce, then both reveal. The two nonces are mixed into the
//     entropy, and the next prize is drawn from it. Each nonce was fixed before the other was visible.
//   - The side that reveals second can see the draw before it reveals. All it can do is not reveal, and that forfeits
//     the match: so does a missed commit. There is no round in which only one side supplied a nonce, and no fallback
//     the program plays: a fallback is the owner's daemon committing an ordinary bid.
// Nothing here is secret but the seeds and nonces before they're revealed: the design assumes everyone has read it.

import { sha256 } from "@noble/hashes/sha2";
import type { Side } from "../../src/arena/rules.ts";
import { playLot, startLot, type LotRules, type LotState } from "./lot.ts";

export type Player = "A" | "B";

export interface LotSeriesConfig {
  rules: LotRules;
  matches: number;
  /** How long a side has to commit once a round opens, and both sides to reveal once both commits are in. */
  commitSeconds: number;
  revealSeconds: number;
}

/** Player A takes side "a" in matches 0, 2 and 4, side "b" in 1 and 3, as on the wire. */
export const sideOf = (player: Player, match: number): Side => ((player === "A") === (match % 2 === 0) ? "a" : "b");
export const playerOf = (side: Side, match: number): Player => (sideOf("A", match) === side ? "A" : "B");
const otherSide = (s: Side): Side => (s === "a" ? "b" : "a");

export type LotMatchResult = { winner: Player | null; reason: "outscored" | "decided" | "draw" | "missed_seed" | "missed_commit" | "missed_reveal" | "void" };
export type LotSeriesEnding = { winner: Player | null; reason: "decided" | "draw" };

interface SideRound {
  hash: string | null;
  bid: number | null;
  nonce: string | null;
}

/** One draw, with everything needed to check it from public data. */
export interface DrawRecord {
  match: number;
  /** The round the prize is offered in (1 for a match's first). */
  round: number;
  /** The entropy it was drawn from, and the prize. */
  entropy: string;
  prize: number;
}

export interface LotSeriesState {
  config: LotSeriesConfig;
  seriesId: string;
  /** A's commitment to its seed, B's seed in the clear, and A's seed once revealed. */
  seedHash: string;
  seedB: string;
  seedA: string | null;
  /** What every prize is drawn from. null until the seed step ends. */
  entropy: string | null;
  match: number;
  /** The match in play. null during the seed step. */
  game: LotState | null;
  phase: "seed" | "commit" | "reveal";
  phaseOpenedAt: number;
  round: Record<Side, SideRound>;
  results: LotMatchResult[];
  /** Every draw, in order: the series' public record of where its prizes came from. */
  draws: DrawRecord[];
  /** Every nonce pair mixed in, in order (public once revealed). */
  mixed: { match: number; round: number; a: string; b: string }[];
  ending: LotSeriesEnding | null;
}

const HEX32 = /^[0-9a-f]{64}$/;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const tag = (t: string) => new TextEncoder().encode(t);
const isByte = (n: number) => Number.isInteger(n) && n >= 0 && n <= 255;
const fail = (m: string): never => {
  throw new Error(m);
};

/** A's commitment to its seed: SHA-256 of "lot-seed", the series id and the seed. */
export function seedCommitment(seriesId: string, seed: string): string {
  if (!HEX32.test(seriesId) || !HEX32.test(seed)) fail("the series id and the seed are 32 bytes of hex");
  return hex(sha256(Uint8Array.from([...tag("lot-seed"), ...bytes(seriesId), ...bytes(seed)])));
}

/** A bid's commitment: SHA-256 of "lot-bid", the series id, the match, the round, the side (0 a, 1 b), the bid and a 32-byte nonce. */
export function bidCommitment(seriesId: string, match: number, round: number, side: Side, bid: number, nonce: string): string {
  if (!HEX32.test(seriesId) || !HEX32.test(nonce)) fail("the series id and the nonce are 32 bytes of hex");
  if (!isByte(match) || !isByte(round) || !isByte(bid)) fail("the match, the round and the bid are whole numbers from 0 to 255");
  if (side !== "a" && side !== "b") fail('the side is "a" or "b"');
  return hex(sha256(Uint8Array.from([...tag("lot-bid"), ...bytes(seriesId), match, round, side === "a" ? 0 : 1, bid, ...bytes(nonce)])));
}

/** The entropy the series starts from: both seeds, bound to the series. With A's seed missing, B's alone. */
export function firstEntropy(seriesId: string, seedA: string | null, seedB: string): string {
  return hex(sha256(Uint8Array.from([...tag("lot-entropy-0"), ...bytes(seriesId), ...(seedA ? bytes(seedA) : []), ...bytes(seedB)])));
}

/** The entropy after a round: the old value with both sides' nonces mixed in, side a's first whoever revealed first. */
export function mixEntropy(entropy: string, nonceA: string, nonceB: string): string {
  return hex(sha256(Uint8Array.from([...tag("lot-entropy"), ...bytes(entropy), ...bytes(nonceA), ...bytes(nonceB)])));
}

/**
 * The prize offered in `round` of `match`, from those left. The hash is read as one 256-bit number and reduced by the
 * count left, so no prize is favoured by more than one part in 2^250.
 */
export function drawFrom(entropy: string, match: number, round: number, left: number[]): number {
  if (!left.length) fail("no prize is left to draw");
  const h = sha256(Uint8Array.from([...tag("lot-draw"), ...bytes(entropy), match, round]));
  return left[Number(BigInt(`0x${hex(h)}`) % BigInt(left.length))]!;
}

const fresh = (): Record<Side, SideRound> => ({ a: { hash: null, bid: null, nonce: null }, b: { hash: null, bid: null, nonce: null } });

/** A series once both stakes are in: A's seed commitment came with its stake, B's seed with its own. A reveals next. */
export function openLotSeries(config: LotSeriesConfig, seriesId: string, seedHash: string, seedB: string, at: number): LotSeriesState {
  if (!HEX32.test(seriesId) || !HEX32.test(seedHash) || !HEX32.test(seedB)) fail("the series id, the seed commitment and the seed are 32 bytes of hex");
  return {
    config, seriesId, seedHash, seedB, seedA: null, entropy: null,
    match: 0, game: null, phase: "seed", phaseOpenedAt: at, round: fresh(), results: [], draws: [], mixed: [], ending: null,
  };
}

const checkPlayer = (p: Player) => {
  if (p !== "A" && p !== "B") fail('the player is "A" or "B"');
};
const checkTime = (s: LotSeriesState, at: number) => {
  if (!Number.isInteger(at)) fail("the time is a whole number of seconds");
  if (at < s.phaseOpenedAt) fail("the clock went backward");
};
export const commitDeadline = (s: LotSeriesState) => s.phaseOpenedAt + s.config.commitSeconds;
export const revealDeadline = (s: LotSeriesState) => s.phaseOpenedAt + s.config.revealSeconds;

function startNextMatch(s: LotSeriesState, at: number): void {
  const first = drawFrom(s.entropy!, s.match, 1, s.config.rules.prizes);
  s.draws.push({ match: s.match, round: 1, entropy: s.entropy!, prize: first });
  s.game = startLot(s.config.rules, first);
  s.phase = "commit";
  s.phaseOpenedAt = at;
  s.round = fresh();
}

/** A reveals the seed it committed to. The first prize follows from both seeds. */
export function revealSeed(s: LotSeriesState, seed: string, at: number): void {
  if (s.ending) fail("the series is over");
  if (s.phase !== "seed") fail("the seed is already in");
  checkTime(s, at);
  if (at > revealDeadline(s)) fail("too late: the seed window has closed");
  if (!HEX32.test(seed) || seedCommitment(s.seriesId, seed) !== s.seedHash) fail("that isn't the committed seed");
  s.seedA = seed;
  s.entropy = firstEntropy(s.seriesId, seed, s.seedB);
  startNextMatch(s, at);
}

/** A side commits to its bid for the open round. Final: it can't be replaced. */
export function commit(s: LotSeriesState, player: Player, round: number, hash: string, at: number): void {
  checkPlayer(player);
  if (s.ending) fail("the series is over");
  if (s.phase !== "commit") fail("not a commit phase");
  checkTime(s, at);
  if (round !== s.game!.rounds.length + 1) fail(`this is round ${s.game!.rounds.length + 1}`);
  if (!HEX32.test(hash)) fail("a commitment is 32 bytes of hex");
  const r = s.round[sideOf(player, s.match)];
  if (r.hash !== null) fail("already committed this round");
  if (at >= commitDeadline(s)) fail("too late to commit");
  r.hash = hash;
  if (s.round.a.hash !== null && s.round.b.hash !== null) {
    s.phase = "reveal";
    s.phaseOpenedAt = at;
  }
}

/** A side reveals its bid and nonce. Only once both commitments are in, so no nonce is seen before the other is fixed. */
export function reveal(s: LotSeriesState, player: Player, bid: number, nonce: string, at: number): void {
  checkPlayer(player);
  if (s.ending) fail("the series is over");
  if (s.phase !== "reveal") fail("not a reveal phase");
  checkTime(s, at);
  if (at > revealDeadline(s)) fail("too late: the reveal window has closed");
  const side = sideOf(player, s.match), r = s.round[side], game = s.game!;
  if (r.bid !== null) fail("already revealed this round");
  if (!HEX32.test(nonce) || !isByte(bid) || bidCommitment(s.seriesId, s.match, game.rounds.length + 1, side, bid, nonce) !== r.hash) fail("that doesn't match the commitment");
  if (bid > game.energy[side]) fail("an illegal bid: it can't be more than the energy left");
  r.bid = bid;
  r.nonce = nonce;
  if (s.round.a.bid !== null && s.round.b.bid !== null) resolve(s, at);
}

function resolve(s: LotSeriesState, at: number): void {
  const game = s.game!, round = game.rounds.length + 1;
  s.entropy = mixEntropy(s.entropy!, s.round.a.nonce!, s.round.b.nonce!);
  s.mixed.push({ match: s.match, round, a: s.round.a.nonce!, b: s.round.b.nonce! });
  // The draw happens whether or not this round ends the match: the rules ignore it when it does.
  const next = game.left.length ? drawFrom(s.entropy, s.match, round + 1, game.left) : undefined;
  s.game = playLot(game, s.round.a.bid!, s.round.b.bid!, next);
  const e = s.game.ending;
  if (e) return endMatch(s, { winner: e.winner ? playerOf(e.winner, s.match) : null, reason: e.reason }, at);
  s.draws.push({ match: s.match, round: round + 1, entropy: s.entropy, prize: next! });
  s.phase = "commit";
  s.phaseOpenedAt = at;
  s.round = fresh();
}

function endMatch(s: LotSeriesState, result: LotMatchResult, at: number): void {
  s.results.push(result);
  const wins = (p: Player) => s.results.filter((r) => r.winner === p).length;
  const left = s.config.matches - s.results.length;
  const [a, b] = [wins("A"), wins("B")];
  if (a > b + left) s.ending = { winner: "A", reason: "decided" };
  else if (b > a + left) s.ending = { winner: "B", reason: "decided" };
  else if (left === 0) s.ending = a === b ? { winner: null, reason: "draw" } : { winner: a > b ? "A" : "B", reason: "decided" };
  if (s.ending) return;
  s.match += 1;
  startNextMatch(s, at);
}

/**
 * Anyone may call this after a deadline, and only after it. A missed seed costs A the first match, and the series goes
 * on from B's seed alone. A side that hasn't committed, or hasn't revealed, forfeits the match; both missing makes it
 * void. A forfeited round's nonces are never mixed in, so the entropy is what it was when the round opened.
 */
export function timeout(s: LotSeriesState, at: number): void {
  if (s.ending) fail("the series is over");
  checkTime(s, at);
  if (s.phase === "seed") {
    if (at <= revealDeadline(s)) fail("the seed window is still open");
    s.entropy = firstEntropy(s.seriesId, null, s.seedB);
    return endMatch(s, { winner: "B", reason: "missed_seed" }, at);
  }
  const missing = (["a", "b"] as const).filter((side) => (s.phase === "commit" ? s.round[side].hash === null : s.round[side].bid === null));
  if (s.phase === "commit") {
    if (at < commitDeadline(s)) fail("a side still has time to commit");
  } else if (at <= revealDeadline(s)) fail("the reveal window is still open");
  if (missing.length === 2) return endMatch(s, { winner: null, reason: "void" }, at);
  endMatch(s, { winner: playerOf(otherSide(missing[0]!), s.match), reason: s.phase === "commit" ? "missed_commit" : "missed_reveal" }, at);
}

/**
 * Checks every draw of a series from its public record alone: the seeds, the nonce pairs in order, and the prizes
 * drawn. Returns the first thing that doesn't follow, or null when everything does. What a replay page would run.
 */
export function auditDraws(s: Pick<LotSeriesState, "config" | "seriesId" | "seedHash" | "seedA" | "seedB" | "draws" | "mixed">): string | null {
  if (s.seedA !== null && seedCommitment(s.seriesId, s.seedA) !== s.seedHash) return "A's seed isn't the one it committed to";
  let entropy = firstEntropy(s.seriesId, s.seedA, s.seedB);
  let mixed = 0, left: number[] = [];
  for (const d of s.draws) {
    if (d.round === 1) left = [...s.config.rules.prizes];
    else {
      const m = s.mixed[mixed++];
      if (!m || m.match !== d.match || m.round !== d.round - 1) return `match ${d.match + 1} round ${d.round}: no nonces for the round before`;
      entropy = mixEntropy(entropy, m.a, m.b);
    }
    // Rounds that ended a match mixed their nonces in without a draw: catch up with them before a first round.
    while (d.round === 1 && mixed < s.mixed.length && s.mixed[mixed]!.match < d.match) entropy = mixEntropy(entropy, s.mixed[mixed]!.a, s.mixed[mixed++]!.b);
    if (d.entropy !== entropy) return `match ${d.match + 1} round ${d.round}: the entropy doesn't follow from the seeds and nonces`;
    if (drawFrom(entropy, d.match, d.round, left) !== d.prize) return `match ${d.match + 1} round ${d.round}: the prize isn't the one the entropy draws`;
    left.splice(left.indexOf(d.prize), 1);
  }
  return null;
}
