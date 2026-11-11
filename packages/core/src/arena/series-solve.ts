import { DUELS_1, nodeFor, other, type ArenaRules } from "./rules.ts";
import { MATCHES, sideOf, type Player, type SeriesState } from "./series.ts";
import { solve, type Payoffs, type Solution } from "./solve.ts";

// A wager series solved (docs/research/series-equilibrium.md). A series is not five separate matches: a drawn match is
// worth half a win only while the series is level. One match up with one to play, a draw wins the series. So the play
// that can't be beaten in one match (the house's Even) can be beaten over a series by a player that knows the score,
// by about 8% of the stake. This file holds the play that can't: the series' own equilibrium, by backward induction
// over the score (my wins, the opponent's, matches left), each score's match solved as a zero-sum game whose win, draw
// and loss are worth the series from the three scores it can lead to. It also holds what measured the gap (the best
// reply to a fixed strategy, and how a match between two strategies ends), which the research script and the tests
// use. Pure, like the rest of the arena: no I/O and no randomness of its own.
//
// Solving a series takes about ten seconds and 60 MB, once (it is cached): eleven match tables for `duels-1`.

/** A series from one player's view: the matches it has won, the matches its opponent has won, the matches still to play. */
export interface SeriesScore {
  mine: number;
  theirs: number;
  left: number;
}

/** How long a series runs: at most `matches`, and `wins` take it at once. */
export interface SeriesFormat {
  matches: number;
  wins: number;
}

/** The wager series as the program plays it (docs/wager-mode.md 4.2): five matches. */
export const BEST_OF_5: SeriesFormat = { matches: MATCHES, wins: (MATCHES + 1) / 2 };

/**
 * How a series stands for the player whose score this is: 1 won, -1 lost, 0 drawn, null still on. As `endMatch` in
 * series.ts: decided once a side leads by more than the matches left, and a series level after the last is a draw.
 * (In five matches, three wins always lead by more than what's left; `wins` matters only in longer formats.)
 */
export function seriesResult(s: SeriesScore, format: SeriesFormat = BEST_OF_5): 1 | 0 | -1 | null {
  if (s.mine >= format.wins || s.mine > s.theirs + s.left) return 1;
  if (s.theirs >= format.wins || s.theirs > s.mine + s.left) return -1;
  if (s.left === 0) return s.mine > s.theirs ? 1 : s.mine < s.theirs ? -1 : 0;
  return null;
}

/** The score of a series in play, from one player's view. Voids and draws win nobody a match. */
export function seriesScore(s: SeriesState, player: Player): SeriesScore {
  const wins = (p: Player) => s.results.filter((r) => r.winner === p).length;
  return { mine: wins(player), theirs: wins(player === "A" ? "B" : "A"), left: MATCHES - s.results.length };
}

export const scoreKey = (s: SeriesScore) => `${s.mine}-${s.theirs}/${s.left}`;
const mirrored = (s: SeriesScore): SeriesScore => ({ mine: s.theirs, theirs: s.mine, left: s.left });

/** Every score a series can pass through while it is still on, the last match first. */
export function seriesScores(format: SeriesFormat = BEST_OF_5): SeriesScore[] {
  const out: SeriesScore[] = [];
  for (let left = 1; left <= format.matches; left++) {
    for (let mine = 0; mine < format.wins; mine++) {
      for (let theirs = 0; theirs < format.wins && mine + theirs + left <= format.matches; theirs++) {
        if (seriesResult({ mine, theirs, left }, format) === null) out.push({ mine, theirs, left });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- a match's states, and strategies over them

/** A match's states in one line, as solve.ts orders them: (round, node from my view, my energy, the opponent's). */
export interface MatchGrid {
  states: number;
  /** The state a match starts in. */
  start: number;
  at(round: number, pos: number, me: number, opp: number): number;
  /** Where each state's pulls start in a strategy's `data`; state k has `off[k + 1] - off[k]` of them (0 to my energy). */
  off: Int32Array;
}

const grids = new Map<string, MatchGrid>();
const rulesKey = (r: ArenaRules) => `${r.places}/${r.energy}/${r.regen}/${r.rounds}`;

export function matchGrid(rules: ArenaRules): MatchGrid {
  const hit = grids.get(rulesKey(rules));
  if (hit) return hit;
  const { places: D, energy: E, rounds: R } = rules;
  const P = 2 * D - 1, E1 = E + 1, states = R * P * E1 * E1;
  const at = (r: number, p: number, a: number, b: number) => ((r * P + (p + D - 1)) * E1 + a) * E1 + b;
  const off = new Int32Array(states + 1);
  for (let r = 0; r < R; r++) for (let p = -(D - 1); p <= D - 1; p++) for (let a = 0; a <= E; a++) for (let b = 0; b <= E; b++) off[at(r, p, a, b) + 1] = a + 1;
  for (let k = 0; k < states; k++) off[k + 1]! += off[k]!;
  const grid = { states, start: at(0, 0, E, E), at, off };
  grids.set(rulesKey(rules), grid);
  return grid;
}

/**
 * A way of playing a match: a weight on each pull 0..me in every state, end to end in `data`, with what each state's
 * weights sum to in `total` (a player drawing from a stored mix divides by it, as the house does).
 */
export interface MatchStrategy {
  rules: ArenaRules;
  data: Float32Array;
  total: Float64Array;
}

/** A solved table's mixes exactly as stored (32-bit weights): what a player would really draw from. */
export function strategyOf(sol: Solution): MatchStrategy {
  const { rules } = sol, g = matchGrid(rules), { places: D, energy: E, rounds: R } = rules;
  const data = new Float32Array(g.off[g.states]!), total = new Float64Array(g.states);
  for (let r = 0; r < R; r++) for (let p = -(D - 1); p <= D - 1; p++) for (let a = 0; a <= E; a++) for (let b = 0; b <= E; b++) {
    const k = g.at(r, p, a, b), mix = sol.mix(r, p, a, b);
    data.set(mix, g.off[k]!);
    let t = 0;
    for (let i = 0; i < mix.length; i++) t += mix[i]!;
    total[k] = t;
  }
  return { rules, data, total };
}

/** A strategy that always plays one pull in each state. */
export function pureStrategy(rules: ArenaRules, pulls: Uint8Array): MatchStrategy {
  const g = matchGrid(rules);
  const data = new Float32Array(g.off[g.states]!), total = new Float64Array(g.states).fill(1);
  for (let k = 0; k < g.states; k++) data[g.off[k]! + pulls[k]!] = 1;
  return { rules, data, total };
}

/** The pulls a strategy gives any weight in state `k`, into `pulls` and `probs`; returns how many. */
function support(s: MatchStrategy, off: Int32Array, k: number, pulls: Int32Array, probs: Float64Array): number {
  const from = off[k]!, n = off[k + 1]! - from, tot = s.total[k]!;
  let c = 0;
  for (let j = 0; j < n; j++) {
    const w = s.data[from + j]!;
    if (w > 0) (pulls[c] = j), (probs[c] = w / tot), c++;
  }
  return c;
}

/**
 * The best a player can do in one match against `opp`, when a win, a draw and a loss are worth `pay` to it, and the
 * pull that does it in every state. The opponent's mix is fixed, so each state is a plain maximum, no game to solve.
 */
export function bestResponse(opp: MatchStrategy, pay: Payoffs): { value: number; pulls: Uint8Array } {
  const { win, draw, loss } = pay, { rules } = opp, g = matchGrid(rules);
  const { places: D, energy: E, regen, rounds: R } = rules;
  const V = new Float64Array(g.states), pulls = new Uint8Array(g.states);
  const QJ = new Int32Array(E + 1), QP = new Float64Array(E + 1);
  for (let r = R - 1; r >= 0; r--) for (let p = -(D - 1); p <= D - 1; p++) for (let a = 0; a <= E; a++) for (let b = 0; b <= E; b++) {
    const nq = support(opp, g.off, g.at(r, -p, b, a), QJ, QP);
    let best = -Infinity, bi = 0;
    for (let i = 0; i <= a; i++) {
      const na = Math.min(E, a - i + regen);
      let v = 0;
      for (let t = 0; t < nq; t++) {
        const j = QJ[t]!, np = p + Math.sign(i - j);
        if (np >= D) v += QP[t]! * win;
        else if (np <= -D) v += QP[t]! * loss;
        else if (r + 1 >= R) v += QP[t]! * (np > 0 ? win : np < 0 ? loss : draw);
        else v += QP[t]! * V[g.at(r + 1, np, na, Math.min(E, b - j + regen))]!;
      }
      if (v > best + 1e-12) (best = v), (bi = i);
    }
    const k = g.at(r, p, a, b);
    V[k] = best;
    pulls[k] = bi;
  }
  return { value: V[g.start]!, pulls };
}

/** The chances of a win, a draw and a loss. */
export interface Odds {
  win: number;
  draw: number;
  loss: number;
}

/** How one match between two strategies ends, from the first one's view. */
export function matchOdds(mine: MatchStrategy, opp: MatchStrategy): Odds {
  const { rules } = mine, g = matchGrid(rules), { places: D, energy: E, regen, rounds: R } = rules;
  if (rulesKey(opp.rules) !== rulesKey(rules)) throw new Error("the two strategies play different rules");
  const PW = new Float64Array(g.states), PD = new Float64Array(g.states);
  const XI = new Int32Array(E + 1), XP = new Float64Array(E + 1), QJ = new Int32Array(E + 1), QP = new Float64Array(E + 1);
  for (let r = R - 1; r >= 0; r--) for (let p = -(D - 1); p <= D - 1; p++) for (let a = 0; a <= E; a++) for (let b = 0; b <= E; b++) {
    const k = g.at(r, p, a, b);
    const nx = support(mine, g.off, k, XI, XP), nq = support(opp, g.off, g.at(r, -p, b, a), QJ, QP);
    let pw = 0, pd = 0;
    for (let s = 0; s < nx; s++) {
      const i = XI[s]!, na = Math.min(E, a - i + regen);
      for (let t = 0; t < nq; t++) {
        const j = QJ[t]!, w = XP[s]! * QP[t]!, np = p + Math.sign(i - j);
        if (np >= D) pw += w;
        else if (np <= -D) continue;
        else if (r + 1 >= R) {
          if (np > 0) pw += w;
          else if (np === 0) pd += w;
        } else {
          const kn = g.at(r + 1, np, na, Math.min(E, b - j + regen));
          pw += w * PW[kn]!;
          pd += w * PD[kn]!;
        }
      }
    }
    PW[k] = pw;
    PD[k] = pd;
  }
  return { win: PW[g.start]!, draw: PD[g.start]!, loss: 1 - PW[g.start]! - PD[g.start]! };
}

// ---------------------------------------------------------------- the series, from the last match back

export interface SeriesOptions {
  format?: SeriesFormat;
  /** A rake, as a share of a decided pot (docs/wager-mode.md 6.4): the winner then nets 1 - 2 x fee stakes. */
  fee?: number;
}

/** What the match at a score is worth won, drawn and lost: the series' value from the three scores it can lead to. */
export function nextPayoffs(values: Map<string, number>, s: SeriesScore, { format = BEST_OF_5, fee = 0 }: SeriesOptions = {}): Payoffs {
  const v = (next: SeriesScore) => {
    const d = seriesResult(next, format);
    return d === null ? values.get(scoreKey(next))! : d === 1 ? 1 - 2 * fee : d;
  };
  const left = s.left - 1;
  return { win: v({ mine: s.mine + 1, theirs: s.theirs, left }), draw: v({ mine: s.mine, theirs: s.theirs, left }), loss: v({ mine: s.mine, theirs: s.theirs + 1, left }) };
}

/**
 * A series' value at every score, in stakes (+1 wins the opponent's stake, 0 is a refund, -1 loses your own), built
 * from the last match back: `matchValue` says what the match at a score is worth, given its three worths.
 */
export function seriesValues(matchValue: (s: SeriesScore, next: Payoffs) => number, options: SeriesOptions = {}): Map<string, number> {
  const values = new Map<string, number>();
  for (const s of seriesScores(options.format)) values.set(scoreKey(s), matchValue(s, nextPayoffs(values, s, options)));
  return values;
}

/** A series' chances of ending won, drawn and lost from every score, given each score's match odds. */
export function seriesOdds(odds: (s: SeriesScore) => Odds, format: SeriesFormat = BEST_OF_5): Map<string, Odds> {
  const out = new Map<string, Odds>();
  const v = (next: SeriesScore): Odds => {
    const d = seriesResult(next, format);
    return d === null ? out.get(scoreKey(next))! : { win: d === 1 ? 1 : 0, draw: d === 0 ? 1 : 0, loss: d === -1 ? 1 : 0 };
  };
  for (const s of seriesScores(format)) {
    const m = odds(s), left = s.left - 1;
    const w = v({ mine: s.mine + 1, theirs: s.theirs, left }), d = v({ mine: s.mine, theirs: s.theirs, left }), l = v({ mine: s.mine, theirs: s.theirs + 1, left });
    out.set(scoreKey(s), {
      win: m.win * w.win + m.draw * d.win + m.loss * l.win,
      draw: m.win * w.draw + m.draw * d.draw + m.loss * l.draw,
      loss: m.win * w.loss + m.draw * d.loss + m.loss * l.loss,
    });
  }
  return out;
}

/** Where a drawn match sits between losing it (0) and winning it (1), for these worths. One match on its own: 0.5. */
export const drawWorth = (p: Payoffs) => (p.win === p.loss ? Number.NaN : (p.draw - p.loss) / (p.win - p.loss));

// ---------------------------------------------------------------- the series' equilibrium

export interface SeriesSolution {
  rules: ArenaRules;
  format: SeriesFormat;
  /** The series' value to me at a score, in stakes: +1 a sure win, -1 a sure loss, before any fee. */
  value(score: SeriesScore): number;
  /** Where a drawn match sits between losing it (0) and winning it (1) at a score. The house's Even plays as if it were always 0.5. */
  drawWorth(score: SeriesScore): number;
  /**
   * My equilibrium mix over pulls 0..me at a score, in a state of the match in play: before round `round` (0-based),
   * with the node at `pos` from my view. Draw from it with `pullFrom`.
   */
  mix(score: SeriesScore, round: number, pos: number, me: number, opp: number): Float32Array;
  /** The whole match strategy at a score. */
  strategy(score: SeriesScore): MatchStrategy;
  /** How many match tables it took: one for each worth a draw takes. */
  tables: number;
  /** The most the solver's values broke the game's symmetry by (a level score is worth 0; a trailer's value is minus the leader's). */
  symmetryGap: number;
}

const solved = new Map<string, SeriesSolution>();

/**
 * The series' equilibrium for these rules: at every score, the mix that can't be beaten on average over the rest of
 * the series by any opponent, whatever it knows. Both sides playing it, a series is worth 0 to each.
 *
 * A match's mixes depend only on where the draw sits between the loss and the win (stretching and shifting the three
 * worths together changes nothing), so one table serves every score with the same draw's worth. The game is symmetric,
 * so a level score is worth exactly 0 and a trailer's value is minus the leader's; the values are set that way, and
 * `symmetryGap` says how far the solver's own numbers were from it. At a level score the match is the house's own
 * game; it is solved again with the careful pivot rule, since the house's stored table is slightly off in a few states.
 *
 * Throws if the solver can't certify a match (it checks each state to 1e-6). It never does for the best-of-5.
 */
export function solveSeries(rules: ArenaRules = DUELS_1, format: SeriesFormat = BEST_OF_5): SeriesSolution {
  const id = `${rulesKey(rules)}|${format.matches}/${format.wins}`;
  const hit = solved.get(id);
  if (hit) return hit;
  const g = matchGrid(rules), { places: D, energy: E, rounds: R } = rules;
  const tables = new Map<string, { strategy: MatchStrategy; share: number }>();
  const strategies = new Map<string, MatchStrategy>(), values = new Map<string, number>(), worths = new Map<string, number>();
  let symmetryGap = 0;
  for (const s of seriesScores(format)) {
    const next = nextPayoffs(values, s, { format }), t = drawWorth(next), key = t.toFixed(12);
    let table = tables.get(key);
    if (!table) {
      // On the scale where a win is +2 and a loss -2, so every table, the level scores' too, gets the careful rule.
      const sol = solve(rules, { win: 2, draw: 4 * t - 2, loss: -2 });
      tables.set(key, (table = { strategy: strategyOf(sol), share: (sol.value(0, 0, E, E) + 2) / 4 }));
    }
    strategies.set(scoreKey(s), table.strategy);
    worths.set(scoreKey(s), t);
    const raw = next.loss + (next.win - next.loss) * table.share;
    const mirror = values.get(scoreKey(mirrored(s)));
    const value = s.mine === s.theirs ? 0 : mirror !== undefined ? -mirror : raw;
    symmetryGap = Math.max(symmetryGap, Math.abs(raw - value));
    values.set(scoreKey(s), value);
  }
  const at = <T>(map: Map<string, T>, score: SeriesScore): T => {
    const hit = map.get(scoreKey(score));
    if (hit === undefined) throw new Error(`no such score in a series still on: ${score.mine} to ${score.theirs} with ${score.left} left`);
    return hit;
  };
  const sol: SeriesSolution = {
    rules,
    format,
    value: (score) => at(values, score),
    drawWorth: (score) => at(worths, score),
    mix: (score, r, p, a, b) => {
      if (![r, p, a, b].every(Number.isInteger) || r < 0 || r >= R || Math.abs(p) >= D || a < 0 || a > E || b < 0 || b > E) throw new Error(`no such state: round ${r}, node ${p}, energies ${a}/${b}`);
      const k = g.at(r, p, a, b);
      return at(strategies, score).data.subarray(g.off[k]!, g.off[k + 1]!);
    },
    strategy: (score) => at(strategies, score),
    tables: tables.size,
    symmetryGap,
  };
  solved.set(id, sol);
  return sol;
}

/** A pull drawn from a mix over 0..n with a uniform number in [0, 1). */
export function pullFrom(mix: ArrayLike<number>, u: number): number {
  let total = 0;
  for (let i = 0; i < mix.length; i++) total += mix[i]!;
  let acc = 0;
  for (let i = 0; i < mix.length; i++) {
    acc += mix[i]! / total;
    if (u < acc) return i;
  }
  return mix.length - 1;
}

/**
 * The series equilibrium's pull for `player` in the open round of a series. `u` is a uniform number in [0, 1) that
 * the opponent can't know or guess: fresh from a secure source every round, never from anything on-chain or reused.
 * A mix only protects a player whose draws are secret.
 */
export function seriesPull(s: SeriesState, player: Player, u: number, sol: SeriesSolution = solveSeries(s.config.rules)): number {
  if (s.ending) throw new Error("the series is over");
  if (!(u >= 0 && u < 1)) throw new Error("u is a number from 0 up to, not including, 1");
  const side = sideOf(player, s.match), game = s.game;
  return pullFrom(sol.mix(seriesScore(s, player), game.rounds.length, nodeFor(game, side), game.energy[side], game.energy[other(side)]), u);
}
