import type { ArenaRules } from "./rules.ts";

// The game solved exactly (docs/arena.md 4.2): backward induction over every round, node position and pair of energies,
// solving each round's simultaneous choice as a zero-sum matrix game. Everything is from one side's view: "pos" is
// positive toward that side's own end, "me" and "opp" are the two energies, and a value is +1 for a sure win, -1 for a
// sure loss. The game is symmetric, so one table serves both sides. It ignores the "spent" tie-break (a middle finish
// counts as 0), which the simulator measures separately. About 72,000 small games for the first rules: under a second.
//
// For research (docs/research/series-equilibrium.md), `solve` also takes what a win, a draw and a loss are worth to
// "me", so a match can be solved for what it means inside a series. The opponent's worths are then the negatives, and
// one table no longer serves both sides: the opponent's is `solve(rules, { win: -loss, draw: -draw, loss: -win })`.
// Left out, the worths are +1, 0 and -1 and the tables are what they always were, bit for bit (a test pins them).

/**
 * A zero-sum game's value and the row player's optimal mix (the row maximizes). The simplex, on a shifted payoff, for
 * payoffs from -1 to +1.
 *
 * These games are full of ties (many pulls do equally well), and at a tie the plain ratio test can pivot on an entry
 * that is only rounding error; it then reports a wrong value for the state, or fails outright. `careful` breaks every
 * tie the textbook way, by reading its ratios from a right-hand side nudged by about 1e-8 while the true one is carried
 * alongside, and then checks its answer: it throws unless the row's mix guarantees, and the column's mix concedes, the
 * same value to within 1e-6. The plain test stays the default because the house's tables were made with it, and a
 * house match replays only against the same tables. Everything else is solved with `careful`.
 */
export function solveMatrix(A: number[][], careful = false): { value: number; row: number[]; col: number[] } {
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
  // Column n + m is the right-hand side; `careful` adds its nudged twin after it.
  const s = 3, W = n + m + (careful ? 2 : 1), nudged = n + m + 1;
  const T: Float64Array[] = [];
  for (let i = 0; i < m; i++) {
    const r = new Float64Array(W);
    for (let j = 0; j < n; j++) r[j] = A[i]![j]! + s;
    r[n + i] = 1;
    r[n + m] = 1;
    if (careful) r[nudged] = 1 + 1e-8 * (1 + ((i * 7919 + 13) % 101) / 101);
    T.push(r);
  }
  const obj = new Float64Array(W);
  for (let j = 0; j < n; j++) obj[j] = -1;
  const basis = Array.from({ length: m }, (_, i) => n + i);
  let it = 0;
  for (; it < 10_000; it++) {
    let pc = -1, best = careful ? -1e-10 : -1e-12;
    for (let j = 0; j < n + m; j++) if (obj[j]! < best) (best = obj[j]!), (pc = j);
    if (pc < 0) break;
    let pr = -1, br = Infinity;
    if (careful) {
      for (let i = 0; i < m; i++) {
        if (T[i]![pc]! > 1e-10) {
          const ratio = Math.max(0, T[i]![nudged]!) / T[i]![pc]!;
          if (ratio < br) (br = ratio), (pr = i);
        }
      }
    } else {
      for (let i = 0; i < m; i++) {
        if (T[i]![pc]! > 1e-12) {
          const ratio = T[i]![n + m]! / T[i]![pc]!;
          if (ratio < br - 1e-15) (br = ratio), (pr = i);
        }
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
  if (careful) {
    if (it >= 10_000) throw new Error("the simplex didn't settle");
    // The column's mix from the nudged side (the one this basis is feasible for), both mixes made distributions.
    const row = Array.from({ length: m }, (_, i) => Math.max(0, obj[n + i]!)), col = new Array<number>(n).fill(0);
    for (let i = 0; i < m; i++) if (basis[i]! < n) col[basis[i]!] = Math.max(0, T[i]![nudged]!);
    const rows = row.reduce((a, w) => a + w, 0), cols = col.reduce((a, w) => a + w, 0);
    for (let i = 0; i < m; i++) row[i]! /= rows;
    for (let j = 0; j < n; j++) col[j]! /= cols;
    let guaranteed = Infinity, conceded = -Infinity;
    for (let j = 0; j < n; j++) {
      let v = 0;
      for (let i = 0; i < m; i++) v += row[i]! * A[i]![j]!;
      guaranteed = Math.min(guaranteed, v);
    }
    for (let i = 0; i < m; i++) {
      let v = 0;
      for (let j = 0; j < n; j++) v += A[i]![j]! * col[j]!;
      conceded = Math.max(conceded, v);
    }
    if (!(conceded - guaranteed < 1e-6)) throw new Error(`the simplex's answer doesn't check: the row guarantees ${guaranteed}, the column concedes ${conceded}`);
    return { value: (guaranteed + conceded) / 2, row, col };
  }
  const opt = obj[n + m]!;
  const col = new Array<number>(n).fill(0);
  for (let i = 0; i < m; i++) if (basis[i]! < n) col[basis[i]!] = T[i]![n + m]! / opt;
  const row = Array.from({ length: m }, (_, i) => obj[n + i]! / opt);
  return { value: 1 / opt - s, row, col };
}

/** What a finished match is worth to "me". The opponent's worths are the negatives, so the match stays zero-sum. */
export interface Payoffs {
  win: number;
  draw: number;
  loss: number;
}

/** A match on its own: +1 for a win, 0 for a draw, -1 for a loss. What the house plays, and `solve`'s default. */
export const MATCH_PAYOFFS: Payoffs = { win: 1, draw: 0, loss: -1 };

export interface Solution {
  rules: ArenaRules;
  payoffs: Payoffs;
  /** The value of a state to "me" before round `round` (0-based), with the node at `pos` from my view. */
  value(round: number, pos: number, me: number, opp: number): number;
  /** My equilibrium mix over pulls 0..me in that state. */
  mix(round: number, pos: number, me: number, opp: number): Float32Array;
  /** What the game is worth to me after I pull `mine` and the opponent pulls `theirs` in that state, playing on optimally. */
  after(round: number, pos: number, me: number, opp: number, mine: number, theirs: number): number;
}

const cache = new Map<string, Solution>();

/**
 * The solved game for these rules. With the default worths it is the house's table, cached. With any others (research
 * only; even the default's doubled) it is solved afresh on every call with the careful pivot rule, about 20 MB a
 * table, for the caller to keep or drop.
 */
export function solve(rules: ArenaRules, payoffs: Payoffs = MATCH_PAYOFFS): Solution {
  const { win, draw, loss } = payoffs;
  if (![win, draw, loss].every(Number.isFinite)) throw new Error("a win, a draw and a loss are each worth a finite number");
  if (win === 1 && draw === 0 && loss === -1) return table(rules, MATCH_PAYOFFS);
  // Other worths are solved on the default's scale, the best of the three at +1 and the worst at -1: the simplex's
  // shift and tolerances are absolute, set for that range. Scaling and shifting every worth alike changes no mix, so
  // only the values are stretched back, as they are read.
  const lo = Math.min(win, draw, loss), span = Math.max(win, draw, loss) - lo;
  const unit = (x: number) => (span === 0 ? 0 : ((x - lo) / span) * 2 - 1);
  const scaled = { win: unit(win), draw: unit(draw), loss: unit(loss) };
  const base = table(rules, scaled, true);
  const real = (v: number) => lo + ((v + 1) / 2) * span;
  return {
    rules,
    payoffs: { win, draw, loss },
    value: (r, p, a, b) => real(base.value(r, p, a, b)),
    mix: base.mix,
    after: (r, p, a, b, i, j) => real(base.after(r, p, a, b, i, j)),
  };
}

/** The table for worths from -1 to +1. Only the house's is cached: it is asked for on every move. */
function table(rules: ArenaRules, payoffs: Payoffs, careful = false): Solution {
  const { win, draw, loss } = payoffs;
  const standard = !careful;
  const key = `${rules.places}/${rules.energy}/${rules.regen}/${rules.rounds}`;
  const hit = standard ? cache.get(key) : undefined;
  if (hit) return hit;
  const { places: D, energy: E, regen, rounds: R } = rules;
  const P = 2 * D - 1, E1 = E + 1;
  const at = (r: number, p: number, a: number, b: number) => ((r * P + (p + D - 1)) * E1 + a) * E1 + b;
  const V = new Float64Array((R + 1) * P * E1 * E1);
  const MIX: Float32Array[] = new Array(V.length);
  const after = (r: number, p: number, a: number, b: number, i: number, j: number): number => {
    const np = p + Math.sign(i - j);
    if (np >= D) return win;
    if (np <= -D) return loss;
    const na = Math.min(E, a - i + regen), nb = Math.min(E, b - j + regen);
    if (r + 1 >= R || (regen === 0 && na === 0 && nb === 0)) return np > 0 ? win : np < 0 ? loss : draw;
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
          const { value, row } = solveMatrix(A, careful);
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
    payoffs,
    value: (r, p, a, b) => V[clampState(r, p, a, b)]!,
    mix: (r, p, a, b) => MIX[clampState(r, p, a, b)]!,
    after: (r, p, a, b, i, j) => (clampState(r, p, a, b), after(r, p, a, b, i, j)),
  };
  if (standard) cache.set(key, sol);
  return sol;
}
