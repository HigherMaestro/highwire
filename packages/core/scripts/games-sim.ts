// npm run games:sim: two prototype games for the arena, played out (docs/research/new-games.md). The Lot and Three
// wires, each with simple and language-model-like players against a Reader-style player that needs no solver, and, with
// --exact, The Lot's true equilibrium. Local only: it touches no network.
//
//   npm run games:sim [-- --matches 1000 --quick --game lot|wires]
//   npm run games:sim -- --exact [--prizes 7 --energy 20]   The Lot's exact Even and Reader (the draft's size: minutes)
//   npm run games:sim -- --cost                              what an exact solution costs at growing sizes

import type { Side } from "../src/arena/rules.ts";
import { LOT_DRAFT, drawPrize, lotGames, playLot, solveLot, startLot, type LotRules, type LotSolution, type LotState } from "./games/lot.ts";
import { WIRES_DRAFT, playWires, solveWires, splits, startWires, taken, type WiresRules, type WiresState } from "./games/wires.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const MATCHES = option("matches", flag("quick") ? 200 : 1_000);
const ONLY = args.includes("--game") ? args[args.indexOf("--game") + 1] : undefined;

/** A fast seeded generator, as in arena-sim.ts. */
function mulberry(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

type Rand = () => number;
const other = (s: Side): Side => (s === "a" ? "b" : "a");
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const int = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

interface Game<S, M> {
  start(chance: Rand): S;
  play(s: S, a: M, b: M, chance: Rand): S;
  ending(s: S): { winner: Side | null; early: boolean } | null;
  rounds(s: S): number;
  /** Who won round 1, or null for a tie. */
  firstWinner(s: S): Side | null;
}
type Player<S, M> = { name: string; about: string; move: (s: S, side: Side, rand: Rand) => M };
type Tally = { win: number; draw: number; loss: number; rounds: number; early: number; led: number; ledWon: number };

/** `n` matches, `x` as a in the even ones and as b in the odd ones, from x's view. */
function duel<S, M>(game: Game<S, M>, x: Player<S, M>, y: Player<S, M>, n: number, salt: number): Tally {
  const t: Tally = { win: 0, draw: 0, loss: 0, rounds: 0, early: 0, led: 0, ledWon: 0 };
  for (let i = 0; i < n; i++) {
    const xSide: Side = i % 2 === 0 ? "a" : "b";
    const rx = mulberry(salt * 1_000_003 + i * 3), ry = mulberry(salt * 1_000_003 + i * 3 + 1), chance = mulberry(salt * 1_000_003 + i * 3 + 2);
    let s = game.start(chance);
    for (;;) {
      const mx = x.move(s, xSide, rx), my = y.move(s, other(xSide), ry);
      s = xSide === "a" ? game.play(s, mx, my, chance) : game.play(s, my, mx, chance);
      if (game.ending(s)) break;
    }
    const e = game.ending(s)!;
    if (e.winner === xSide) t.win++;
    else if (e.winner === null) t.draw++;
    else t.loss++;
    t.rounds += game.rounds(s);
    if (e.early) t.early++;
    const first = game.firstWinner(s);
    if (first) {
      t.led++;
      if (e.winner === first) t.ledWon++;
    }
  }
  return t;
}

const pct = (k: number, n: number) => (n ? `${((100 * k) / n).toFixed(0)}%` : "n/a");
const score = (t: Tally, n: number) => ((t.win - t.loss) / n).toFixed(2);

function table<S, M>(title: string, game: Game<S, M>, rows: Player<S, M>[], cols: Player<S, M>[]) {
  console.log(`\n### ${title}\n`);
  console.log(`| | ${cols.map((c) => c.name).join(" | ")} |`);
  console.log(`|---|${cols.map(() => "---").join("|")}|`);
  let salt = 1;
  for (const x of rows) {
    const cells = cols.map((y) => {
      const t = duel(game, x, y, MATCHES, salt++);
      return `${score(t, MATCHES)} (${pct(t.draw, MATCHES)} d)`;
    });
    console.log(`| **${x.name}** | ${cells.join(" | ")} |`);
  }
}

function profile<S, M>(title: string, early: string, game: Game<S, M>, pairs: [Player<S, M>, Player<S, M>][]) {
  console.log(`\n### ${title}\n`);
  console.log(`| Pairing | First wins | Draws | Second wins | Rounds | ${early} | Round-1 winner wins |`);
  console.log("|---|---|---|---|---|---|---|");
  let salt = 500;
  for (const [x, y] of pairs) {
    const t = duel(game, x, y, MATCHES, salt++);
    console.log(`| ${x.name} v ${y.name} | ${pct(t.win, MATCHES)} | ${pct(t.draw, MATCHES)} | ${pct(t.loss, MATCHES)} | ${(t.rounds / MATCHES).toFixed(1)} | ${pct(t.early, MATCHES)} | ${pct(t.ledWon, t.led)} |`);
  }
}

// ================================================================ The Lot

const lotGame = (rules: LotRules): Game<LotState, number> => ({
  start: (chance) => startLot(rules, drawPrize(rules.prizes, chance())),
  play: (s, a, b, chance) => playLot(s, a, b, s.left.length ? drawPrize(s.left, chance()) : undefined),
  ending: (s) => (s.ending ? { winner: s.ending.winner, early: s.ending.reason === "decided" } : null),
  rounds: (s) => s.rounds.length,
  firstWinner: (s) => s.rounds[0]?.winner ?? null,
});

type LotPlayer = Player<LotState, number>;
const lotClamp = (s: LotState, side: Side, n: number) => Math.max(0, Math.min(s.energy[side], Math.round(n)));
/** Prize value still to be decided, the one on offer included. */
const stillOpen = (s: LotState) => (s.prize ?? 0) + sum(s.left);
const lotLead = (s: LotState, side: Side) => s.score[side] - s.score[other(side)];
/** The "sensible" bid: this prize's share of what's still open, of the energy left. */
const fairBid = (s: LotState, side: Side) => (s.energy[side] * s.prize!) / stillOpen(s);

/** A rough value of a state to `side`, for players without a solver: the lead, plus the energy edge's share of what's left. */
function lotGuess(s: LotState, side: Side): number {
  if (s.ending) return s.ending.winner === side ? 1 : s.ending.winner === null ? 0 : -1;
  const open = stillOpen(s), me = s.energy[side], opp = s.energy[other(side)];
  return Math.tanh((1.5 * (lotLead(s, side) + (open * (me - opp)) / (me + opp + 1))) / open);
}

/**
 * What the opponent's past bids say it will bid now, one guess per past round, under whichever of five readings would
 * have predicted its bids best so far: a fixed amount, a share of its energy, an amount per prize point, a multiple of
 * the fair bid, or an answer to our last bid. The wire's `readOpponent`, with the prize added.
 */
function readLot(s: LotState, side: Side): number[] {
  const them = other(side), n = s.rounds.length;
  if (!n) return [];
  const energy: number[] = [], open: number[] = [];
  let e = s.rules.energy, o = sum(s.rules.prizes);
  for (const r of s.rounds) {
    energy.push(e);
    open.push(o);
    e -= r.bid[them];
    o -= r.prize;
  }
  const theirs = s.rounds.map((r) => r.bid[them]), mine = s.rounds.map((r) => r.bid[side]), prizes = s.rounds.map((r) => r.prize);
  const fair = (k: number) => (energy[k]! * prizes[k]!) / open[k]!;
  type Now = { energy: number; prize: number; fair: number; myLast: number };
  const readings: ((k: number, now: Now) => number)[] = [
    (k) => theirs[k]!,
    (k, now) => (energy[k]! > 0 ? (theirs[k]! / energy[k]!) * now.energy : 0),
    (k, now) => (theirs[k]! / prizes[k]!) * now.prize,
    (k, now) => (fair(k) > 0 ? (theirs[k]! / fair(k)) * now.fair : 0),
    (k, now) => (k > 0 ? now.myLast + theirs[k]! - mine[k - 1]! : Number.NaN),
  ];
  let best = 0, bestError = Infinity;
  readings.forEach((reading, i) => {
    let error = 0, counted = 0;
    for (let k = 1; k < n; k++) {
      const g = reading(k - 1, { energy: energy[k]!, prize: prizes[k]!, fair: fair(k), myLast: mine[k - 1]! });
      if (Number.isNaN(g)) continue;
      error += Math.abs(Math.max(0, Math.min(energy[k]!, Math.round(g))) - theirs[k]!);
      counted++;
    }
    const mean = counted ? error / counted : Infinity;
    if (mean < bestError - 1e-9) (bestError = mean), (best = i);
  });
  if (bestError === Infinity) best = 3;
  const now: Now = { energy: s.energy[them], prize: s.prize!, fair: fairBid(s, them), myLast: mine[n - 1]! };
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const g = readings[best]!(k, now);
    if (!Number.isNaN(g)) out.push(Math.max(0, Math.min(now.energy, Math.round(g))));
  }
  return out;
}

/** The bid that does best against a spread of opponent bids, by `worth` (the value after both bids). */
function bestBid(s: LotState, side: Side, predicted: number[], worth: (mine: number, theirs: number) => number): number {
  const me = s.energy[side], opp = s.energy[other(side)];
  let bestPull = 0, bestValue = -Infinity;
  for (let i = 0; i <= Math.min(me, opp + 1); i++) {
    let v = 0;
    for (let j = 0; j < predicted.length; j++) if (predicted[j]! > 0) v += predicted[j]! * worth(i, j);
    if (v > bestValue + 1e-9) (bestValue = v), (bestPull = i);
  }
  return bestPull;
}

/** The state after these two bids, with any prize next (its value doesn't matter to `lotGuess`'s inputs but the sum left). */
function lotAfter(s: LotState, side: Side, mine: number, theirs: number): LotState {
  return side === "a" ? playLot(s, mine, theirs, s.left[0]) : playLot(s, theirs, mine, s.left[0]);
}

const LOT_PLAYERS: LotPlayer[] = [
  {
    name: "scout",
    about: "Reader without a solver: half the time the best answer to a model of your bids (by a rough value of the state), half the time the fair bid with noise",
    move: (s, side, r) => {
      const opp = s.energy[other(side)];
      if (r() < 0.5) return lotClamp(s, side, fairBid(s, side) + int(r, -2, 2));
      const predicted = new Array<number>(opp + 1).fill(0);
      const seen = readLot(s, side);
      const w = seen.length / (seen.length + 2), prior = Math.round(fairBid(s, other(side)));
      for (const d of [-1, 0, 1, 2]) predicted[Math.max(0, Math.min(opp, prior + d))]! += (1 - w) / 4;
      for (const j of seen) predicted[j]! += w / seen.length;
      return bestBid(s, side, predicted, (i, j) => lotGuess(lotAfter(s, side, i, j), side));
    },
  },
  { name: "random", about: "uniform over 0 to its energy", move: (s, side, r) => int(r, 0, s.energy[side]) },
  { name: "steady3", about: "bids 3 on everything", move: (s, side) => lotClamp(s, side, 3) },
  { name: "fair", about: "the prize's share of the value still open, of its energy", move: (s, side) => lotClamp(s, side, fairBid(s, side)) },
  { name: "outbid", about: "one more than the opponent's last bid", move: (s, side) => lotClamp(s, side, (s.rounds.at(-1)?.bid[other(side)] ?? 3) + 1) },
  {
    name: "rounder",
    about: "LLM-like: the fair bid, more when behind and less when ahead, rounded to 5 once it's 5 or more",
    move: (s, side, r) => {
      const l = lotLead(s, side);
      const n = fairBid(s, side) * (l < 0 ? 1.3 : l > 0 ? 0.8 : 1) * (0.8 + 0.4 * r());
      return lotClamp(s, side, n >= 5 ? Math.round(n / 5) * 5 : n);
    },
  },
  {
    name: "storyteller",
    about: "LLM-like: 1 on the small prizes, its energy split over the big ones still to come, all in on the last prize",
    move: (s, side, r) => {
      const sorted = [...s.rules.prizes].sort((p, q) => p - q), median = sorted[Math.floor(sorted.length / 2)]!;
      if (!s.left.length) return s.energy[side];
      if (s.prize! < median) return lotClamp(s, side, 1);
      const bigLeft = 1 + s.left.filter((p) => p >= median).length;
      return lotClamp(s, side, s.energy[side] / bigLeft + int(r, 0, 2));
    },
  },
  {
    name: "chaser",
    about: "LLM-like: the opponent's average bid per prize point, times this prize, plus a little, with a favourite number (7)",
    move: (s, side, r) => {
      const them = other(side);
      const points = sum(s.rounds.map((x) => x.prize)), bids = sum(s.rounds.map((x) => x.bid[them]));
      const rate = points ? bids / points : s.rules.energy / sum(s.rules.prizes);
      return lotClamp(s, side, r() < 0.25 ? 7 : rate * s.prize! + int(r, 1, 3));
    },
  },
];

/** The Lot's equilibrium, and Reader built on it as the house builds its own (house.ts). */
function exactLotPlayers(sol: LotSolution): LotPlayer[] {
  const draw = (mix: number[], u: number) => {
    const all = sum(mix);
    let acc = 0;
    for (let i = 0; i < mix.length; i++) {
      acc += mix[i]! / all;
      if (u < acc) return i;
    }
    return mix.length - 1;
  };
  return [
    { name: "even", about: "the equilibrium, from the exact solution", move: (s, side, r) => draw(sol.mix(s, side), r()) },
    {
      name: "reader",
      about: "half equilibrium, half the best answer to a model of your bids, playing on optimally",
      move: (s, side, r) => {
        const them = other(side), opp = s.energy[them], eq = sol.mix(s, side);
        const predicted = sol.mix(s, them).slice(0, opp + 1);
        const seen = readLot(s, side);
        if (seen.length) {
          const w = seen.length / (seen.length + 4);
          for (let j = 0; j < predicted.length; j++) predicted[j]! *= 1 - w;
          for (const j of seen) predicted[j]! += w / seen.length;
        }
        const mix = eq.map((p) => p / 2);
        mix[bestBid(s, side, predicted, (i, j) => sol.after(s, side, i, j))]! += 0.5;
        return draw(mix, r());
      },
    },
  ];
}

function lotReport() {
  const lot = (name: string) => LOT_PLAYERS.find((p) => p.name === name)!;
  const pairs: [LotPlayer, LotPlayer][] = [[lot("scout"), lot("scout")], [lot("fair"), lot("fair")], [lot("rounder"), lot("storyteller")], [lot("chaser"), lot("rounder")], [lot("storyteller"), lot("chaser")]];
  console.log("\n## The Lot\n");
  for (const p of LOT_PLAYERS) console.log(`- **${p.name}**: ${p.about}`);
  const game = lotGame(LOT_DRAFT);
  table(`The draft (prizes 1 to 9, ${LOT_DRAFT.energy} energy): everyone against everyone`, game, LOT_PLAYERS, LOT_PLAYERS);
  profile("How matches go, the draft", "Decided early", game, pairs);
  for (const [title, rules] of [
    ["Thirteen prizes, 60 energy", { id: "lot-13-60", prizes: Array.from({ length: 13 }, (_, i) => i + 1), energy: 60 }],
    ["Seven prizes, 20 energy", { id: "lot-7-20", prizes: [1, 2, 3, 4, 5, 6, 7], energy: 20 }],
  ] as [string, LotRules][]) {
    table(`${title}: scout against everyone`, lotGame(rules), [lot("scout")], LOT_PLAYERS);
  }
}

function lotExact() {
  const n = option("prizes", 7), rules: LotRules = { id: `lot-${n}`, prizes: Array.from({ length: n }, (_, i) => i + 1), energy: option("energy", 20) };
  console.log(`\n## The Lot solved exactly: prizes 1 to ${n}, ${rules.energy} energy\n`);
  const sol = solveLot(rules);
  console.log(`${sol.games.toLocaleString("en")} matrix games in ${sol.seconds.toFixed(0)}s. The start is worth ${Math.abs(sol.value(startLot(rules, rules.prizes[0]!), "a")).toFixed(3)} (symmetric).`);
  const exact = exactLotPlayers(sol), game = lotGame(rules);
  for (const p of exact) console.log(`- **${p.name}**: ${p.about}`);
  const all = [...exact, ...LOT_PLAYERS];
  table("Even, Reader and scout against everyone", game, [...exact, LOT_PLAYERS[0]!], all);
  profile("How matches go", "Decided early", game, [[exact[0]!, exact[0]!], [exact[1]!, exact[1]!], [exact[1]!, LOT_PLAYERS[0]!]]);
}

// ================================================================ Three wires

const wiresGame = (rules: WiresRules): Game<WiresState, number[]> => ({
  start: () => startWires(rules),
  play: (s, a, b) => playWires(s, a, b),
  ending: (s) => (s.ending ? { winner: s.ending.winner, early: s.ending.reason === "took_most" } : null),
  rounds: (s) => s.rounds.length,
  firstWinner: (s) => {
    const first = s.rounds[0]!.nodes, a = first.filter((n) => n < 0).length, b = first.filter((n) => n > 0).length;
    return a > b ? "a" : b > a ? "b" : null;
  },
});

type WiresPlayer = Player<WiresState, number[]>;
/** Each node from one side's view: positive is toward that side's own end. */
const towardMe = (s: WiresState, side: Side) => s.nodes.map((n) => (side === "b" ? n : -n));
const openWires = (s: WiresState) => s.nodes.map((n, w) => (taken(s.rules, n) ? -1 : w)).filter((w) => w >= 0);
const wiresWon = (s: WiresState, side: Side) => towardMe(s, side).filter((n) => n >= s.rules.places).length;

/** A legal split near `want`: whole, 0 on taken wires, scaled down to the energy left. */
function split(s: WiresState, side: Side, want: number[]): number[] {
  const out = want.map((p, w) => (taken(s.rules, s.nodes[w]!) ? 0 : Math.max(0, Math.round(p))));
  let over = sum(out) - s.energy[side];
  // Over budget: take from the biggest pull first.
  while (over > 0) {
    const w = out.indexOf(Math.max(...out));
    out[w]!--;
    over--;
  }
  return out;
}

/** A rough value of a state to `side`: wires taken, wires leaning, and the energy edge. */
function wiresGuess(s: WiresState, side: Side): number {
  if (s.ending) return s.ending.winner === side ? 1 : s.ending.winner === null ? 0 : -1;
  const P = s.rules.places;
  const board = sum(towardMe(s, side).map((n) => (n >= P ? 1 : n <= -P ? -1 : (0.5 * n) / P)));
  return Math.tanh(board + (0.5 * (s.energy[side] - s.energy[other(side)])) / s.rules.energy);
}

/** What the opponent might pull now: its last split, its average split, and its last split's shares of its energy. */
function readWires(s: WiresState, side: Side): number[][] {
  const them = other(side), n = s.rounds.length;
  if (!n) return [];
  const theirs = s.rounds.map((r) => r.pull[them]), last = theirs[n - 1]!;
  const average = last.map((_, w) => sum(theirs.map((p) => p[w]!)) / n);
  const spent = sum(last), shares = last.map((p) => (spent ? (p / spent) * Math.min(spent, s.energy[them]) : 0));
  return [last, average, shares].map((want) => split(s, them, want));
}

const WIRES_PLAYERS: WiresPlayer[] = [
  {
    name: "scout",
    about: "Reader without a solver: half the time the best answer to a model of your splits (one more than you on some wires, nothing on the rest), half the time two wires with noise",
    move: (s, side, r) => {
      const open = openWires(s), me = s.energy[side], seen = readWires(s, side);
      if (r() < 0.5 || !seen.length) {
        // Two wires, the ones it's furthest ahead on, a random one dropped when level.
        const order = [...open].sort((p, q) => towardMe(s, side)[q]! - towardMe(s, side)[p]! || r() - 0.5).slice(0, 2);
        const each = (me * (0.3 + 0.2 * r())) / Math.max(1, order.length);
        return split(s, side, s.nodes.map((_, w) => (order.includes(w) ? each + int(r, -1, 1) : 0)));
      }
      let best: number[] = s.nodes.map(() => 0), bestValue = -Infinity;
      const candidates: number[][] = [s.nodes.map(() => 0)];
      for (const y of seen) {
        for (let mask = 1; mask < 1 << open.length; mask++) {
          const x = s.nodes.map(() => 0);
          open.forEach((w, k) => {
            if (mask & (1 << k)) x[w] = y[w]! + 1;
          });
          if (sum(x) <= me) candidates.push(x);
        }
      }
      for (const x of candidates) {
        let v = 0;
        for (const y of seen) v += wiresGuess(side === "a" ? playWires(s, x, y) : playWires(s, y, x), side) / seen.length;
        if (v > bestValue + 1e-9 || (Math.abs(v - bestValue) <= 1e-9 && sum(x) < sum(best))) (bestValue = v), (best = x);
      }
      return best;
    },
  },
  {
    name: "random",
    about: "a uniform total, cut at random across the open wires",
    move: (s, side, r) => {
      const open = openWires(s), out = s.nodes.map(() => 0);
      for (let left = int(r, 0, s.energy[side]); left > 0; left--) out[open[int(r, 0, open.length - 1)]!]!++;
      return out;
    },
  },
  { name: "steady2", about: "2 on every open wire", move: (s, side) => split(s, side, s.nodes.map(() => 2)) },
  {
    name: "two",
    about: "two wires only (the ones it's furthest ahead on), 40% of its energy between them",
    move: (s, side) => {
      const order = openWires(s).sort((p, q) => towardMe(s, side)[q]! - towardMe(s, side)[p]!).slice(0, 2 - wiresWon(s, side));
      return split(s, side, s.nodes.map((_, w) => (order.includes(w) ? (0.4 * s.energy[side]) / order.length : 0)));
    },
  },
  {
    name: "outbid",
    about: "one more than the opponent's last pull on every wire",
    move: (s, side) => split(s, side, s.nodes.map((_, w) => (s.rounds.at(-1)?.pull[other(side)][w] ?? 2) + 1)),
  },
  {
    name: "rounder",
    about: "LLM-like: a third of its energy split evenly over the open wires, half when behind, a fifth when ahead",
    move: (s, side, r) => {
      const lead = sum(towardMe(s, side).map(Math.sign)), open = openWires(s).length;
      const share = lead < 0 ? 0.5 : lead > 0 ? 0.2 : 1 / 3;
      return split(s, side, s.nodes.map(() => (s.energy[side] * share * (0.8 + 0.4 * r())) / open));
    },
  },
  {
    name: "storyteller",
    about: "LLM-like: opens strong on two wires, defends any wire a step from lost, little where ahead, all in on the last two rounds",
    move: (s, side, r) => {
      const round = s.rounds.length, pos = towardMe(s, side), P = s.rules.places, me = s.energy[side];
      if (round === 0) return split(s, side, [5 + int(r, 0, 2), 5 + int(r, 0, 2), 0]);
      const open = openWires(s);
      if (round >= s.rules.rounds - 2) {
        const fight = open.filter((w) => pos[w]! <= 0);
        const on = fight.length ? fight : open;
        return split(s, side, s.nodes.map((_, w) => (on.includes(w) ? me / on.length : 0)));
      }
      return split(s, side, pos.map((n: number) => (n === -(P - 1) ? me / 3 : n > 0 ? 1 : 3 + int(r, 0, 2))));
    },
  },
  {
    name: "chaser",
    about: "LLM-like: the opponent's average pull plus a little, on the two wires it pulls least, nothing on the other",
    move: (s, side, r) => {
      const them = other(side), n = s.rounds.length;
      if (!n) return split(s, side, s.nodes.map(() => 4));
      const average = s.nodes.map((_, w) => sum(s.rounds.map((x) => x.pull[them][w]!)) / n);
      const cheap = openWires(s).sort((p, q) => average[p]! - average[q]!).slice(0, 2);
      return split(s, side, s.nodes.map((_, w) => (cheap.includes(w) ? average[w]! + int(r, 1, 2) : 0)));
    },
  },
];

function wiresReport() {
  const wires = (name: string) => WIRES_PLAYERS.find((p) => p.name === name)!;
  const pairs: [WiresPlayer, WiresPlayer][] = [[wires("scout"), wires("scout")], [wires("two"), wires("two")], [wires("rounder"), wires("storyteller")], [wires("chaser"), wires("rounder")], [wires("storyteller"), wires("chaser")]];
  console.log("\n## Three wires\n");
  for (const p of WIRES_PLAYERS) console.log(`- **${p.name}**: ${p.about}`);
  const d = WIRES_DRAFT;
  table(`The draft (${d.wires} wires of ±${d.places}, ${d.energy} energy, +${d.regen} a round, ${d.rounds} rounds): everyone against everyone`, wiresGame(d), WIRES_PLAYERS, WIRES_PLAYERS);
  profile("How matches go, the draft", "Two wires taken", wiresGame(d), pairs);
  for (const [title, rules] of [
    ["Wires of ±3, 14 rounds", { ...d, id: "wires-p3", places: 3, rounds: 14 }],
    ["+2 a round instead of +3", { ...d, id: "wires-regen2", regen: 2 }],
  ] as [string, WiresRules][]) {
    table(`${title}: scout against everyone`, wiresGame(rules), [wires("scout")], WIRES_PLAYERS);
    profile(`How matches go, ${title.toLowerCase()}`, "Two wires taken", wiresGame(rules), pairs.slice(0, 3));
  }
}

// ================================================================ what an exact solution costs

function cost() {
  console.log("\n## What an exact solution costs\n");
  console.log("### The Lot: every set of prizes left, pair of energies and lead\n");
  console.log("| Prizes | Energy | Matrix games | Solved in |");
  console.log("|---|---|---|---|");
  let perGame = 0;
  for (const [n, e] of [[5, 12], [6, 16], [7, 20], [8, 24]] as const) {
    const sol = solveLot({ id: "cost", prizes: Array.from({ length: n }, (_, i) => i + 1), energy: e });
    perGame = sol.seconds / sol.games;
    console.log(`| 1 to ${n} | ${e} | ${sol.games.toLocaleString("en")} | ${sol.seconds.toFixed(1)}s |`);
  }
  for (const [n, e] of [[9, 30], [11, 45], [13, 60]] as const) {
    const games = lotGames({ id: "cost", prizes: Array.from({ length: n }, (_, i) => i + 1), energy: e });
    // Bigger energies mean bigger matrices; the time per game grew about 1.4 times a step above.
    console.log(`| 1 to ${n} | ${e} | ${games.toLocaleString("en")} | not run: at least ${((games * perGame) / 60).toFixed(0)} minutes at the last row's rate |`);
  }
  console.log("\n### Three wires: one round's matrix game alone (a single round, nothing after it)\n");
  console.log("| Energy | Splits a side | Cells in the matrix | Solved in |");
  console.log("|---|---|---|---|");
  let perCell = 0;
  for (const e of [6, 9, 12, 15]) {
    const sol = solveWires({ id: "cost", wires: 3, places: 2, energy: e, regen: 0, rounds: 1 });
    perCell = sol.seconds / sol.biggest;
    console.log(`| ${e} | ${splits(e, 3).toLocaleString("en")} | ${sol.biggest.toLocaleString("en")} | ${sol.seconds.toFixed(1)}s |`);
  }
  const d = WIRES_DRAFT, full = splits(d.energy, 3);
  console.log(`| ${d.energy} (the draft) | ${full.toLocaleString("en")} | ${(full * full).toLocaleString("en")} | not run |`);
  // Every state of the draft: each round, each way the nodes can stand short of an ending (wires are interchangeable),
  // each pair of energies. An upper bound, since not every energy is reachable in every round.
  let cells = 0, stands = 0;
  for (let x = -d.places; x <= d.places; x++) {
    for (let y = x; y <= d.places; y++) {
      for (let z = y; z <= d.places; z++) {
        const nodes = [x, y, z];
        if (nodes.filter((n) => n <= -d.places).length >= 2 || nodes.filter((n) => n >= d.places).length >= 2) continue;
        const open = nodes.filter((n) => !taken(d, n)).length;
        let moves = 0;
        for (let e = 0; e <= d.energy; e++) moves += splits(e, open);
        cells += d.rounds * moves * moves;
        stands++;
      }
    }
  }
  console.log(`\nThe whole draft: ${d.rounds} rounds, ${stands} ways the nodes can stand and ${(d.energy + 1) ** 2} pairs of energies, at most ${cells.toExponential(1)} matrix cells in all. At the last row's time per cell, and solving rarely stays that cheap as a matrix grows, that's ${Math.round((cells * perCell) / 86_400)} days on one thread.`);
  console.log("\n### Three wires: whole small games\n");
  console.log("| Energy | Rounds | Matrix games | Biggest matrix | Solved in |");
  console.log("|---|---|---|---|---|");
  for (const [e, rounds] of [[4, 4], [6, 4], [6, 5], [8, 4]] as const) {
    const sol = solveWires({ id: "cost", wires: 3, places: 2, energy: e, regen: 1, rounds });
    console.log(`| ${e} | ${rounds} | ${sol.games.toLocaleString("en")} | ${sol.biggest.toLocaleString("en")} cells | ${sol.seconds.toFixed(1)}s |`);
  }
}

/** One match, round by round: --game lot|wires --watch <a>,<b> [--seed n]. */
function watch(names: string) {
  const [x, y] = names.split(",");
  const chance = mulberry(option("seed", 1) * 3 + 2), ra = mulberry(option("seed", 1) * 3), rb = mulberry(option("seed", 1) * 3 + 1);
  if (ONLY === "wires") {
    const a = WIRES_PLAYERS.find((p) => p.name === x)!, b = WIRES_PLAYERS.find((p) => p.name === y)!;
    let s = startWires(WIRES_DRAFT);
    while (!s.ending) {
      const energy = `${s.energy.a}/${s.energy.b}`;
      s = playWires(s, a.move(s, "a", ra), b.move(s, "b", rb));
      const r = s.rounds.at(-1)!;
      console.log(`${s.rounds.length}. energy ${energy}: ${x} ${r.pull.a.join(" ")}, ${y} ${r.pull.b.join(" ")} -> nodes ${r.nodes.join(" ")}`);
    }
    console.log(`${s.ending.winner === "a" ? x : s.ending.winner === "b" ? y : "nobody"} (${s.ending.reason})`);
  } else {
    const a = LOT_PLAYERS.find((p) => p.name === x)!, b = LOT_PLAYERS.find((p) => p.name === y)!;
    let s = startLot(LOT_DRAFT, drawPrize(LOT_DRAFT.prizes, chance()));
    while (!s.ending) {
      const energy = `${s.energy.a}/${s.energy.b}`;
      s = playLot(s, a.move(s, "a", ra), b.move(s, "b", rb), s.left.length ? drawPrize(s.left, chance()) : undefined);
      const r = s.rounds.at(-1)!;
      console.log(`${s.rounds.length}. prize ${r.prize}, energy ${energy}: ${x} ${r.bid.a}, ${y} ${r.bid.b} -> ${s.score.a} to ${s.score.b}`);
    }
    console.log(`${s.ending.winner === "a" ? x : s.ending.winner === "b" ? y : "nobody"} (${s.ending.reason})`);
  }
}

const started = Date.now();
if (args.includes("--watch")) {
  watch(args[args.indexOf("--watch") + 1]!);
  process.exit(0);
}
console.log(`# Prototype games: ${MATCHES} matches a pairing, half from each side\n`);
console.log("Cells are the row player's score (wins minus losses, over matches: +1 always wins, -1 always loses) and its draws.");
if (flag("cost")) cost();
else if (flag("exact")) lotExact();
else {
  if (!ONLY || ONLY === "lot") lotReport();
  if (!ONLY || ONLY === "wires") wiresReport();
}
console.log(`\n_${((Date.now() - started) / 1000).toFixed(0)}s_`);
