// How a staked series of The Lot would run on-chain, and where its prizes come from (docs/research/new-games.md 1.4).
// A prototype of the protocol, not a program: it follows src/arena/series.ts, the wager program's twin for the wire,
// and differs where a random draw forces it to.
//
// Every prize is drawn from entropy that both players feed and neither controls:
//   - The series has two seeds. A commits to its seed when it opens the series, B posts its seed in the clear when it
//     accepts (A's is still hidden), and A then reveals. A can't change its seed; B can't see A's when choosing its own.
//     Nothing is drawn until both are in: if A doesn't reveal in time it forfeits the match, and the window opens again.
//   - Each match's entropy starts from the two seeds and the match's number, and nothing else. So how one match ends
//     (played out, forfeited, void) can't change any draw in a later match.
//   - Within a match, each round both sides commit to a bid with a 32-byte nonce, then both reveal. The two nonces are
//     mixed into that match's entropy, and the next prize is drawn from it. Each nonce was fixed before the other was
//     visible.
//   - The side that reveals second can see the draw before it reveals. All it can do is not reveal, and that forfeits
//     the match: so does a missed commit. There is no round in which only one side supplied a nonce, and no fallback
//     the program plays: a fallback is the owner's daemon committing an ordinary bid.
// Nothing here is secret but the seeds and nonces before they're revealed: the design assumes everyone has read it.
// Two adversarial reviews shaped it (docs/research/new-games.md 1.6); the first version let the loser of a match pick
// the better of two openings for the next one, because the entropy ran on from match to match.

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
  /** Both seeds, hashed with the series id: what every match's entropy starts from. null until A reveals. */
  seeds: string | null;
  /** The match in play's entropy: its start, with every finished round's nonces mixed in. null between matches. */
  entropy: string | null;
  match: number;
  /** The match in play. null during the seed step. */
  game: LotState | null;
  phase: "seed" | "commit" | "reveal";
  phaseOpenedAt: number;
  /** The time of the last act: the chain's clock never goes back. */
  lastAt: number;
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

/** What the series' draws start from: both seeds, bound to the series. */
export function seriesSeeds(seriesId: string, seedA: string, seedB: string): string {
  if (!HEX32.test(seriesId) || !HEX32.test(seedA) || !HEX32.test(seedB)) fail("the series id and the seeds are 32 bytes of hex");
  return hex(sha256(Uint8Array.from([...tag("lot-seeds"), ...bytes(seriesId), ...bytes(seedA), ...bytes(seedB)])));
}

/** The entropy a match starts from: the seeds and the match's number, and nothing that happened in another match. */
export function matchEntropy(seeds: string, match: number): string {
  if (!HEX32.test(seeds) || !isByte(match)) fail("the seeds are 32 bytes of hex, and the match a whole number from 0 to 255");
  return hex(sha256(Uint8Array.from([...tag("lot-match"), ...bytes(seeds), match])));
}

/** A match's entropy after a round: the old value with both sides' nonces mixed in, side a's first whoever revealed first. */
export function mixEntropy(entropy: string, nonceA: string, nonceB: string): string {
  if (!HEX32.test(entropy) || !HEX32.test(nonceA) || !HEX32.test(nonceB)) fail("the entropy and the nonces are 32 bytes of hex");
  return hex(sha256(Uint8Array.from([...tag("lot-round"), ...bytes(entropy), ...bytes(nonceA), ...bytes(nonceB)])));
}

/**
 * The prize offered in `round` of `match`, from those left. The hash is read as one 256-bit number and reduced by the
 * count left, so no prize is favoured by more than one part in 2^250.
 */
export function drawFrom(entropy: string, match: number, round: number, left: number[]): number {
  if (!left.length) fail("no prize is left to draw");
  if (!HEX32.test(entropy) || !isByte(match) || !isByte(round)) fail("the entropy is 32 bytes of hex, and the match and the round whole numbers from 0 to 255");
  const h = sha256(Uint8Array.from([...tag("lot-draw"), ...bytes(entropy), match, round]));
  return left[Number(BigInt(`0x${hex(h)}`) % BigInt(left.length))]!;
}

const fresh = (): Record<Side, SideRound> => ({ a: { hash: null, bid: null, nonce: null }, b: { hash: null, bid: null, nonce: null } });

/** A series once both stakes are in: A's seed commitment came with its stake, B's seed with its own. A reveals next. */
export function openLotSeries(config: LotSeriesConfig, seriesId: string, seedHash: string, seedB: string, at: number): LotSeriesState {
  if (!HEX32.test(seriesId) || !HEX32.test(seedHash) || !HEX32.test(seedB)) fail("the series id, the seed commitment and the seed are 32 bytes of hex");
  return {
    config, seriesId, seedHash, seedB, seedA: null, seeds: null, entropy: null,
    match: 0, game: null, phase: "seed", phaseOpenedAt: at, lastAt: at, round: fresh(), results: [], draws: [], mixed: [], ending: null,
  };
}

const checkPlayer = (p: Player) => {
  if (p !== "A" && p !== "B") fail('the player is "A" or "B"');
};
/** Every act's time: a whole number of seconds, never before the last act. Call `acted` once the act is accepted. */
const checkTime = (s: LotSeriesState, at: number) => {
  if (!Number.isInteger(at)) fail("the time is a whole number of seconds");
  if (at < s.lastAt) fail("the clock went backward");
};
const acted = (s: LotSeriesState, at: number) => {
  s.lastAt = at;
};
export const commitDeadline = (s: LotSeriesState) => s.phaseOpenedAt + s.config.commitSeconds;
export const revealDeadline = (s: LotSeriesState) => s.phaseOpenedAt + s.config.revealSeconds;

/** Opens the match `s.match`: its entropy from the seeds and its number alone, and its first prize from that. */
function startMatch(s: LotSeriesState, at: number): void {
  s.entropy = matchEntropy(s.seeds!, s.match);
  const first = drawFrom(s.entropy, s.match, 1, s.config.rules.prizes);
  s.draws.push({ match: s.match, round: 1, entropy: s.entropy, prize: first });
  s.game = startLot(s.config.rules, first);
  s.phase = "commit";
  s.phaseOpenedAt = at;
  s.round = fresh();
}

/** A reveals the seed it committed to. Every match's entropy follows from both seeds; the match in turn opens. */
export function revealSeed(s: LotSeriesState, player: Player, seed: string, at: number): void {
  checkPlayer(player);
  if (s.ending) fail("the series is over");
  if (s.phase !== "seed") fail("the seed is already in");
  if (player !== "A") fail("only A has a seed to reveal");
  checkTime(s, at);
  if (at > revealDeadline(s)) fail("too late: the seed window has closed");
  if (!HEX32.test(seed) || seedCommitment(s.seriesId, seed) !== s.seedHash) fail("that isn't the committed seed");
  s.seedA = seed;
  s.seeds = seriesSeeds(s.seriesId, seed, s.seedB);
  acted(s, at);
  startMatch(s, at);
}

/** A side commits to its bid for the open round. Final: it can't be replaced. */
export function commit(s: LotSeriesState, player: Player, match: number, round: number, hash: string, at: number): void {
  checkPlayer(player);
  if (s.ending) fail("the series is over");
  if (s.phase !== "commit") fail("not a commit phase");
  checkTime(s, at);
  // The match as well as the round: a commitment sent for one match must never stand in the next, where it can't be opened.
  if (match !== s.match) fail(`this is match ${s.match + 1}`);
  if (round !== s.game!.rounds.length + 1) fail(`this is round ${s.game!.rounds.length + 1}`);
  if (!HEX32.test(hash)) fail("a commitment is 32 bytes of hex");
  const r = s.round[sideOf(player, s.match)];
  if (r.hash !== null) fail("already committed this round");
  if (at >= commitDeadline(s)) fail("too late to commit");
  r.hash = hash;
  acted(s, at);
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
  acted(s, at);
  if (s.round.a.bid !== null && s.round.b.bid !== null) resolve(s, at);
}

function resolve(s: LotSeriesState, at: number): void {
  const game = s.game!, round = game.rounds.length + 1;
  s.entropy = mixEntropy(s.entropy!, s.round.a.nonce!, s.round.b.nonce!);
  s.mixed.push({ match: s.match, round, a: s.round.a.nonce!, b: s.round.b.nonce! });
  // The draw happens whether or not this round ends the match: the rules ignore it when it does, and the match's
  // entropy ends with the match.
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
  s.entropy = null;
  if (s.ending) return;
  s.match += 1;
  if (s.seeds) return startMatch(s, at);
  // Still no seed from A: its window opens again, for the next match.
  s.phase = "seed";
  s.phaseOpenedAt = at;
}

/**
 * Anyone may call this after a deadline, and only after it. A missed seed costs A the match, and its window opens again
 * for the next: nothing is ever drawn from one side's seed. A side that hasn't committed, or hasn't revealed, forfeits
 * the match; both missing makes it void.
 */
export function timeout(s: LotSeriesState, at: number): void {
  if (s.ending) fail("the series is over");
  checkTime(s, at);
  if (s.phase === "seed") {
    if (at <= revealDeadline(s)) fail("the seed window is still open");
    acted(s, at);
    return endMatch(s, { winner: "B", reason: "missed_seed" }, at);
  }
  const missing = (["a", "b"] as const).filter((side) => (s.phase === "commit" ? s.round[side].hash === null : s.round[side].bid === null));
  if (s.phase === "commit") {
    if (at < commitDeadline(s)) fail("a side still has time to commit");
  } else if (at <= revealDeadline(s)) fail("the reveal window is still open");
  acted(s, at);
  if (missing.length === 2) return endMatch(s, { winner: null, reason: "void" }, at);
  endMatch(s, { winner: playerOf(otherSide(missing[0]!), s.match), reason: s.phase === "commit" ? "missed_commit" : "missed_reveal" }, at);
}

/**
 * Checks every draw of a series from its public record: the seeds, the nonce pairs and the prizes drawn. Returns the
 * first thing that doesn't follow, or null when everything does. It checks that the draws follow from the seeds and
 * nonces given; that those are the ones the chain holds (each nonce opening its commitment) is the replay's job.
 */
export function auditDraws(s: Pick<LotSeriesState, "config" | "seriesId" | "seedHash" | "seedA" | "seedB" | "draws" | "mixed">): string | null {
  if (!s.draws.length) return null;
  if (s.seedA === null) return "prizes were drawn without A's seed";
  if (!HEX32.test(s.seedA) || seedCommitment(s.seriesId, s.seedA) !== s.seedHash) return "A's seed isn't the one it committed to";
  const seeds = seriesSeeds(s.seriesId, s.seedA, s.seedB);
  const nonces = new Map<string, { a: string; b: string }>();
  for (const m of s.mixed) {
    const key = `${m.match}:${m.round}`;
    if (nonces.has(key)) return `match ${m.match + 1} round ${m.round}: two pairs of nonces`;
    if (!HEX32.test(m.a) || !HEX32.test(m.b)) return `match ${m.match + 1} round ${m.round}: a nonce isn't 32 bytes of hex`;
    nonces.set(key, { a: m.a, b: m.b });
  }
  let match = -1, round = 0, entropy = "", left: number[] = [];
  for (const d of s.draws) {
    const where = `match ${d.match + 1} round ${d.round}`;
    if (!Number.isInteger(d.match) || d.match < 0 || d.match >= s.config.matches) return `${where}: no such match in this series`;
    if (d.round === 1) {
      if (d.match <= match) return `${where}: the matches are out of order`;
      match = d.match;
      entropy = matchEntropy(seeds, match);
      left = [...s.config.rules.prizes];
    } else {
      if (d.match !== match || d.round !== round + 1) return `${where}: the rounds are out of order`;
      const pair = nonces.get(`${match}:${round}`);
      if (!pair) return `${where}: no nonces for the round before`;
      entropy = mixEntropy(entropy, pair.a, pair.b);
    }
    round = d.round;
    if (d.entropy !== entropy) return `${where}: the entropy doesn't follow from the seeds and nonces`;
    if (!left.length || drawFrom(entropy, match, round, left) !== d.prize) return `${where}: the prize isn't the one the entropy draws`;
    left.splice(left.indexOf(d.prize), 1);
  }
  return null;
}
