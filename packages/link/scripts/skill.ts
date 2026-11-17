import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { type Action, ADDR, Battle, BattleError, checkGame, DICE_LENGTH, expected, fallbackAction, type GameData, gameData, houseChoice, type Legal, party, Rig, type Side, type SideFacts, snapshot } from "highwire-link";

// How much a better player wins a link battle (docs/link-wager.md 7): scripted players of graded strength play each
// other on the format's team with fresh dice every turn, sides swapped every battle, and the share each wins says what
// one battle decides and what a best-of-three would. Needs the game, never in CI:
//   HIGHWIRE_LINK_ROM=<the game> npm run skill -w highwire-link -- <side 0 state> <side 1 state> [battles a pairing] [workers] [pairings] [out.json]
// Pairings are `a:b,c:d` of the players below; the default is the list in PAIRINGS.
//
// The players, weakest first. Each decides from its own side's facts, as an agent would:
//   random      any legal action, switches included
//   strongest   its most powerful move, never switching (a policy's `strongest` fallback)
//   house<N>    the house N times in 100, a random legal action otherwise: a sound player that slips
//   house       Highwire's house fighter (house.ts)
//   sharp       the house, knowing one more thing about the game: Slash and Razor Leaf nearly always land critical hits

type Player = (legal: Legal, facts: SideFacts, data: GameData, pick: (n: number) => number, side: Side, turn: number) => Action;

const TURN_CAP = 200;
/** Moves the game gives a critical hit almost every time (Karate Chop, Razor Leaf, Crabhammer, Slash), and what one is worth at this level. */
const HIGH_CRIT = new Set([2, 75, 152, 163]);
const CRIT = 1.9;
const SLEEP = 0b111;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return (n: number) => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) % n;
  };
}

const options = (legal: Legal): Action[] =>
  legal.kind === "forced"
    ? legal.switches.map((to) => ({ kind: "switch", to }))
    : [...(legal.fight ? [{ kind: "fight" } as const] : []), ...legal.moves.map((slot) => ({ kind: "move", slot }) as const), ...legal.switches.map((to) => ({ kind: "switch", to }) as const)];

const random: Player = (legal, _f, _d, pick) => {
  const all = options(legal);
  return all[pick(all.length)]!;
};

/** The house's choice (house.ts, the same shape), with every move valued by `value`. */
function choiceBy(value: (move: number, own: [number, number], defend: [number, number], o: { level: number; targetStatus: number; targetSeeded: boolean }) => number): Player {
  return (legal, facts) => {
    const defend = facts.theirs.types;
    const target = { targetStatus: facts.theirs.status, targetSeeded: facts.theirs.field.seeded };
    const best = (moves: number[], pp: number[], own: [number, number], level: number) => Math.max(0, ...moves.map((id, slot) => (id && (pp[slot] ?? 0) > 0 ? value(id, own, defend, { ...target, level }) : 0)));
    const fit = legal.switches.filter((to) => (facts.team[to]!.status & (SLEEP | (1 << 5))) === 0);
    const reserve = (to: number) => {
      const m = facts.team[to]!;
      return best(m.moves, m.pp, m.types, m.level);
    };
    const bestSwitch = (from: number[]) => [...from].sort((a, b) => reserve(b) - reserve(a))[0];
    if (legal.kind === "forced") return { kind: "switch", to: bestSwitch(fit.length ? fit : legal.switches)! };
    const own = facts.mine.types;
    const activeBest = best(facts.mineMoves, facts.mineMovePP, own, facts.mine.level);
    const to = bestSwitch(fit);
    if (to !== undefined && activeBest < 40 && reserve(to) > 2 * Math.max(activeBest, 20)) return { kind: "switch", to };
    if (legal.fight) return { kind: "fight" };
    const scored = legal.moves.map((slot) => ({ slot, value: value(facts.mineMoves[slot] ?? 0, own, defend, { ...target, level: facts.mine.level }) })).sort((a, b) => b.value - a.value);
    if (scored[0]) return { kind: "move", slot: scored[0].slot };
    return { kind: "switch", to: (to ?? legal.switches[0])! };
  };
}

function player(name: string): Player {
  if (name === "random") return random;
  if (name === "strongest") return (legal, facts, data, _p, side, turn) => fallbackAction(legal, facts, data, "strongest", "", turn, side);
  if (name === "house") return (legal, facts, data) => houseChoice(legal, facts, data);
  if (name === "sharp") {
    let made: Player | null = null;
    return (legal, facts, data, pick, side, turn) => (made ??= choiceBy((move, own, defend, o) => expected(data, move, own, defend, o) * (HIGH_CRIT.has(move) ? CRIT : 1)))(legal, facts, data, pick, side, turn);
  }
  const mixed = /^house(\d{1,2})$/.exec(name);
  if (mixed) {
    const n = Number(mixed[1]);
    return (legal, facts, data, pick, side, turn) => (pick(100) < n ? houseChoice(legal, facts, data) : random(legal, facts, data, pick, side, turn));
  }
  throw new Error(`No player called ${name}.`);
}

const factsOf = (rig: Rig, side: Side): SideFacts => {
  const s = snapshot(rig, side);
  return { team: party(rig, side), out: rig.read(side, ADDR.playerMonNumber), mine: s.mine, theirs: s.theirs, mineMoves: s.myMoves, mineMovePP: s.myPP };
};

type Result = { pairing: string; seed: number; aSide: Side; winner: "a" | "b" | "draw" | "cap" | "error"; turns: number; error?: string };

/** One battle: player `a` on `aSide`. The dice and each player's own choices come from separate streams of the seed. */
async function battle(rom: Uint8Array, states: [Uint8Array, Uint8Array], data: GameData, pairing: string, seed: number, aSide: Side): Promise<Result> {
  const [a, b] = pairing.split(":") as [string, string];
  const players = aSide === 0 ? [player(a), player(b)] : [player(b), player(a)];
  const picks = [rng(seed ^ 0x9e3779b9), rng(seed ^ 0x7f4a7c15)];
  const roll = rng(seed);
  const rig = await Rig.create(rom);
  rig.loadState(0, states[0]);
  rig.loadState(1, states[1]);
  const game = new Battle(rig);
  try {
    let outcome = game.runToDecision();
    while (!outcome && game.turn < TURN_CAP) {
      const decisions = ([0, 1] as const).map((side: Side) => {
        const legal = game.legal(side);
        return legal ? players[side]!(legal, factsOf(rig, side), data, picks[side]!, side, game.turn) : null;
      }) as [Action | null, Action | null];
      outcome = game.play(decisions, Uint8Array.from({ length: DICE_LENGTH }, () => roll(256))).outcome;
    }
    const winner = !outcome ? "cap" : outcome.winner === null ? "draw" : outcome.winner === aSide ? "a" : "b";
    return { pairing, seed, aSide, winner, turns: game.turn };
  } catch (error) {
    return { pairing, seed, aSide, winner: "error", turns: game.turn, error: `${error instanceof BattleError ? error.kind : "crash"}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

type Job = { rom: Uint8Array; states: [Uint8Array, Uint8Array]; battles: { pairing: string; seed: number; aSide: Side }[] };

const PAIRINGS = ["house:house", "sharp:house", "house:house75", "house:house50", "house:strongest", "house:random"];

/** Wilson's 95% interval for `k` of `n`. */
function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / d, half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [mid - half, mid + half];
}
/** The chance of taking a first-to-`need` series when each battle is won with chance `p`. */
function series(p: number, need: number): number {
  let total = 0;
  for (let lost = 0; lost < need; lost++) {
    let ways = 1;
    for (let i = 0; i < lost; i++) ways = (ways * (need - 1 + lost - i)) / (i + 1);
    total += ways * p ** need * (1 - p) ** lost;
  }
  return total;
}
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

if (!isMainThread) {
  const job = workerData as Job;
  const data = gameData(job.rom);
  for (const b of job.battles) parentPort!.postMessage(await battle(job.rom, job.states, data, b.pairing, b.seed, b.aSide));
} else {
  const romPath = process.env.HIGHWIRE_LINK_ROM;
  if (!romPath || !existsSync(romPath)) {
    console.error("Set HIGHWIRE_LINK_ROM to the game's file.");
    process.exit(2);
  }
  const rom = new Uint8Array(readFileSync(romPath));
  checkGame(rom);
  const [path0, path1, count = "20", workerCount, pairingArg, out] = process.argv.slice(2);
  const states: [Uint8Array, Uint8Array] = [new Uint8Array(readFileSync(path0!)), new Uint8Array(readFileSync(path1!))];
  const pairings = pairingArg && pairingArg !== "-" ? pairingArg.split(",") : PAIRINGS;
  for (const p of pairings) p.split(":").forEach(player);
  // Battle i of a pairing takes seed BASE + i, and player a takes side i % 2: the same list every run.
  const BASE = Number(process.env.SEED ?? 20261116);
  const battles = pairings.flatMap((pairing, k) => Array.from({ length: Number(count) }, (_, i) => ({ pairing, seed: (BASE + k * 1_000_003 + i * 7919) >>> 0, aSide: (i % 2) as Side })));
  const workers = Math.max(1, Math.min(Number(workerCount && workerCount !== "-" ? workerCount : availableParallelism() - 2), battles.length));
  const results: Result[] = [];
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: workers }, (_, w) => {
      const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { rom, states, battles: battles.filter((_, i) => i % workers === w) } satisfies Job, execArgv: process.execArgv });
      worker.on("message", (r: Result) => {
        results.push(r);
        if (results.length % 50 === 0) console.log(`${results.length}/${battles.length} battles, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
      });
      return new Promise<void>((resolve, reject) => {
        worker.on("exit", () => resolve());
        worker.on("error", reject);
      });
    }),
  );
  console.log(`\n${results.length} battles in ${((performance.now() - t0) / 60000).toFixed(1)} minutes, ${workers} workers\n`);
  console.log("pairing (a:b)       battles  a won  b won  draw  a's share (95%)        best of 3  best of 5  a on side 0 / 1   turns");
  const table = pairings.map((pairing) => {
    const rs = results.filter((r) => r.pairing === pairing);
    const won = (who: string, rsub = rs) => rsub.filter((r) => r.winner === who).length;
    const a = won("a"), b = won("b"), decided = a + b;
    const p = decided ? a / decided : 0.5;
    const [lo, hi] = wilson(a, decided);
    const bySide = ([0, 1] as const).map((s) => {
      const sub = rs.filter((r) => r.aSide === s);
      const d = won("a", sub) + won("b", sub);
      return d ? won("a", sub) / d : 0;
    });
    const turns = rs.reduce((n, r) => n + r.turns, 0) / Math.max(1, rs.length);
    const row = { pairing, battles: rs.length, a, b, draw: won("draw"), cap: won("cap"), error: won("error"), share: p, low: lo, high: hi, bestOf3: series(p, 2), bestOf5: series(p, 3), bySide, turns };
    console.log(
      `${pairing.padEnd(20)}${String(rs.length).padStart(7)}${String(a).padStart(7)}${String(b).padStart(7)}${String(row.draw).padStart(6)}  ${`${pct(p)} (${pct(lo)} to ${pct(hi)})`.padEnd(23)}${pct(row.bestOf3).padStart(9)}${pct(row.bestOf5).padStart(11)}  ${`${pct(bySide[0]!)} / ${pct(bySide[1]!)}`.padEnd(17)}${turns.toFixed(1).padStart(6)}${row.cap || row.error ? `  (${row.cap} at the cap, ${row.error} errors)` : ""}`,
    );
    return row;
  });
  for (const r of results.filter((r) => r.error).slice(0, 10)) console.log(`${r.pairing} seed ${r.seed}: ${r.error}`);
  if (out) writeFileSync(out, JSON.stringify({ base: BASE, table, results }, null, 1));
}
