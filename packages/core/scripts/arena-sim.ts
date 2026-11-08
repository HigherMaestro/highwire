// npm run arena:sim: the arena's rules played out (docs/arena.md 4 and 12). The house's two bots against simple and
// language-model-like players, every pairing from both sides, under each tie-break and regain. Local only: it touches
// no network. Usage: npm run arena:sim [-- --matches 1000 --quick]

import { DUELS_1, houseMove, other, playRound, solve, startMatch, type ArenaRules, type MatchState, type Side } from "../src/arena/index.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const MATCHES = option("matches", flag("quick") ? 200 : 1_000);

/** A fast seeded generator for the players (the house uses its own seed, as the referee will). */
function mulberry(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

type Rand = () => number;
type Player = { name: string; about: string; pull: (s: MatchState, side: Side, rand: Rand, seed: string) => number };

const clamp = (s: MatchState, side: Side, n: number) => Math.max(0, Math.min(s.energy[side], Math.round(n)));
const lead = (s: MatchState, side: Side) => (side === "b" ? s.node : -s.node);
const lastOf = (s: MatchState, side: Side) => s.rounds.at(-1)?.pull[side];

const PLAYERS: Player[] = [
  { name: "even", about: "the house: the equilibrium", pull: (s, side, _r, seed) => houseMove("even", s, side, seed) },
  { name: "reader", about: "the house: half equilibrium, half best answer to a model of you", pull: (s, side, _r, seed) => houseMove("reader", s, side, seed) },
  { name: "random", about: "uniform over 0 to its energy", pull: (s, side, r) => Math.floor(r() * (s.energy[side] + 1)) },
  { name: "steady2", about: "pulls 2 every round (free at the cap)", pull: (s, side) => clamp(s, side, 2) },
  { name: "steady6", about: "pulls 6 every round", pull: (s, side) => clamp(s, side, 6) },
  {
    name: "outbid",
    about: "one more than the opponent's last pull",
    pull: (s, side) => clamp(s, side, (lastOf(s, other(side)) ?? 5) + 1),
  },
  {
    name: "rounder",
    about: "LLM-like: a third of its energy, rounded to 5, more when behind, less when ahead",
    pull: (s, side, r) => {
      const l = lead(s, side);
      const share = l < 0 ? 0.5 : l > 0 ? 0.2 : 1 / 3;
      const n = s.energy[side] * share * (0.8 + 0.4 * r());
      return clamp(s, side, Math.max(5, Math.round(n / 5) * 5));
    },
  },
  {
    name: "storyteller",
    about: "LLM-like: opens strong (10 to 12), saves when ahead, all in on the last two rounds or one step from losing",
    pull: (s, side, r) => {
      const round = s.rounds.length, l = lead(s, side);
      if (round === 0) return 10 + Math.floor(r() * 3);
      if (round >= s.rules.rounds - 2 || l === -(s.rules.places - 1)) return s.energy[side];
      if (l > 0) return clamp(s, side, 2 + Math.floor(r() * 3));
      return clamp(s, side, 6 + Math.floor(r() * 6));
    },
  },
  {
    name: "chaser",
    about: "LLM-like: the opponent's average pull plus a little, with a favourite number (7)",
    pull: (s, side, r) => {
      const them = s.rounds.map((x) => x.pull[other(side)]);
      const avg = them.length ? them.reduce((a, b) => a + b, 0) / them.length : 7;
      return clamp(s, side, r() < 0.25 ? 7 : avg + 1 + Math.floor(r() * 3));
    },
  },
];

type Tally = { win: number; draw: number; loss: number; rounds: number; ended: number; tieBreaks: number };

/** `n` matches, `x` as a and `y` as b in the even ones and the other way round in the odd ones, from x's view. */
function series(rules: ArenaRules, x: Player, y: Player, n: number, salt: number): Tally {
  const t: Tally = { win: 0, draw: 0, loss: 0, rounds: 0, ended: 0, tieBreaks: 0 };
  for (let i = 0; i < n; i++) {
    const xSide: Side = i % 2 === 0 ? "a" : "b";
    const rx = mulberry(salt * 1_000_003 + i * 2), ry = mulberry(salt * 1_000_003 + i * 2 + 1);
    const sx = `x${salt}-${i}`, sy = `y${salt}-${i}`;
    let s = startMatch(rules);
    while (!s.ending) {
      const px = x.pull(s, xSide, rx, sx), py = y.pull(s, other(xSide), ry, sy);
      s = xSide === "a" ? playRound(s, px, py) : playRound(s, py, px);
    }
    const e = s.ending!;
    if (e.winner === xSide) t.win++;
    else if (e.winner === null) t.draw++;
    else t.loss++;
    t.rounds += s.rounds.length;
    if (e.reason === "reached_end") t.ended++;
    if (e.reason === "tie_break") t.tieBreaks++;
  }
  return t;
}

const pct = (k: number, n: number) => `${((100 * k) / n).toFixed(0)}%`;
const score = (t: Tally, n: number) => ((t.win - t.loss) / n).toFixed(2);

function table(title: string, rules: ArenaRules, rows: Player[], cols: Player[]) {
  solve(rules); // warm the cache so the first pairing isn't slower
  console.log(`\n## ${title}\n`);
  console.log(`| | ${cols.map((c) => c.name).join(" | ")} |`);
  console.log(`|---|${cols.map(() => "---").join("|")}|`);
  let salt = 1;
  for (const x of rows) {
    const cells = cols.map((y) => {
      const t = series(rules, x, y, MATCHES, salt++);
      return `${score(t, MATCHES)} (${pct(t.draw, MATCHES)} d)`;
    });
    console.log(`| **${x.name}** | ${cells.join(" | ")} |`);
  }
}

function profile(title: string, rules: ArenaRules, pairs: [Player, Player][]) {
  console.log(`\n## ${title}\n`);
  console.log("| Pairing | First wins | Draws | Second wins | Rounds | Reached an end | Decided by the tie-break |");
  console.log("|---|---|---|---|---|---|---|");
  let salt = 500;
  for (const [x, y] of pairs) {
    const t = series(rules, x, y, MATCHES, salt++);
    console.log(`| ${x.name} v ${y.name} | ${pct(t.win, MATCHES)} | ${pct(t.draw, MATCHES)} | ${pct(t.loss, MATCHES)} | ${(t.rounds / MATCHES).toFixed(1)} | ${pct(t.ended, MATCHES)} | ${pct(t.tieBreaks, MATCHES)} |`);
  }
}

const by = (name: string) => PLAYERS.find((p) => p.name === name)!;
const house = [by("even"), by("reader")];
const SPENT: ArenaRules = { ...DUELS_1, id: "duels-1-spent", tieBreak: "spent" };
const REGEN3: ArenaRules = { ...DUELS_1, id: "duels-1-regen3", regen: 3 };

const started = Date.now();
console.log(`# Arena simulator: ${MATCHES} matches a pairing, half from each side\n`);
console.log("Cells are the row player's score (wins minus losses, over matches: +1 always wins, -1 always loses) and its draws.\n");
for (const p of PLAYERS) console.log(`- **${p.name}**: ${p.about}`);

table("duels-1 (no tie-break): the house against everyone", DUELS_1, house, PLAYERS);
table("duels-1 with the 'spent' tie-break", SPENT, house, PLAYERS);
table("+3 regain instead of +2", REGEN3, house, PLAYERS);

const pairs: [Player, Player][] = [
  [by("even"), by("even")],
  [by("reader"), by("reader")],
  [by("steady2"), by("steady2")],
  [by("rounder"), by("storyteller")],
  [by("chaser"), by("rounder")],
  [by("storyteller"), by("chaser")],
];
profile("How matches go, duels-1", DUELS_1, pairs);
profile("How matches go, with the 'spent' tie-break", SPENT, pairs);
profile("How matches go, +3 regain", REGEN3, pairs);
console.log(`\n_${((Date.now() - started) / 1000).toFixed(0)}s_`);
