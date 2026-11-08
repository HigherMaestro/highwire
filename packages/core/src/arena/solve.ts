import type { ArenaRules } from "./rules.ts";

// The game solved exactly (docs/arena.md 4.2): backward induction over every round, node position and pair of energies,
// solving each round's simultaneous choice as a zero-sum matrix game. Everything is from one side's view: "pos" is
// positive toward that side's own end, "me" and "opp" are the two energies, and a value is +1 for a sure win, -1 for a
// sure loss. The game is symmetric, so one table serves both sides. It ignores the "spent" tie-break (a middle finish
// counts as 0), which the simulator measures separately. About 72,000 small games for the first rules: under a second.

/** A zero-sum game's value and the row player's optimal mix (the row maximizes). The simplex, on a shifted payoff. */
export function solveMatrix(A: number[][]): { value: number; row: number[]; col: number[] } {
  const m = A.length, n = A[0]!.length;
  // A saddle point needs no LP.
  let lo = -Infinity, hi = Infinity, ri = 0, cj = 0;
  for (let i = 0; i < m; i++) {
    let mn = Infinity;
    for (let j = 0; j < n; j++) mn = Math.min(mn, A[i]![j]!);
    if (mn > lo) (lo = mn), (ri = i);
  }
  for (let j = 0; j < n; j++) {
    let mx = -Infinity;
    for (let i = 0; i < m; i++) mx = Math.max(mx, A[i]![j]!);
    if (mx < hi) (hi = mx), (cj = j);
  }
  if (hi - lo < 1e-12) {
    const row = new Array<number>(m).fill(0), col = new Array<number>(n).fill(0);
    row[ri] = 1;
    col[cj] = 1;
    return { value: lo, row, col };
  }
  // max sum(y) subject to (A + s) y <= 1, y >= 0; the duals give the row's mix.
  const s = 3, W = n + m + 1;
  const T: Float64Array[] = [];
  for (let i = 0; i < m; i++) {
    const r = new Float64Array(W);
    for (let j = 0; j < n; j++) r[j] = A[i]![j]! + s;
    r[n + i] = 1;
    r[n + m] = 1;
    T.push(r);
  }
  const obj = new Float64Array(W);
  for (let j = 0; j < n; j++) obj[j] = -1;
  const basis = Array.from({ length: m }, (_, i) => n + i);
  for (let it = 0; it < 10_000; it++) {
    let pc = -1, best = -1e-12;
    for (let j = 0; j < n + m; j++) if (obj[j]! < best) (best = obj[j]!), (pc = j);
    if (pc < 0) break;
    let pr = -1, br = Infinity;
    for (let i = 0; i < m; i++) {
      if (T[i]![pc]! > 1e-12) {
        const ratio = T[i]![n + m]! / T[i]![pc]!;
        if (ratio < br - 1e-15) (br = ratio), (pr = i);
      }
    }
    if (pr < 0) throw new Error("unbounded game");
    const prow = T[pr]!, pv = prow[pc]!;
    for (let k = 0; k < W; k++) prow[k]! /= pv;
    for (let i = 0; i < m; i++) {
      if (i === pr) continue;
      const f = T[i]![pc]!;
      if (f !== 0) for (let k = 0; k < W; k++) T[i]![k]! -= f * prow[k]!;
    }
    const f = obj[pc]!;
    for (let k = 0; k < W; k++) obj[k]! -= f * prow[k]!;
    basis[pr] = pc;
  }
  const opt = obj[n + m]!;
  const col = new Array<number>(n).fill(0);
  for (let i = 0; i < m; i++) if (basis[i]! < n) col[basis[i]!] = T[i]![n + m]! / opt;
  const row = Array.from({ length: m }, (_, i) => obj[n + i]! / opt);
  return { value: 1 / opt - s, row, col };
}

export interface Solution {
  rules: ArenaRules;
  /** The value of a state to "me" before round `round` (0-based), with the node at `pos` from my view. */
  value(round: number, pos: number, me: number, opp: number): number;
  /** My equilibrium mix over pulls 0..me in that state. */
  mix(round: number, pos: number, me: number, opp: number): Float32Array;
  /** What the game is worth to me after I pull `mine` and the opponent pulls `theirs` in that state, playing on optimally. */
  after(round: number, pos: number, me: number, opp: number, mine: number, theirs: number): number;
}

const cache = new Map<string, Solution>();

/** The solved game for these rules (cached). */
export function solve(rules: ArenaRules): Solution {
  const key = `${rules.places}/${rules.energy}/${rules.regen}/${rules.rounds}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { places: D, energy: E, regen, rounds: R } = rules;
  const P = 2 * D - 1, E1 = E + 1;
  const at = (r: number, p: number, a: number, b: number) => ((r * P + (p + D - 1)) * E1 + a) * E1 + b;
  const V = new Float64Array((R + 1) * P * E1 * E1);
  const MIX: Float32Array[] = new Array(V.length);
  const after = (r: number, p: number, a: number, b: number, i: number, j: number): number => {
    const np = p + Math.sign(i - j);
    if (np >= D) return 1;
    if (np <= -D) return -1;
    const na = Math.min(E, a - i + regen), nb = Math.min(E, b - j + regen);
    if (r + 1 >= R || (regen === 0 && na === 0 && nb === 0)) return Math.sign(np);
    return V[at(r + 1, np, na, nb)]!;
  };
  for (let r = R - 1; r >= 0; r--) {
    for (let p = -(D - 1); p <= D - 1; p++) {
      for (let a = 0; a <= E; a++) {
        for (let b = 0; b <= E; b++) {
          const A: number[][] = [];
          for (let i = 0; i <= a; i++) {
            const rowv: number[] = [];
            for (let j = 0; j <= b; j++) rowv.push(after(r, p, a, b, i, j));
            A.push(rowv);
          }
          const { value, row } = solveMatrix(A);
          const k = at(r, p, a, b);
          V[k] = value;
          MIX[k] = Float32Array.from(row.map((w) => Math.max(0, w)));
        }
      }
    }
  }
  const clampState = (r: number, p: number, a: number, b: number) => {
    if (r < 0 || r >= R || Math.abs(p) >= D || a < 0 || a > E || b < 0 || b > E) throw new Error(`no such state: round ${r}, node ${p}, energies ${a}/${b}`);
    return at(r, p, a, b);
  };
  const sol: Solution = {
    rules,
    value: (r, p, a, b) => V[clampState(r, p, a, b)]!,
    mix: (r, p, a, b) => MIX[clampState(r, p, a, b)]!,
    after: (r, p, a, b, i, j) => (clampState(r, p, a, b), after(r, p, a, b, i, j)),
  };
  cache.set(key, sol);
  return sol;
}
