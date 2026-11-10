// Three wires, a prototype second game for The Line's arena (docs/research/new-games.md). Simulator only: nothing here
// is exported from highwire-core, and no program plays it.
//
// The Line's tug-of-war on three short wires at once, from one energy budget. Each round both sides secretly split a
// pull across the wires; on each wire the bigger pull moves its node one place, and both pay everything they pulled. A
// node that reaches an end is taken for good. Taking two wires wins; when the rounds run out, the side holding more
// wires wins.

import { solveMatrix } from "../../src/arena/solve.ts";
import type { Side } from "../../src/arena/rules.ts";

export interface WiresRules {
  id: string;
  /** How many wires. Odd, so that taking most of them is always possible. */
  wires: number;
  /** A node is taken at ±places. */
  places: number;
  /** Starting energy, and the most a side can hold. */
  energy: number;
  /** Energy regained at the start of every round after the first, up to `energy`. */
  regen: number;
  /** After this many rounds, the side holding more wires wins. */
  rounds: number;
}

/** The draft: three wires of five places, 30 energy regaining 3 a round, 10 rounds. */
export const WIRES_DRAFT: WiresRules = { id: "wires-draft-1", wires: 3, places: 2, energy: 30, regen: 3, rounds: 10 };

export interface WiresRound {
  pull: Record<Side, number[]>;
  /** Every node after the round. */
  nodes: number[];
}

export type WiresEnding = { winner: Side; reason: "took_most" | "rounds_up" } | { winner: null; reason: "draw" };

export interface WiresState {
  rules: WiresRules;
  rounds: WiresRound[];
  /** Where each node is: negative is toward a's end, positive toward b's. */
  nodes: number[];
  energy: Record<Side, number>;
  ending: WiresEnding | null;
}

export function startWires(rules: WiresRules = WIRES_DRAFT): WiresState {
  return { rules, rounds: [], nodes: new Array<number>(rules.wires).fill(0), energy: { a: rules.energy, b: rules.energy }, ending: null };
}

/** A wire whose node has reached an end: no one can pull it again. */
export const taken = (rules: WiresRules, node: number) => Math.abs(node) >= rules.places;

/** Why a split isn't allowed in this state, or null when it is. */
export function splitProblem(state: WiresState, side: Side, pull: unknown): string | null {
  if (state.ending) return "the match is over";
  if (!Array.isArray(pull) || pull.length !== state.rules.wires) return `a move is ${state.rules.wires} pulls, one per wire`;
  let total = 0;
  for (let w = 0; w < pull.length; w++) {
    const p: unknown = pull[w];
    if (typeof p !== "number" || !Number.isInteger(p) || p < 0) return "a pull is a whole number, 0 or more";
    if (p > 0 && taken(state.rules, state.nodes[w]!)) return `wire ${w + 1} is taken: it can't be pulled`;
    total += p;
  }
  if (total > state.energy[side]) return `the pulls can't add up to more than the ${state.energy[side]} energy left`;
  return null;
}

const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Wires on each side of the middle: taken ones, and those leaning that way. */
function held(nodes: number[]): Record<Side, number> {
  return { a: nodes.filter((n) => n < 0).length, b: nodes.filter((n) => n > 0).length };
}

function endingOf(rules: WiresRules, nodes: number[], roundsPlayed: number): WiresEnding | null {
  const most = Math.floor(rules.wires / 2) + 1;
  const tookA = nodes.filter((n) => n <= -rules.places).length, tookB = nodes.filter((n) => n >= rules.places).length;
  if (tookA >= most) return { winner: "a", reason: "took_most" };
  if (tookB >= most) return { winner: "b", reason: "took_most" };
  if (roundsPlayed < rules.rounds) return null;
  const h = held(nodes);
  return h.a === h.b ? { winner: null, reason: "draw" } : { winner: h.a > h.b ? "a" : "b", reason: "rounds_up" };
}

/** The state after one round. Throws on a split that isn't allowed. */
export function playWires(state: WiresState, pullA: number[], pullB: number[]): WiresState {
  for (const [side, pull] of [["a", pullA], ["b", pullB]] as const) {
    const problem = splitProblem(state, side, pull);
    if (problem) throw new Error(`${side}: ${problem}`);
  }
  const { rules } = state;
  const nodes = state.nodes.map((n, w) => n + Math.sign(pullB[w]! - pullA[w]!));
  const rounds = [...state.rounds, { pull: { a: [...pullA], b: [...pullB] }, nodes }];
  const energy = {
    a: Math.min(rules.energy, state.energy.a - total(pullA) + rules.regen),
    b: Math.min(rules.energy, state.energy.b - total(pullB) + rules.regen),
  };
  return { rules, rounds, nodes, energy, ending: endingOf(rules, nodes, rounds.length) };
}

/** A whole match from its rounds' pulls, as it would be stored. */
export function replayWires(rules: WiresRules, pulls: [number[], number[]][]): WiresState {
  let s = startWires(rules);
  for (const [a, b] of pulls) s = playWires(s, a, b);
  return s;
}

/** How many ways a side can split `energy` across `open` wires (every total from 0 to energy). */
export function splits(energy: number, open: number): number {
  let n = 1;
  for (let k = 1; k <= open; k++) n = (n * (energy + k)) / k;
  return Math.round(n);
}

// ---------------------------------------------------------------- the exact solution, for small rules only

// The same backward induction as the wire's, but a move is a split, not a number: at 30 energy on three wires a side has
// 5,456 of them, so one state's matrix game has 30 million cells where the wire's has under a thousand. This solver is
// here to check the rules on small sizes and to measure how the cost grows; the draft's size is far out of its reach.

export interface WiresSolution {
  /** The value of the start to side a (0: the game is symmetric). */
  value: number;
  /** Matrix games solved, the cells in the biggest, and the seconds it took. */
  games: number;
  biggest: number;
  seconds: number;
}

/** Every split of at most `energy` across the open wires, none above `cap` on a wire (more is dominated). */
function allSplits(open: boolean[], energy: number, cap: number): number[][] {
  const out: number[][] = [];
  const cur = new Array<number>(open.length).fill(0);
  const go = (w: number, left: number) => {
    if (w === open.length) return void out.push([...cur]);
    if (!open[w]) return go(w + 1, left);
    for (let p = 0; p <= Math.min(left, cap); p++) {
      cur[w] = p;
      go(w + 1, left - p);
    }
    cur[w] = 0;
  };
  go(0, energy);
  return out;
}

export function solveWires(rules: WiresRules): WiresSolution {
  const started = Date.now();
  const memo = new Map<string, number>();
  let games = 0, biggest = 0;
  /** The value to side a before round `r` (0-based). Wires are interchangeable, so nodes are kept sorted. */
  const value = (r: number, nodes: number[], ea: number, eb: number): number => {
    const key = `${r}|${nodes.join(",")}|${ea}|${eb}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const open = nodes.map((n) => !taken(rules, n));
    const rows = allSplits(open, ea, eb + 1), cols = allSplits(open, eb, ea + 1);
    const A: number[][] = [];
    for (const x of rows) {
      const row: number[] = [];
      const left = Math.min(rules.energy, ea - total(x) + rules.regen);
      for (const y of cols) {
        const next = nodes.map((n, w) => n + Math.sign(y[w]! - x[w]!));
        const end = endingOf(rules, next, r + 1);
        // Side a's end is the negative one: a win for a is +1.
        if (end) row.push(end.winner === "a" ? 1 : end.winner === "b" ? -1 : 0);
        else row.push(value(r + 1, [...next].sort((p, q) => p - q), left, Math.min(rules.energy, eb - total(y) + rules.regen)));
      }
      A.push(row);
    }
    games++;
    biggest = Math.max(biggest, rows.length * cols.length);
    const v = solveMatrix(A).value;
    memo.set(key, v);
    return v;
  };
  const v = value(0, new Array<number>(rules.wires).fill(0), rules.energy, rules.energy);
  return { value: v, games, biggest, seconds: (Date.now() - started) / 1000 };
}
