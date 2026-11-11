// npm run arena:series: a best-of-5 wager series of The Line, solved (docs/research/series-equilibrium.md). The house's
// Even plays each match as if it stood alone: a win +1, a draw 0, a loss -1. In a series a drawn match is rarely worth
// half a win, so this asks what a player that knows the series score earns against Even, and what the series' own
// equilibrium is. Everything in the first four sections is computed, not sampled: backward induction over every state
// of a match, inside backward induction over the series score. The last section plays the same strategies through the
// on-chain program's twin (src/arena/series.ts) and checks the computed numbers fall inside what it measures.
// Research only: it changes no rule and touches no network.
// Usage: npm run arena:series [-- --series 40000 --quick --no-sim --fee 0.025 --cap 7]
// --cap asks about a format that doesn't exist: first to three wins with drawn matches replayed, up to that many
// matches in all (5 is today's best-of-5). The program's twin plays only five, so a capped run isn't played out.

import {
  DUELS_1, MATCHES, MATCH_PAYOFFS, commit, fallbackCommitment, houseMove, moveCommitment, nodeFor, other, reveal, sideOf, solve, startSeries,
  type Payoffs, type Player, type Solution,
} from "../src/arena/index.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
/** Wins that take a series, and the most matches it can last. */
const WINS = (MATCHES + 1) / 2, CAP = option("cap", MATCHES);
if (!Number.isInteger(CAP) || CAP < MATCHES || CAP > 15) throw new Error(`--cap is a whole number of matches from ${MATCHES} to 15`);
const SERIES = flag("no-sim") || CAP !== MATCHES ? 0 : option("series", flag("quick") ? 2_000 : 40_000);
/** The rake, as a share of a decided pot (docs/wager-mode.md 6.4): the winner nets 1 - 2 x fee stakes. */
const FEE = option("fee", 0.025);

const RULES = DUELS_1;
const { places: D, energy: E, regen: REGEN, rounds: R } = RULES;

// ---------------------------------------------------------------- a match's states

// A state is (round, node from my view, my energy, the opponent's), as in solve.ts. A strategy gives a weight to each
// pull 0..me in every state; `data` holds them end to end, `OFF` says where a state's start, `total` what they sum to
// (a player drawing from a stored mix divides by it, as the house's draw() does).
const P = 2 * D - 1, E1 = E + 1, STATES = R * P * E1 * E1;
const at = (r: number, p: number, a: number, b: number) => ((r * P + (p + D - 1)) * E1 + a) * E1 + b;
const OFF = new Int32Array(STATES + 1);
for (let r = 0; r < R; r++) for (let p = -(D - 1); p <= D - 1; p++) for (let a = 0; a <= E; a++) for (let b = 0; b <= E; b++) OFF[at(r, p, a, b) + 1] = a + 1;
for (let k = 0; k < STATES; k++) OFF[k + 1]! += OFF[k]!;
const START = at(0, 0, E, E);

interface Strategy {
  data: Float32Array;
  total: Float64Array;
}

/** A solved table's mixes, exactly as stored (32-bit weights), so what is measured is what a player would really draw from. */
function strategyOf(sol: Solution): Strategy {
  const data = new Float32Array(OFF[STATES]!), total = new Float64Array(STATES);
  for (let r = 0; r < R; r++) for (let p = -(D - 1); p <= D - 1; p++) for (let a = 0; a <= E; a++) for (let b = 0; b <= E; b++) {
    const k = at(r, p, a, b), mix = sol.mix(r, p, a, b);
    data.set(mix, OFF[k]!);
    let t = 0;
    for (let i = 0; i < mix.length; i++) t += mix[i]!;
    total[k] = t;
  }
  return { data, total };
}

/** A strategy that always plays one pull per state. */
function pure(pulls: Uint8Array): Strategy {
  const data = new Float32Array(OFF[STATES]!), total = new Float64Array(STATES).fill(1);
  for (let k = 0; k < STATES; k++) data[OFF[k]! + pulls[k]!] = 1;
  return { data, total };
}

const QJ = new Int32Array(E1), QP = new Float64Array(E1), XI = new Int32Array(E1), XP = new Float64Array(E1);
/** The pulls a strategy gives any weight in state `k`, into `pulls` and `probs`; returns how many. */
function support(s: Strategy, k: number, n: number, pulls: Int32Array, probs: Float64Array): number {
  const off = OFF[k]!, tot = s.total[k]!;
  let c = 0;
  for (let j = 0; j < n; j++) {
    const w = s.data[off + j]!;
    if (w > 0) (pulls[c] = j), (probs[c] = w / tot), c++;
  }
  return c;
}

/**
 * The best a player can do in one match against `opp`, when a win, a draw and a loss are worth `pay` to it: every
 * state's value under its best pull (the opponent's mix is fixed, so this is a plain maximum, no game to solve).
 */
function bestResponse(opp: Strategy, pay: Payoffs): { value: number; pulls: Uint8Array } {
  const { win, draw, loss } = pay;
  const V = new Float64Array(STATES), pulls = new Uint8Array(STATES);
  for (let r = R - 1; r >= 0; r--) for (let p = -(D - 1); p <= D - 1; p++) for (let a = 0; a <= E; a++) for (let b = 0; b <= E; b++) {
    const nq = support(opp, at(r, -p, b, a), b + 1, QJ, QP);
    let best = -Infinity, bi = 0;
    for (let i = 0; i <= a; i++) {
      const na = Math.min(E, a - i + REGEN);
      let v = 0;
      for (let t = 0; t < nq; t++) {
        const j = QJ[t]!, np = p + Math.sign(i - j);
        if (np >= D) v += QP[t]! * win;
        else if (np <= -D) v += QP[t]! * loss;
        else if (r + 1 >= R) v += QP[t]! * (np > 0 ? win : np < 0 ? loss : draw);
        else v += QP[t]! * V[at(r + 1, np, na, Math.min(E, b - j + REGEN))]!;
      }
      if (v > best + 1e-12) (best = v), (bi = i);
    }
    const k = at(r, p, a, b);
    V[k] = best;
    pulls[k] = bi;
  }
  return { value: V[START]!, pulls };
}

type Odds = { win: number; draw: number; loss: number };

/** How one match between two strategies ends, from the first one's view. */
function evaluate(mine: Strategy, opp: Strategy): Odds {
  const PW = new Float64Array(STATES), PD = new Float64Array(STATES);
  for (let r = R - 1; r >= 0; r--) for (let p = -(D - 1); p <= D - 1; p++) for (let a = 0; a <= E; a++) for (let b = 0; b <= E; b++) {
    const k = at(r, p, a, b);
    const nx = support(mine, k, a + 1, XI, XP), nq = support(opp, at(r, -p, b, a), b + 1, QJ, QP);
    let pw = 0, pd = 0;
    for (let s = 0; s < nx; s++) {
      const i = XI[s]!, na = Math.min(E, a - i + REGEN);
      for (let t = 0; t < nq; t++) {
        const j = QJ[t]!, w = XP[s]! * QP[t]!, np = p + Math.sign(i - j);
        if (np >= D) pw += w;
        else if (np <= -D) continue;
        else if (r + 1 >= R) {
          if (np > 0) pw += w;
          else if (np === 0) pd += w;
        } else {
          const kn = at(r + 1, np, na, Math.min(E, b - j + REGEN));
          pw += w * PW[kn]!;
          pd += w * PD[kn]!;
        }
      }
    }
    PW[k] = pw;
    PD[k] = pd;
  }
  return { win: PW[START]!, draw: PD[START]!, loss: 1 - PW[START]! - PD[START]! };
}

/**
 * How far two players' mixes are from Even's over a whole match they play against each other: the total variation
 * between each one's mix and Even's in every state, averaged over the rounds the match really reaches. 0 is Even's own
 * play; 1 would be never sharing a pull with it.
 */
function drift(mine: Strategy, opp: Strategy, even: Strategy): { mine: number; opp: number } {
  const reach = new Float64Array(STATES);
  reach[START] = 1;
  const apart = (s: Strategy, k: number, n: number) => {
    let d = 0;
    for (let i = 0, off = OFF[k]!; i < n; i++) d += Math.abs(s.data[off + i]! / s.total[k]! - even.data[off + i]! / even.total[k]!);
    return d / 2;
  };
  let rounds = 0, dMine = 0, dOpp = 0;
  for (let r = 0; r < R; r++) for (let p = -(D - 1); p <= D - 1; p++) for (let a = 0; a <= E; a++) for (let b = 0; b <= E; b++) {
    const k = at(r, p, a, b), here = reach[k]!;
    if (here === 0) continue;
    const ko = at(r, -p, b, a);
    rounds += here;
    dMine += here * apart(mine, k, a + 1);
    dOpp += here * apart(opp, ko, b + 1);
    if (r + 1 >= R) continue;
    const nx = support(mine, k, a + 1, XI, XP), nq = support(opp, ko, b + 1, QJ, QP);
    for (let s = 0; s < nx; s++) for (let t = 0; t < nq; t++) {
      const i = XI[s]!, j = QJ[t]!, np = p + Math.sign(i - j);
      if (Math.abs(np) < D) reach[at(r + 1, np, Math.min(E, a - i + REGEN), Math.min(E, b - j + REGEN))]! += here * XP[s]! * QP[t]!;
    }
  }
  return { mine: dMine / rounds, opp: dOpp / rounds };
}

// ---------------------------------------------------------------- the series' scores

// A score is (matches I won, matches the opponent won, matches left), from one player's view; the draws are the rest.
// How a series ends is src/arena/series.ts's endMatch: decided once a side leads by more than the matches left, and a
// series level after the last match is a draw. (In five matches, three wins always lead by more than what's left, so
// "first to three" adds nothing there; it matters only under --cap.)
function decided(a: number, b: number, left: number): 1 | 0 | -1 | null {
  if (a >= WINS || a > b + left) return 1;
  if (b >= WINS || b > a + left) return -1;
  if (left === 0) return a > b ? 1 : a < b ? -1 : 0;
  return null;
}
const key = (a: number, b: number, left: number) => `${a}-${b}/${left}`;
type Score = { a: number; b: number; left: number };
/** Every score a series can pass through, the last match first. */
const SCORES: Score[] = [];
for (let left = 1; left <= CAP; left++) for (let a = 0; a < WINS; a++) for (let b = 0; b < WINS && a + b + left <= CAP; b++) if (decided(a, b, left) === null) SCORES.push({ a, b, left });

/** What a decided series pays, in stakes: both stakes to the winner less the rake, a refund for a draw. */
const settle = (fee: number) => (outcome: 1 | 0 | -1) => (outcome === 1 ? 1 - 2 * fee : outcome);

/**
 * A table of series values by score, built from the last match back: `matchValue` says what the match at a score is
 * worth given what the three scores it can lead to are worth.
 */
function seriesValues(fee: number, matchValue: (s: Score, next: Payoffs) => number): Map<string, number> {
  const W = new Map<string, number>(), pay = settle(fee);
  for (const s of SCORES) W.set(key(s.a, s.b, s.left), matchValue(s, nextPayoffs(W, s, pay)));
  return W;
}
function nextPayoffs(W: Map<string, number>, s: Score, pay: (o: 1 | 0 | -1) => number = settle(0)): Payoffs {
  const v = (a: number, b: number, left: number) => {
    const d = decided(a, b, left);
    return d === null ? W.get(key(a, b, left))! : pay(d);
  };
  return { win: v(s.a + 1, s.b, s.left - 1), draw: v(s.a, s.b, s.left - 1), loss: v(s.a, s.b + 1, s.left - 1) };
}

/** A series' chances of ending won, drawn and lost from every score, given each score's match odds. */
function seriesOdds(matchOdds: (s: Score) => Odds): Map<string, Odds> {
  const out = new Map<string, Odds>();
  const v = (a: number, b: number, left: number): Odds => {
    const d = decided(a, b, left);
    return d === null ? out.get(key(a, b, left))! : { win: d === 1 ? 1 : 0, draw: d === 0 ? 1 : 0, loss: d === -1 ? 1 : 0 };
  };
  for (const s of SCORES) {
    const m = matchOdds(s), w = v(s.a + 1, s.b, s.left - 1), d = v(s.a, s.b, s.left - 1), l = v(s.a, s.b + 1, s.left - 1);
    out.set(key(s.a, s.b, s.left), {
      win: m.win * w.win + m.draw * d.win + m.loss * l.win,
      draw: m.win * w.draw + m.draw * d.draw + m.loss * l.draw,
      loss: m.win * w.loss + m.draw * d.loss + m.loss * l.loss,
    });
  }
  return out;
}

// ---------------------------------------------------------------- printing

const pct = (x: number, digits = 2) => `${(100 * x).toFixed(digits)}%`;
const signed = (x: number, digits = 4) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(digits)}`;
const odds = (o: Odds, digits = 2) => `${pct(o.win, digits)} / ${pct(o.draw, digits)} / ${pct(o.loss, digits)}`;
const net = (o: Odds, fee = 0) => o.win * (1 - 2 * fee) - o.loss;
const scoreName = (s: Score) => `${s.a}–${s.b}, ${s.left} left`;
/** Where a draw sits between a loss (0) and a win (1) for these worths. Even assumes one half. */
const drawShare = (p: Payoffs) => (p.win === p.loss ? Number.NaN : (p.draw - p.loss) / (p.win - p.loss));
const row = (cells: (string | number)[]) => console.log(`| ${cells.join(" | ")} |`);
const head = (cells: string[]) => (row(cells), console.log(`|${cells.map(() => "---").join("|")}|`));

const started = Date.now();
console.log(`# The Line in a ${CAP === MATCHES ? `best-of-${MATCHES}` : `first-to-${WINS} of at most ${CAP} matches`}: Even against a player that knows the score\n`);
if (CAP !== MATCHES) console.log(`**Not a format that exists.** First to ${WINS} wins, drawn matches replayed, at most ${CAP} matches; after the last, the side with more wins takes it and a level series is a draw. Today's series is the same with at most ${MATCHES}.\n`);
console.log(`Rules \`${RULES.id}\`. Values are in stakes a series: +1 wins the opponent's stake, 0 is a refund, −1 loses your own. No rake unless a line says so.\n`);

// ---------------------------------------------------------------- 1. one match

const EVEN = strategyOf(solve(RULES));
const evenMatch = evaluate(EVEN, EVEN);
const oneMatch = bestResponse(EVEN, MATCH_PAYOFFS);
console.log("## 1. One match on its own (the baseline)\n");
console.log(`- Even against Even: ${odds(evenMatch)} (win / draw / loss), worth ${signed(net(evenMatch), 6)}.`);
console.log(`- The best response to Even in a single match scores ${signed(oneMatch.value, 6)}: the claim in docs/arena.md 4.2 holds for one match, but for a few states the stored table gets slightly wrong.`);

// ---------------------------------------------------------------- 2. against Even, knowing the score

// The responder's best play at every score: the match there is worth what the scores it leads to are worth.
const brPulls = new Map<string, Uint8Array>();
const brValues = seriesValues(0, (s, next) => {
  const br = bestResponse(EVEN, next);
  brPulls.set(key(s.a, s.b, s.left), br.pulls);
  return br.value;
});
const brMatch = new Map<string, Odds>();
for (const s of SCORES) brMatch.set(key(s.a, s.b, s.left), evaluate(pure(brPulls.get(key(s.a, s.b, s.left))!), EVEN));
const brSeries = seriesOdds((s) => brMatch.get(key(s.a, s.b, s.left))!);
const evenSeries = seriesOdds(() => evenMatch);

// The same with the rake taken from the winner: is the edge still there after it?
const brFeePulls = new Map<string, Uint8Array>();
const brFeeValues = seriesValues(FEE, (s, next) => {
  const br = bestResponse(EVEN, next);
  brFeePulls.set(key(s.a, s.b, s.left), br.pulls);
  return br.value;
});
const brFeeSeries = seriesOdds((s) => evaluate(pure(brFeePulls.get(key(s.a, s.b, s.left))!), EVEN));

// ---------------------------------------------------------------- 3. the series' own equilibrium

// Both sides know the score. Each score's match is a zero-sum game with the next scores' values as its worths, so the
// series solves from the last match back. The game is symmetric, so a level score is worth exactly 0 and the trailing
// side's value is minus the leader's; the solver's own numbers are checked against that below.
//
// A match's mixes depend only on where the draw sits between the loss and the win (stretching and shifting the three
// worths together changes nothing), so one table serves every score with the same draw's worth: `share` is the match's
// value on that same scale, 0 a sure loss and 1 a sure win. At a level score that is Even's own game; it is solved
// again here with the solver's careful pivot rule (any worths but the exact default get it), because Even's stored
// table is a little off in a few states (section 1) and the check below should measure this equilibrium, not that.
function seriesEquilibrium() {
  const tables = new Map<string, { strategy: Strategy; share: number }>();
  const strategy = new Map<string, Strategy>(), values = new Map<string, number>();
  let symmetryGap = 0;
  for (const s of SCORES) {
    const next = nextPayoffs(values, s);
    const id = drawShare(next).toFixed(12);
    let table = tables.get(id);
    if (!table) {
      const sol = solve(RULES, { win: 2, draw: 4 * drawShare(next) - 2, loss: -2 });
      tables.set(id, (table = { strategy: strategyOf(sol), share: (sol.value(0, 0, E, E) + 2) / 4 }));
    }
    strategy.set(key(s.a, s.b, s.left), table.strategy);
    const raw = next.loss + (next.win - next.loss) * table.share;
    const mirror = values.get(key(s.b, s.a, s.left));
    const value = s.a === s.b ? 0 : mirror !== undefined ? -mirror : raw;
    symmetryGap = Math.max(symmetryGap, Math.abs(raw - value));
    values.set(key(s.a, s.b, s.left), value);
  }
  const of = (s: Score) => strategy.get(key(s.a, s.b, s.left))!, opp = (s: Score) => strategy.get(key(s.b, s.a, s.left))!;
  const match = new Map<string, Odds>(), vsEvenMatch = new Map<string, Odds>();
  for (const s of SCORES) match.set(key(s.a, s.b, s.left), evaluate(of(s), opp(s)));
  for (const s of SCORES) vsEvenMatch.set(key(s.a, s.b, s.left), evaluate(of(s), EVEN));
  return {
    values, of, opp, match, symmetryGap, tables: tables.size,
    series: seriesOdds((s) => match.get(key(s.a, s.b, s.left))!),
    vsEven: seriesOdds((s) => vsEvenMatch.get(key(s.a, s.b, s.left))!),
    // The check that the stored equilibrium really is one: the best any score-aware player can do against it.
    best: seriesValues(0, (s, next) => bestResponse(opp(s), next).value),
  };
}
// The careful simplex refuses a state it can't solve to 1e-6. It never does in today's best-of-5; in a longer capped
// series a draw can be worth within a hair of half a win, the match is then nearly Even's own and nearly degenerate,
// and it may. That costs a capped run its equilibrium lines, nothing else: the best response to Even needs no solving.
let eq: ReturnType<typeof seriesEquilibrium> | null = null, eqProblem = "";
try {
  eq = seriesEquilibrium();
} catch (e) {
  if (CAP === MATCHES) throw e;
  eqProblem = (e as Error).message;
}

const startKey = key(0, 0, CAP);
console.log("\n## 2. The series, computed\n");
head(["Pairing (the first player's view)", "Value, stakes a series", "Series won / drawn / lost"]);
row(["Even v Even", signed(net(evenSeries.get(startKey)!), 6), odds(evenSeries.get(startKey)!)]);
row(["**Best response to Even, knowing the score** v Even", `**${signed(brValues.get(startKey)!)}**`, odds(brSeries.get(startKey)!)]);
if (eq) {
  row(["The series equilibrium v Even", signed(net(eq.vsEven.get(startKey)!)), odds(eq.vsEven.get(startKey)!)]);
  row(["The series equilibrium v itself", signed(net(eq.series.get(startKey)!), 6), odds(eq.series.get(startKey)!)]);
  row(["Best response to the series equilibrium v it (a check: should be 0)", signed(eq.best.get(startKey)!, 6), ""]);
}
row([`Best response to Even v Even, **after a ${pct(FEE, 1)} rake** on decided pots`, signed(brFeeValues.get(startKey)!), odds(brFeeSeries.get(startKey)!)]);
console.log(`\nEven v Even after the same rake: ${signed(net(evenSeries.get(startKey)!, FEE))} each.`);
if (eq) console.log(`The equilibrium took ${eq.tables} match tables, one for each worth of a draw; its values broke the game's symmetry by at most ${eq.symmetryGap.toExponential(1)}. Its won / drawn / lost are one equilibrium's: others, worth the same, draw more or less often.`);
else console.log(`\nThe series equilibrium isn't shown: the solver couldn't certify one of its matches (${eqProblem}).`);

// ---------------------------------------------------------------- score by score

console.log("\n## 3. Score by score: the best response to Even\n");
console.log(`The responder's view. A draw's worth is where a drawn match sits between losing it (0) and winning it (1), in series value; Even plays every match as if it were 0.5. Even against Even, every match goes ${odds(evenMatch, 1)}.\n`);
head(["Score (responder–Even)", "A draw's worth", "Series value, Even v Even", "Series value, best response", "Gain", "This match, best response (win / draw / loss)"]);
for (const s of [...SCORES].reverse()) {
  const k = key(s.a, s.b, s.left), even = net(evenSeries.get(k)!), br = brValues.get(k)!;
  row([scoreName(s), drawShare(nextPayoffs(brValues, s)).toFixed(3), signed(even), signed(br), signed(br - even), odds(brMatch.get(k)!, 1)]);
}

if (eq) {
  console.log("\n## 4. Score by score: the series equilibrium, and how its mixes differ from Even's\n");
  console.log("The leader's view (level scores once). A mix's distance from Even's is the total variation (0% the same mix, 100% no pull in common), averaged over the rounds a match between the two reaches. Even's shortfall is what it gives up from that score against a best response, measured from the equilibrium's value there.\n");
  const opening = (s: Strategy) => Array.from({ length: E1 }, (_, i) => s.data[OFF[START]! + i]! / s.total[START]!);
  const evenOpen = opening(EVEN);
  head(["Score (leader–trailer)", "A draw's worth to the leader", "Leader's series value", "Even v Even from here", "This match under the equilibrium (leader wins / draw / trailer wins)", "Distance from Even: leader, trailer", "Even's shortfall as leader, as trailer"]);
  for (const s of [...SCORES].reverse()) {
    if (s.a < s.b) continue;
    const k = key(s.a, s.b, s.left), far = drift(eq.of(s), eq.opp(s), EVEN);
    // What Even gives up against the best response from this score, in each seat, measured against the equilibrium value.
    const asLeader = -brValues.get(key(s.b, s.a, s.left))! - eq.values.get(k)!, asTrailer = brValues.get(k)! - eq.values.get(k)!;
    row([
      scoreName(s), drawShare(nextPayoffs(eq.values, s)).toFixed(3), signed(eq.values.get(k)!), signed(net(evenSeries.get(k)!)), odds(eq.match.get(k)!, 1),
      `${pct(far.mine, 1)}, ${pct(far.opp, 1)}`,
      s.a === s.b ? signed(-asTrailer) : `${signed(asLeader)}, ${signed(-asTrailer)}`,
    ]);
  }
  console.log("\nRound 1's mix, pull by pull (percent; blank is never):\n");
  const shown: { name: string; mix: number[] }[] = [{ name: "Even (every score)", mix: evenOpen }];
  for (const [a, b, left] of [[1, 0, 4], [1, 0, 2], [2, 0, 2], [1, 0, 1]] as const) {
    shown.push({ name: `Leader at ${a}–${b}, ${left} left`, mix: opening(eq.of({ a, b, left })) });
    shown.push({ name: `Trailer at ${a}–${b}, ${left} left`, mix: opening(eq.opp({ a, b, left })) });
  }
  const widest = Math.max(...shown.map((x) => x.mix.reduce((n, w, i) => (w >= 0.0005 ? i : n), 0)));
  head(["Pull", ...Array.from({ length: widest + 1 }, (_, i) => String(i))]);
  for (const x of shown) row([x.name, ...x.mix.slice(0, widest + 1).map((w) => (w >= 0.0005 ? (100 * w).toFixed(1) : ""))]);
}

console.log(`\n_Computed in ${((Date.now() - started) / 1000).toFixed(0)}s._`);

// ---------------------------------------------------------------- 5. played through the program's twin

if (SERIES > 0) {
  const simStarted = Date.now();
  /** A fast seeded generator for the score-aware players (Even draws from its own seed, as the house does). */
  const mulberry = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  /** A pull for the state `k` (the mover's view) at the series score `s` (the mover's view). */
  type Mover = (s: Score, k: number, rand: () => number) => number;
  const fromPulls = (table: Map<string, Uint8Array>): Mover => (s, k) => table.get(key(s.a, s.b, s.left))![k]!;
  const fromMixes: Mover = (s, k, rand) => {
    const st = eq!.of(s), off = OFF[k]!, n = OFF[k + 1]! - off, u = rand() * st.total[k]!;
    let acc = 0;
    for (let i = 0; i < n; i++) if ((acc += st.data[off + i]!) > u) return i;
    return n - 1;
  };
  const NONCE = "00".repeat(31) + "01", SALT = "00".repeat(31) + "02", CONFIG = { rules: RULES, revealSeconds: 120 };

  /**
   * `n` series through startSeries, commit and reveal, the first player in seat A in the even ones and seat B in the
   * odd ones. A null mover is Even: houseMove with a fresh seed each match, blind to the series.
   */
  function play(n: number, first: Mover | null, salt: number) {
    let win = 0, draw = 0, loss = 0;
    for (let i = 0; i < n; i++) {
      const seat: Player = i % 2 === 0 ? "A" : "B", them: Player = seat === "A" ? "B" : "A";
      const id = (salt * 0x1000000 + i).toString(16).padStart(64, "0"), rand = mulberry(salt * 1_000_003 + i);
      const s = startSeries(CONFIG, id, { A: fallbackCommitment(id, "A", { kind: "zero" }, SALT), B: fallbackCommitment(id, "B", { kind: "zero" }, SALT) }, 0);
      let now = 0;
      while (!s.ending) {
        const wins = (p: Player) => s.results.filter((x) => x.winner === p).length;
        const score: Score = { a: wins(seat), b: wins(them), left: MATCHES - s.results.length };
        const side = sideOf(seat, s.match), round = s.game.rounds.length + 1, match = s.match;
        const k = at(round - 1, nodeFor(s.game, side), s.game.energy[side], s.game.energy[other(side)]);
        const mine = first ? first(score, k, rand) : houseMove("even", s.game, side, `first-${salt}-${i}-${match}`);
        const theirs = houseMove("even", s.game, other(side), `second-${salt}-${i}-${match}`);
        commit(s, seat, round, moveCommitment(id, match, round, side, mine, NONCE), now);
        commit(s, them, round, moveCommitment(id, match, round, other(side), theirs, NONCE), now);
        reveal(s, seat, { pull: mine, nonce: NONCE }, now + 1);
        reveal(s, them, { pull: theirs, nonce: NONCE }, now + 1);
        now += 2;
      }
      if (s.ending.winner === seat) win++;
      else if (s.ending.winner === null) draw++;
      else loss++;
    }
    const m = (win - loss) / n, sd = Math.sqrt(Math.max(0, (win + loss) / n - m * m) * (n / (n - 1)));
    return { win: win / n, draw: draw / n, loss: loss / n, mean: m, half: (1.96 * sd) / Math.sqrt(n) };
  }

  console.log(`\n## 5. Played out: ${SERIES.toLocaleString("en")} series a pairing through src/arena/series.ts\n`);
  console.log("Every round is committed and revealed through the on-chain program's twin, half the series from each seat. The interval is 95% (1.96 standard errors of the mean).\n");
  head(["Pairing (the first player's view)", "Measured, stakes a series", "95% interval", "Computed", "Inside", "Measured won / drawn / lost", "Computed won / drawn / lost"]);
  const lines: [string, Mover | null, number, Odds][] = [
    ["Even v Even", null, net(evenSeries.get(startKey)!), evenSeries.get(startKey)!],
    ["Best response to Even v Even", fromPulls(brPulls), brValues.get(startKey)!, brSeries.get(startKey)!],
    ["The series equilibrium v Even", fromMixes, net(eq!.vsEven.get(startKey)!), eq!.vsEven.get(startKey)!],
  ];
  let allInside = true;
  lines.forEach(([name, mover, exact, exactOdds], i) => {
    const t = play(SERIES, mover, i + 1), inside = Math.abs(t.mean - exact) <= t.half;
    allInside &&= inside;
    row([name, signed(t.mean), `${signed(t.mean - t.half)} to ${signed(t.mean + t.half)}`, signed(exact), inside ? "yes" : "**no**", odds(t, 1), odds(exactOdds, 1)]);
  });
  console.log(`\n_Played in ${((Date.now() - simStarted) / 1000).toFixed(0)}s._`);
  if (!allInside) console.log("\nA computed value fell outside its measured interval. One line in twenty does by chance; run again with more series before reading anything into it.");
}
