// The Lot, a prototype second game for The Line's arena (docs/research/new-games.md). Simulator only: nothing here is
// exported from highwire-core, and no program plays it.
//
// A set of prizes with public values is offered one at a time, in an order nobody knows in advance. Each round both
// sides bid in secret from one energy budget; the bigger bid takes the prize, a tie burns it, and both pay what they
// bid (all-pay, as on the wire). The side with more prize value wins. On-chain, the next prize would be drawn from both
// sides' revealed nonces, so no oracle is needed; here a seeded generator stands in.

import { solveMatrix } from "../../src/arena/solve.ts";
import type { Side } from "../../src/arena/rules.ts";

export interface LotRules {
  id: string;
  /** Every prize's value. Each is offered once. */
  prizes: number[];
  /** Energy each side starts with. There is no regain. */
  energy: number;
}

/** The draft: nine prizes worth 1 to 9, 30 energy. */
export const LOT_DRAFT: LotRules = { id: "lot-draft-1", prizes: [1, 2, 3, 4, 5, 6, 7, 8, 9], energy: 30 };

export interface LotRound {
  prize: number;
  bid: Record<Side, number>;
  /** Who took the prize, or null when a tie burned it. */
  winner: Side | null;
}

export type LotEnding = { winner: Side; reason: "outscored" | "decided" } | { winner: null; reason: "draw" };

export interface LotState {
  rules: LotRules;
  rounds: LotRound[];
  /** The prize on offer this round; null once the match is over. */
  prize: number | null;
  /** Prizes not offered yet (the one on offer isn't among them). */
  left: number[];
  energy: Record<Side, number>;
  score: Record<Side, number>;
  ending: LotEnding | null;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** The prize a uniform number in [0, 1) draws from those left. */
export const drawPrize = (left: number[], u: number): number => left[Math.min(left.length - 1, Math.floor(u * left.length))]!;

function without(left: number[], prize: number): number[] {
  const i = left.indexOf(prize);
  if (i < 0) throw new Error(`prize ${prize} isn't left to offer`);
  return [...left.slice(0, i), ...left.slice(i + 1)];
}

export function startLot(rules: LotRules, firstPrize: number): LotState {
  return { rules, rounds: [], prize: firstPrize, left: without(rules.prizes, firstPrize), energy: { a: rules.energy, b: rules.energy }, score: { a: 0, b: 0 }, ending: null };
}

/** Why a bid isn't allowed in this state, or null when it is. */
export function bidProblem(state: LotState, side: Side, bid: unknown): string | null {
  if (state.ending) return "the match is over";
  if (typeof bid !== "number" || !Number.isInteger(bid)) return "a bid is a whole number";
  if (bid < 0) return "a bid can't be negative";
  if (bid > state.energy[side]) return `a bid can't be more than the ${state.energy[side]} energy left`;
  return null;
}

/**
 * The state after one round. `nextPrize` is the prize offered next, one of those left; it's ignored when the match ends
 * with this round. The match ends when the prizes run out, or as soon as the side behind can't catch up.
 */
export function playLot(state: LotState, bidA: number, bidB: number, nextPrize?: number): LotState {
  for (const [side, bid] of [["a", bidA], ["b", bidB]] as const) {
    const problem = bidProblem(state, side, bid);
    if (problem) throw new Error(`${side}: ${problem}`);
  }
  const prize = state.prize!;
  const winner: Side | null = bidA > bidB ? "a" : bidB > bidA ? "b" : null;
  const score = { a: state.score.a + (winner === "a" ? prize : 0), b: state.score.b + (winner === "b" ? prize : 0) };
  const next: LotState = {
    rules: state.rules,
    rounds: [...state.rounds, { prize, bid: { a: bidA, b: bidB }, winner }],
    prize: null,
    left: state.left,
    energy: { a: state.energy.a - bidA, b: state.energy.b - bidB },
    score,
    ending: null,
  };
  const lead = score.a - score.b;
  if (Math.abs(lead) > sum(state.left)) next.ending = { winner: lead > 0 ? "a" : "b", reason: state.left.length ? "decided" : "outscored" };
  else if (!state.left.length) next.ending = { winner: null, reason: "draw" };
  else {
    if (nextPrize === undefined) throw new Error("the match goes on: it needs the next prize");
    next.prize = nextPrize;
    next.left = without(state.left, nextPrize);
  }
  return next;
}

/** A whole match from its rounds, as it would be stored: each round's prize and bids. */
export function replayLot(rules: LotRules, rounds: { prize: number; a: number; b: number }[]): LotState {
  let s = startLot(rules, rounds[0]!.prize);
  rounds.forEach((r, i) => {
    if (s.prize !== r.prize) throw new Error(`round ${i + 1}: the prize on offer was ${s.prize}, not ${r.prize}`);
    s = playLot(s, r.a, r.b, rounds[i + 1]?.prize);
  });
  return s;
}

// ---------------------------------------------------------------- the exact solution

// Backward induction over every set of prizes left, pair of energies and lead, with the next prize a chance move and
// each round's bids a zero-sum matrix game. A value is +1 for a sure win, -1 for a sure loss, from "me". Unlike the
// wire's 72,000 states, this is tens of millions of games at the draft's size: minutes, not under a second.

export interface LotSolution {
  rules: LotRules;
  /** Matrix games solved, and the seconds it took. */
  games: number;
  seconds: number;
  /** The value to me of this state, before bidding on its prize. */
  value(state: LotState, side: Side): number;
  /** My equilibrium mix over bids 0..my energy in this state. */
  mix(state: LotState, side: Side): number[];
  /** What the match is worth to me after I bid `mine` and the opponent `theirs`, playing on optimally. */
  after(state: LotState, side: Side, mine: number, theirs: number): number;
}

export function solveLot(rules: LotRules): LotSolution {
  const started = Date.now();
  const P = rules.prizes, N = P.length, E = rules.energy, E1 = E + 1, T = sum(P), D = 2 * T + 1;
  const maskSum = new Int32Array(1 << N);
  for (let m = 1; m < 1 << N; m++) {
    const low = 31 - Math.clz32(m & -m);
    maskSum[m] = maskSum[m & (m - 1)]! + P[low]!;
  }
  // W[mask][me][opp][lead]: the value before a prize is drawn from `mask`. Filled for masks in increasing order, so a
  // mask's subsets are always ready.
  const W = new Float32Array((1 << N) * E1 * E1 * D);
  const at = (mask: number, me: number, opp: number, d: number) => ((mask * E1 + me) * E1 + opp) * D + (d + T);
  /** The value once `mask` is what's left and the lead is `d`: decided, drawn out, or looked up. */
  const settled = (mask: number, me: number, opp: number, d: number): number => {
    if (Math.abs(d) > maskSum[mask]!) return Math.sign(d);
    if (mask === 0) return 0;
    return W[at(mask, me, opp, d)]!;
  };
  /** The matrix game for `prize` on offer with `rest` left after it. Bids above the opponent's energy + 1 are dominated. */
  const game = (prize: number, rest: number, me: number, opp: number, d: number): number[][] => {
    const rows = Math.min(me, opp + 1), cols = Math.min(opp, me + 1);
    const A: number[][] = [];
    for (let i = 0; i <= rows; i++) {
      const row: number[] = new Array(cols + 1);
      for (let j = 0; j <= cols; j++) row[j] = settled(rest, me - i, opp - j, i > j ? d + prize : i < j ? d - prize : d);
      A.push(row);
    }
    return A;
  };
  let games = 0;
  for (let mask = 1; mask < 1 << N; mask++) {
    const left = maskSum[mask]!, reach = Math.min(left, T - left), count = popcount(mask);
    for (let me = 0; me <= E; me++) {
      for (let opp = 0; opp <= me; opp++) {
        for (let d = -reach; d <= reach; d++) {
          // The game is symmetric: (opp, me, -d) is this state from the other chair.
          if (me === opp && d < 0) continue;
          let v = 0;
          for (let k = 0; k < N; k++) {
            if (!(mask & (1 << k))) continue;
            v += solveMatrix(game(P[k]!, mask & ~(1 << k), me, opp, d)).value;
            games++;
          }
          v /= count;
          W[at(mask, me, opp, d)] = v;
          W[at(mask, opp, me, -d)] = -v;
        }
      }
    }
  }
  const view = (state: LotState, side: Side) => {
    if (state.ending || state.prize === null) throw new Error("the match is over");
    const them: Side = side === "a" ? "b" : "a";
    let rest = 0;
    // Prizes of equal value are interchangeable, so any index with the right value will do.
    const used = new Set<number>();
    for (const p of state.left) {
      const k = P.findIndex((v, i) => v === p && !used.has(i));
      used.add(k);
      rest |= 1 << k;
    }
    return { prize: state.prize, rest, me: state.energy[side], opp: state.energy[them], d: state.score[side] - state.score[them] };
  };
  return {
    rules,
    games,
    seconds: (Date.now() - started) / 1000,
    value: (state, side) => {
      const v = view(state, side);
      return solveMatrix(game(v.prize, v.rest, v.me, v.opp, v.d)).value;
    },
    mix: (state, side) => {
      const v = view(state, side);
      const row = solveMatrix(game(v.prize, v.rest, v.me, v.opp, v.d)).row.map((w) => Math.max(0, w));
      while (row.length <= v.me) row.push(0);
      return row;
    },
    after: (state, side, mine, theirs) => {
      const v = view(state, side);
      return settled(v.rest, v.me - mine, v.opp - theirs, mine > theirs ? v.d + v.prize : mine < theirs ? v.d - v.prize : v.d);
    },
  };
}

function popcount(m: number): number {
  let c = 0;
  for (; m; m &= m - 1) c++;
  return c;
}

/** How many matrix games the exact solution takes for these rules, without solving any. */
export function lotGames(rules: LotRules): number {
  const P = rules.prizes, N = P.length, E = rules.energy, T = sum(P);
  let games = 0;
  for (let mask = 1; mask < 1 << N; mask++) {
    let left = 0;
    for (let k = 0; k < N; k++) if (mask & (1 << k)) left += P[k]!;
    const reach = Math.min(left, T - left);
    // Pairs with me >= opp, every lead in reach (half of them when the energies are equal), one game per prize left.
    const pairs = ((E + 1) * (E + 2)) / 2;
    games += popcount(mask) * (pairs * (2 * reach + 1) - (E + 1) * reach);
  }
  return games;
}
