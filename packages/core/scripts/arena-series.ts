// npm run arena:series: a best-of-5 wager series of The Line, solved (docs/research/series-equilibrium.md). The house's
// Even plays each match as if it stood alone: a win +1, a draw 0, a loss -1. In a series a drawn match is rarely worth
// half a win, so this asks what a player that knows the series score earns against Even, and what the series' own
// equilibrium is. Everything in the first four sections is computed, not sampled: backward induction over every state
// of a match, inside backward induction over the series score. The last section plays the same strategies through the
// on-chain program's twin (src/arena/series.ts) and checks the computed numbers fall inside what it measures. The
// solving is src/arena/series-solve.ts (`solveSeries` is the series' equilibrium agents are pointed at); this script
// only measures. It changes no rule and touches no network.
// Usage: npm run arena:series [-- --series 40000 --quick --no-sim --fee 0.025 --cap 7]
// --cap asks about a format that doesn't exist: first to three wins with drawn matches replayed, up to that many
// matches in all (5 is today's best-of-5). The program's twin plays only five, so a capped run isn't played out.

import {
  BEST_OF_5, DUELS_1, MATCH_PAYOFFS, commit, fallbackCommitment, houseMove, moveCommitment, nodeFor, other, reveal, seriesPull, seriesScore, sideOf, solve,
  solveSeries, startSeries, type MatchStrategy, type Player, type SeriesFormat, type SeriesScore, type SeriesSolution,
  type SeriesState,
} from "../src/arena/index.ts";
import {
  bestResponse, drawWorth, matchGrid, matchOdds, nextPayoffs, pureStrategy, scoreKey, seriesOdds, seriesScores, seriesValues, strategyOf, type Odds,
} from "../src/arena/series-solve.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const MATCHES = BEST_OF_5.matches, WINS = BEST_OF_5.wins;
/** The most matches a series can last: today's five, or more under --cap. */
const CAP = option("cap", MATCHES);
if (!Number.isInteger(CAP) || CAP < MATCHES || CAP > 15) throw new Error(`--cap is a whole number of matches from ${MATCHES} to 15`);
const FORMAT: SeriesFormat = { matches: CAP, wins: WINS };
const SERIES = flag("no-sim") || CAP !== MATCHES ? 0 : option("series", flag("quick") ? 2_000 : 40_000);
/** The rake, as a share of a decided pot (docs/wager-mode.md 6.4): the winner nets 1 - 2 x fee stakes. */
const FEE = option("fee", 0.025);

const RULES = DUELS_1;
const { places: D, energy: E, regen: REGEN, rounds: R } = RULES;
const E1 = E + 1, GRID = matchGrid(RULES), { off: OFF, start: START, at } = GRID;

/** The pulls a strategy gives any weight in state `k`, into `pulls` and `probs`; returns how many. */
function support(s: MatchStrategy, k: number, pulls: Int32Array, probs: Float64Array): number {
  const from = OFF[k]!, n = OFF[k + 1]! - from, tot = s.total[k]!;
  let c = 0;
  for (let j = 0; j < n; j++) {
    const w = s.data[from + j]!;
    if (w > 0) (pulls[c] = j), (probs[c] = w / tot), c++;
  }
  return c;
}

/**
 * How far two players' mixes are from Even's over a whole match they play against each other: the total variation
 * between each one's mix and Even's in every state, averaged over the rounds the match really reaches. 0 is Even's own
 * play; 1 would be never sharing a pull with it.
 */
function drift(mine: MatchStrategy, opp: MatchStrategy, even: MatchStrategy): { mine: number; opp: number } {
  const reach = new Float64Array(GRID.states);
  reach[START] = 1;
  const XI = new Int32Array(E1), XP = new Float64Array(E1), QJ = new Int32Array(E1), QP = new Float64Array(E1);
  const apart = (s: MatchStrategy, k: number) => {
    let d = 0;
    for (let i = OFF[k]!; i < OFF[k + 1]!; i++) d += Math.abs(s.data[i]! / s.total[k]! - even.data[i]! / even.total[k]!);
    return d / 2;
  };
  let rounds = 0, dMine = 0, dOpp = 0;
  for (let r = 0; r < R; r++) for (let p = -(D - 1); p <= D - 1; p++) for (let a = 0; a <= E; a++) for (let b = 0; b <= E; b++) {
    const k = at(r, p, a, b), here = reach[k]!;
    if (here === 0) continue;
    const ko = at(r, -p, b, a);
    rounds += here;
    dMine += here * apart(mine, k);
    dOpp += here * apart(opp, ko);
    if (r + 1 >= R) continue;
    const nx = support(mine, k, XI, XP), nq = support(opp, ko, QJ, QP);
    for (let s = 0; s < nx; s++) for (let t = 0; t < nq; t++) {
      const i = XI[s]!, j = QJ[t]!, np = p + Math.sign(i - j);
      if (Math.abs(np) < D) reach[at(r + 1, np, Math.min(E, a - i + REGEN), Math.min(E, b - j + REGEN))]! += here * XP[s]! * QP[t]!;
    }
  }
  return { mine: dMine / rounds, opp: dOpp / rounds };
}

const SCORES = seriesScores(FORMAT);
const key = scoreKey;
const mirrored = (s: SeriesScore): SeriesScore => ({ mine: s.theirs, theirs: s.mine, left: s.left });

// ---------------------------------------------------------------- printing

const pct = (x: number, digits = 2) => `${(100 * x).toFixed(digits)}%`;
const signed = (x: number, digits = 4) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(digits)}`;
const odds = (o: Odds, digits = 2) => `${pct(o.win, digits)} / ${pct(o.draw, digits)} / ${pct(o.loss, digits)}`;
const net = (o: Odds, fee = 0) => o.win * (1 - 2 * fee) - o.loss;
const scoreName = (s: SeriesScore) => `${s.mine}–${s.theirs}, ${s.left} left`;
const row = (cells: (string | number)[]) => console.log(`| ${cells.join(" | ")} |`);
const head = (cells: string[]) => (row(cells), console.log(`|${cells.map(() => "---").join("|")}|`));

const started = Date.now();
console.log(`# The Line in a ${CAP === MATCHES ? `best-of-${MATCHES}` : `first-to-${WINS} of at most ${CAP} matches`}: Even against a player that knows the score\n`);
if (CAP !== MATCHES) console.log(`**Not a format that exists.** First to ${WINS} wins, drawn matches replayed, at most ${CAP} matches; after the last, the side with more wins takes it and a level series is a draw. Today's series is the same with at most ${MATCHES}.\n`);
console.log(`Rules \`${RULES.id}\`. Values are in stakes a series: +1 wins the opponent's stake, 0 is a refund, −1 loses your own. No rake unless a line says so.\n`);

// ---------------------------------------------------------------- 1. one match

const EVEN = strategyOf(solve(RULES));
const evenMatch = matchOdds(EVEN, EVEN);
const oneMatch = bestResponse(EVEN, MATCH_PAYOFFS);
console.log("## 1. One match on its own (the baseline)\n");
console.log(`- Even against Even: ${odds(evenMatch)} (win / draw / loss), worth ${signed(net(evenMatch), 6)}.`);
console.log(`- The best response to Even in a single match scores ${signed(oneMatch.value, 6)}: the claim in docs/arena.md 4.2 holds for one match, but for a few states the stored table gets slightly wrong.`);

// ---------------------------------------------------------------- 2. against Even, knowing the score

// The responder's best play at every score: the match there is worth what the scores it leads to are worth.
const brPulls = new Map<string, Uint8Array>();
const brValues = seriesValues((s, next) => {
  const br = bestResponse(EVEN, next);
  brPulls.set(key(s), br.pulls);
  return br.value;
}, { format: FORMAT });
const brMatch = new Map<string, Odds>();
for (const s of SCORES) brMatch.set(key(s), matchOdds(pureStrategy(RULES, brPulls.get(key(s))!), EVEN));
const brSeries = seriesOdds((s) => brMatch.get(key(s))!, FORMAT);
const evenSeries = seriesOdds(() => evenMatch, FORMAT);

// The same with the rake taken from the winner: is the edge still there after it?
const brFeePulls = new Map<string, Uint8Array>();
const brFeeValues = seriesValues((s, next) => {
  const br = bestResponse(EVEN, next);
  brFeePulls.set(key(s), br.pulls);
  return br.value;
}, { format: FORMAT, fee: FEE });
const brFeeSeries = seriesOdds((s) => matchOdds(pureStrategy(RULES, brFeePulls.get(key(s))!), EVEN), FORMAT);

// ---------------------------------------------------------------- 3. the series' own equilibrium

// Both sides know the score: `solveSeries` in src/arena/series-solve.ts, the function agents are pointed at. Here it
// is measured: against itself, against Even, and against the best any score-aware player can do to it.
function seriesEquilibrium() {
  const sol: SeriesSolution = solveSeries(RULES, FORMAT);
  const of = (s: SeriesScore) => sol.strategy(s), opp = (s: SeriesScore) => sol.strategy(mirrored(s));
  const match = new Map<string, Odds>(), vsEvenMatch = new Map<string, Odds>();
  for (const s of SCORES) match.set(key(s), matchOdds(of(s), opp(s)));
  for (const s of SCORES) vsEvenMatch.set(key(s), matchOdds(of(s), EVEN));
  return {
    sol, of, opp, match,
    series: seriesOdds((s) => match.get(key(s))!, FORMAT),
    vsEven: seriesOdds((s) => vsEvenMatch.get(key(s))!, FORMAT),
    // The check that the stored equilibrium really is one: the best any score-aware player can do against it.
    best: seriesValues((s, next) => bestResponse(opp(s), next).value, { format: FORMAT }),
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

const startKey = key({ mine: 0, theirs: 0, left: CAP });
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
if (eq) console.log(`The equilibrium took ${eq.sol.tables} match tables, one for each worth of a draw; its values broke the game's symmetry by at most ${eq.sol.symmetryGap.toExponential(1)}. Its won / drawn / lost are one equilibrium's: others, worth the same, draw more or less often.`);
else console.log(`\nThe series equilibrium isn't shown: the solver couldn't certify one of its matches (${eqProblem}).`);

// ---------------------------------------------------------------- score by score

console.log("\n## 3. Score by score: the best response to Even\n");
console.log(`The responder's view. A draw's worth is where a drawn match sits between losing it (0) and winning it (1), in series value; Even plays every match as if it were 0.5. Even against Even, every match goes ${odds(evenMatch, 1)}.\n`);
head(["Score (responder–Even)", "A draw's worth", "Series value, Even v Even", "Series value, best response", "Gain", "This match, best response (win / draw / loss)"]);
for (const s of [...SCORES].reverse()) {
  const k = key(s), even = net(evenSeries.get(k)!), br = brValues.get(k)!;
  row([scoreName(s), drawWorth(nextPayoffs(brValues, s, { format: FORMAT })).toFixed(3), signed(even), signed(br), signed(br - even), odds(brMatch.get(k)!, 1)]);
}

if (eq) {
  console.log("\n## 4. Score by score: the series equilibrium, and how its mixes differ from Even's\n");
  console.log("The leader's view (level scores once). A mix's distance from Even's is the total variation (0% the same mix, 100% no pull in common), averaged over the rounds a match between the two reaches. Even's shortfall is what it gives up from that score against a best response, measured from the equilibrium's value there.\n");
  const opening = (s: MatchStrategy) => Array.from({ length: E1 }, (_, i) => s.data[OFF[START]! + i]! / s.total[START]!);
  const evenOpen = opening(EVEN);
  head(["Score (leader–trailer)", "A draw's worth to the leader", "Leader's series value", "Even v Even from here", "This match under the equilibrium (leader wins / draw / trailer wins)", "Distance from Even: leader, trailer", "Even's shortfall as leader, as trailer"]);
  for (const s of [...SCORES].reverse()) {
    if (s.mine < s.theirs) continue;
    const k = key(s), far = drift(eq.of(s), eq.opp(s), EVEN);
    // What Even gives up against the best response from this score, in each seat, measured against the equilibrium value.
    const asLeader = -brValues.get(key(mirrored(s)))! - eq.sol.value(s), asTrailer = brValues.get(k)! - eq.sol.value(s);
    row([
      scoreName(s), eq.sol.drawWorth(s).toFixed(3), signed(eq.sol.value(s)), signed(net(evenSeries.get(k)!)), odds(eq.match.get(k)!, 1),
      `${pct(far.mine, 1)}, ${pct(far.opp, 1)}`,
      s.mine === s.theirs ? signed(-asTrailer) : `${signed(asLeader)}, ${signed(-asTrailer)}`,
    ]);
  }
  console.log("\nRound 1's mix, pull by pull (percent; blank is never):\n");
  const shown: { name: string; mix: number[] }[] = [{ name: "Even (every score)", mix: evenOpen }];
  for (const [mine, theirs, left] of [[1, 0, 4], [1, 0, 2], [2, 0, 2], [1, 0, 1]] as const) {
    shown.push({ name: `Leader at ${mine}–${theirs}, ${left} left`, mix: opening(eq.of({ mine, theirs, left })) });
    shown.push({ name: `Trailer at ${mine}–${theirs}, ${left} left`, mix: opening(eq.opp({ mine, theirs, left })) });
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
  /** A player's pull in a series' open round, from its seat. */
  type Mover = (s: SeriesState, seat: Player, rand: () => number) => number;
  /** One fixed pull for each score and state: the best response to Even. */
  const fromPulls = (table: Map<string, Uint8Array>): Mover => (s, seat) => {
    const side = sideOf(seat, s.match);
    return table.get(key(seriesScore(s, seat)))![at(s.game.rounds.length, nodeFor(s.game, side), s.game.energy[side], s.game.energy[other(side)])]!;
  };
  /** The series equilibrium, through the function an agent would call. */
  const fromMixes: Mover = (s, seat, rand) => seriesPull(s, seat, rand(), eq!.sol);
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
        const side = sideOf(seat, s.match), round = s.game.rounds.length + 1, match = s.match;
        const mine = first ? first(s, seat, rand) : houseMove("even", s.game, side, `first-${salt}-${i}-${match}`);
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
