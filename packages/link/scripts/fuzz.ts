import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { type Action, Battle, BattleError, checkGame, DICE_LENGTH, type Legal, Rig, type Side } from "highwire-link";

// Phase 1's fuzzer (docs/link-battles.md 14): plays whole link battles from a paired battle state, every decision a
// uniformly random legal one and fresh dice every turn, and counts how they end: a knockout or draw both games agree
// on, or a stuck rig, a desync, an illegal action or RUN, each with the moves involved. Needs the game, never in CI:
//   HIGHWIRE_LINK_ROM=<the game> npm run fuzz -w highwire-link -- <side 0 state> <side 1 state> [battles] [workers]
// One battle with every turn printed: add --verbose.

type Result = {
  seed: number;
  outcome: string;
  turns: number;
  frames: number;
  ms: number;
  error?: { kind: string; message: string; moves: number[] };
};

const TURN_CAP = 200;

/** A small seeded generator, so a failing battle's choices can be played again from its seed. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return (n: number) => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) % n;
  };
}

function choose(legal: Legal, pick: (n: number) => number): Action {
  const options: Action[] =
    legal.kind === "forced"
      ? legal.switches.map((to) => ({ kind: "switch", to }))
      : [
          ...(legal.fight ? [{ kind: "fight" } as const] : []),
          ...legal.moves.map((slot) => ({ kind: "move", slot }) as const),
          ...legal.switches.map((to) => ({ kind: "switch", to }) as const),
        ];
  return options[pick(options.length)]!;
}

async function battle(rom: Uint8Array, states: [Uint8Array, Uint8Array], seed: number, verbose: boolean): Promise<Result> {
  const rig = await Rig.create(rom);
  rig.loadState(0, states[0]);
  rig.loadState(1, states[1]);
  const pick = rng(seed);
  const game = new Battle(rig);
  const t0 = performance.now();
  const moves = new Set<number>();
  try {
    let outcome = game.runToDecision();
    while (!outcome && game.turn < TURN_CAP) {
      const decisions = ([0, 1] as const).map((side: Side) => {
        const legal = game.legal(side);
        return legal ? choose(legal, pick) : null;
      }) as [Action | null, Action | null];
      const dice = Uint8Array.from({ length: DICE_LENGTH }, () => pick(256));
      const turn = game.play(decisions, dice);
      outcome = turn.outcome;
      for (const e of turn.record.events) if (e.kind !== "acts") moves.add(e.move);
      if (verbose) {
        const [a, b] = turn.record.after;
        console.log(
          `turn ${turn.record.turn} (${turn.record.frames} frames): ${JSON.stringify(decisions)}\n` +
            `  ${turn.record.events.map((e) => (e.kind === "acts" ? `${e.side} acts` : e.kind === "used" ? `${e.side} uses ${e.move}` : `${e.side} ${e.missed ? "misses" : `hits ${e.damage}`}${e.critical ? " critical" : ""} x${e.effectiveness / 10}`)).join(", ")}\n` +
            `  side 0 ${a.mine.species} ${a.mine.hp}/${a.mine.maxHp} | side 1 ${b.mine.species} ${b.mine.hp}/${b.mine.maxHp} | phases ${game.phase(0)} ${game.phase(1)} | dice # ${turn.record.before[0].diceIndex}/${turn.record.before[1].diceIndex} -> ${a.diceIndex}/${b.diceIndex}`,
        );
      }
    }
    return {
      seed,
      outcome: outcome ? (outcome.winner === null ? "draw" : `side ${outcome.winner} won`) : "cap",
      turns: game.turn,
      frames: rig.frameCount,
      ms: performance.now() - t0,
    };
  } catch (error) {
    const kind = error instanceof BattleError ? error.kind : "crash";
    const message = error instanceof Error ? error.message : String(error);
    if (verbose) console.log(`ERROR ${kind}: ${message}`);
    return { seed, outcome: kind, turns: game.turn, frames: rig.frameCount, ms: performance.now() - t0, error: { kind, message, moves: [...moves] } };
  }
}

type Job = { rom: Uint8Array; states: [Uint8Array, Uint8Array]; seeds: number[] };

if (!isMainThread) {
  const job = workerData as Job;
  for (const seed of job.seeds) parentPort!.postMessage(await battle(job.rom, job.states, seed, false));
} else {
  const romPath = process.env.HIGHWIRE_LINK_ROM;
  if (!romPath || !existsSync(romPath)) {
    console.error("Set HIGHWIRE_LINK_ROM to the game's file.");
    process.exit(2);
  }
  const rom = new Uint8Array(readFileSync(romPath));
  checkGame(rom);
  const verbose = process.argv.includes("--verbose");
  const [path0, path1, count = "1", workerCount] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const states: [Uint8Array, Uint8Array] = [new Uint8Array(readFileSync(path0!)), new Uint8Array(readFileSync(path1!))];
  const seeds = process.env.SEED ? [Number(process.env.SEED)] : Array.from({ length: Number(count) }, () => randomBytes(4).readUInt32LE());
  const results: Result[] = [];
  if (verbose || seeds.length === 1) {
    for (const seed of seeds) results.push(await battle(rom, states, seed, true));
  } else {
    const workers = Math.min(Number(workerCount ?? availableParallelism() - 2), seeds.length);
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: workers }, (_, w) => {
        const mine = seeds.filter((_, i) => i % workers === w);
        const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { rom, states, seeds: mine } satisfies Job, execArgv: process.execArgv });
        worker.on("message", (r: Result) => {
          results.push(r);
          if (results.length % 25 === 0) console.log(`${results.length}/${seeds.length} battles, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
        });
        return new Promise<void>((resolve, reject) => {
          worker.on("exit", () => resolve());
          worker.on("error", reject);
        });
      }),
    );
  }
  const by = new Map<string, number>();
  for (const r of results) by.set(r.outcome, (by.get(r.outcome) ?? 0) + 1);
  const turns = results.map((r) => r.turns);
  const perTurn = results.filter((r) => r.turns > 0).map((r) => r.ms / r.turns);
  console.log(`\n${results.length} battles: ${[...by].map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`turns: ${Math.min(...turns)} to ${Math.max(...turns)}, mean ${(turns.reduce((a, b) => a + b, 0) / turns.length).toFixed(1)}`);
  if (perTurn.length) console.log(`ms a turn: mean ${(perTurn.reduce((a, b) => a + b, 0) / perTurn.length).toFixed(0)}`);
  for (const r of results.filter((r) => r.error).slice(0, 20)) console.log(`seed ${r.seed}: ${r.error!.kind}: ${r.error!.message} (moves ${r.error!.moves.join(",")})`);
}
