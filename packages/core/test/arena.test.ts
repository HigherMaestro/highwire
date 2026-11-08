import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkTableTalk,
  conservative,
  rate,
  START,
  chargeClock,
  DUELS_1,
  fallbackPull,
  forfeit,
  houseMove,
  parseFallback,
  playRound,
  pullProblem,
  readOpponent,
  replay,
  seedCommitment,
  seededUnit,
  solve,
  solveMatrix,
  startMatch,
  voidMatch,
  type MatchState,
  type Side,
} from "../src/arena/index.ts";

// The arena's game (docs/arena.md 4). Rules first, then the exact solution, then the house.

test("a round: the bigger pull moves the node its way, a tie leaves it, and both pay", () => {
  let s = startMatch();
  s = playRound(s, 5, 3);
  assert.equal(s.node, -1, "a pulls toward the negative end");
  assert.deepEqual(s.energy, { a: 27, b: 29 }, "both pay, then regain 2");
  assert.deepEqual(s.rounds[0], { pull: { a: 5, b: 3 }, winner: "a", node: -1 });
  s = playRound(s, 4, 4);
  assert.equal(s.node, -1, "a tie leaves the node");
  assert.equal(s.rounds[1]!.winner, null);
  assert.deepEqual(s.energy, { a: 25, b: 27 });
  assert.deepEqual(s.spent, { a: 9, b: 7 });
});

test("energy comes back 2 a round up to the cap, so pulls of 0 to 2 are free at full energy", () => {
  let s = startMatch();
  for (const [a, b] of [[2, 2], [1, 1], [0, 0], [2, 2], [1, 1]] as const) s = playRound(s, a, b);
  assert.deepEqual(s.energy, { a: 30, b: 30 }, "never above 30");
  s = playRound(s, 30, 0);
  assert.equal(s.energy.a, 2, "all in leaves only the regain");
});

test("reaching an end wins at once; after 15 rounds the node's side wins, and the middle is a draw", () => {
  const won = replay(DUELS_1, [[1, 0], [1, 0], [1, 0]]);
  assert.deepEqual(won.ending, { winner: "a", reason: "reached_end" });
  assert.equal(won.rounds.length, 3);
  const b = replay(DUELS_1, [[0, 1], [0, 1], [0, 1]]);
  assert.deepEqual(b.ending, { winner: "b", reason: "reached_end" });

  const ahead = replay(DUELS_1, [[0, 1], ...Array.from({ length: 14 }, () => [1, 1] as [number, number])]);
  assert.deepEqual(ahead.ending, { winner: "b", reason: "rounds_up" });
  const level = replay(DUELS_1, Array.from({ length: 15 }, () => [2, 2] as [number, number]));
  assert.deepEqual(level.ending, { winner: null, reason: "draw" });
  assert.throws(() => playRound(level, 0, 0), /over/, "nothing after the end");
});

test("the 'spent' tie-break gives a middle finish to the side that spent less, and a draw when equal", () => {
  const rules = { ...DUELS_1, tieBreak: "spent" as const };
  const pulls: [number, number][] = [[3, 1], [1, 3], ...Array.from({ length: 13 }, () => [2, 2] as [number, number])];
  assert.deepEqual(replay(rules, pulls).ending, { winner: null, reason: "draw" }, "equal spending");
  const cheaper: [number, number][] = [[3, 1], [0, 3], ...Array.from({ length: 13 }, () => [2, 2] as [number, number])];
  assert.deepEqual(replay(rules, cheaper).ending, { winner: "a", reason: "tie_break" });
  assert.deepEqual(replay(DUELS_1, cheaper).ending, { winner: null, reason: "draw" }, "no tie-break in duels-1");
});

test("pulls must be whole numbers from 0 to the energy left", () => {
  const s = playRound(startMatch(), 30, 0);
  assert.equal(pullProblem(s, "a", 3), "a pull can't be more than the 2 energy left");
  assert.equal(pullProblem(s, "a", 2), null);
  assert.equal(pullProblem(s, "b", -1), "a pull can't be negative");
  assert.equal(pullProblem(s, "b", 1.5), "a pull is a whole number");
  assert.equal(pullProblem(s, "b", "3"), "a pull is a whole number");
  assert.throws(() => playRound(s, 3, 0), /a: a pull can't be more/);
});

test("forfeits and voids end a match without another round", () => {
  const s = playRound(startMatch(), 3, 1);
  assert.deepEqual(forfeit(s, "a").ending, { winner: "b", reason: "forfeit" });
  assert.deepEqual(voidMatch(s).ending, { winner: null, reason: "void" });
  const done = replay(DUELS_1, [[1, 0], [1, 0], [1, 0]]);
  assert.deepEqual(forfeit(done, "a").ending, done.ending, "a finished match stays finished");
});

test("fallbacks: zero, steady and mirror, always within the side's energy", () => {
  assert.deepEqual(parseFallback("steady:4"), { kind: "steady", pull: 4 });
  assert.equal(parseFallback("steady:x"), null);
  assert.equal(parseFallback("all-in"), null);
  let s = startMatch();
  assert.equal(fallbackPull({ kind: "mirror" }, s, "a"), 0, "nothing to mirror yet");
  s = playRound(s, 30, 7);
  assert.equal(fallbackPull({ kind: "mirror" }, s, "b"), 25, "b mirrors a's 30, capped at b's 25");
  assert.equal(fallbackPull({ kind: "mirror" }, s, "a"), 2, "a mirrors b's 7, capped at a's 2");
  assert.equal(fallbackPull({ kind: "steady", pull: 5 }, s, "a"), 2);
  assert.equal(fallbackPull({ kind: "zero" }, s, "b"), 0);
});

test("the clock: time counts only while a round waits, a round costs at most 2 minutes, and an empty bank falls back for good", () => {
  assert.deepEqual(chargeClock(DUELS_1, 600, 30), { bank: 570, fallback: false, bankOut: false });
  assert.deepEqual(chargeClock(DUELS_1, 600, 0), { bank: 600, fallback: false, bankOut: false });
  assert.deepEqual(chargeClock(DUELS_1, 600, 500), { bank: 480, fallback: true, bankOut: false }, "round time out");
  assert.deepEqual(chargeClock(DUELS_1, 50, 90), { bank: 0, fallback: true, bankOut: true }, "the bank ran out mid-round");
  assert.deepEqual(chargeClock(DUELS_1, 0, 1), { bank: 0, fallback: true, bankOut: true });
  assert.throws(() => chargeClock(DUELS_1, 600, -1));
  assert.throws(() => chargeClock(DUELS_1, 600, Number.NaN));
});

test("every match ends within 15 rounds, whatever legal pulls are played", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
  for (let m = 0; m < 2_000; m++) {
    let s = startMatch();
    while (!s.ending) s = playRound(s, Math.floor(rand() * (s.energy.a + 1)), Math.floor(rand() * (s.energy.b + 1)));
    assert.ok(s.rounds.length <= 15);
    assert.ok(Math.abs(s.node) <= 3);
    assert.ok(s.energy.a >= 0 && s.energy.b >= 0 && s.energy.a <= 30 && s.energy.b <= 30);
    // A replay of its pulls gives the same match.
    assert.deepEqual(replay(DUELS_1, s.rounds.map((r) => [r.pull.a, r.pull.b])), s);
  }
});

// ---------------------------------------------------------------- the solution

test("the matrix solver gets textbook games right", () => {
  const rps = solveMatrix([[0, -1, 1], [1, 0, -1], [-1, 1, 0]]);
  assert.ok(Math.abs(rps.value) < 1e-9);
  for (const w of rps.row) assert.ok(Math.abs(w - 1 / 3) < 1e-9);
  const saddle = solveMatrix([[3, 1], [4, 2]]);
  assert.deepEqual([saddle.value, saddle.row], [2, [0, 1]]);
});

test("the solved game: fair at the start, mixes are distributions, and the research's numbers hold", () => {
  const sol = solve(DUELS_1);
  assert.ok(Math.abs(sol.value(0, 0, 30, 30)) < 1e-5, "symmetric: the start is worth nothing to either side");
  for (const [r, p, a, b] of [[0, 0, 30, 30], [4, 1, 20, 12], [12, 0, 5, 5]] as const) {
    const mix = sol.mix(r, p, a, b);
    assert.equal(mix.length, a + 1);
    assert.ok(Math.abs(mix.reduce((n, w) => n + w, 0) - 1) < 1e-5);
    assert.ok(mix.every((w) => w >= 0));
  }
  // Two places behind with equal energy in round 5 is lost; two ahead is won (docs/arena.md 4.2).
  assert.equal(sol.value(4, -2, 15, 15), -1);
  assert.equal(sol.value(4, 2, 15, 15), 1);
  // The opening pulls 2 to 14: never 0 or 1, since 2 is free at full energy, and never more than 14.
  const open = Array.from(sol.mix(0, 0, 30, 30));
  assert.ok(open.slice(0, 2).every((w) => w < 1e-6) && open.slice(15).every((w) => w < 1e-6));
  // The round-1 winner goes on to win about 59% of the time under best play.
  const x = sol.mix(0, 0, 30, 30);
  let wins = 0, outcome = 0;
  for (let i = 0; i <= 30; i++) for (let j = 0; j <= 30; j++) if (i > j) (wins += x[i]! * x[j]!), (outcome += x[i]! * x[j]! * (1 + sol.after(0, 0, 30, 30, i, j)) / 2);
  assert.ok(Math.abs(outcome / wins - 0.594) < 0.005, `${outcome / wins}`);
});

// ---------------------------------------------------------------- the house

/** Plays a match with both sides chosen by functions of the state. */
function play(a: (s: MatchState, side: Side) => number, b: (s: MatchState, side: Side) => number): MatchState {
  let s = startMatch();
  while (!s.ending) s = playRound(s, a(s, "a"), b(s, "b"));
  return s;
}

test("the house plays legal pulls, the same every time for a seed, and commits to its seed", () => {
  const s = playRound(startMatch(), 9, 4);
  for (const bot of ["even", "reader"] as const) {
    const first = houseMove(bot, s, "b", "seed-1");
    assert.equal(houseMove(bot, s, "b", "seed-1"), first, `${bot} is deterministic`);
    assert.equal(pullProblem(s, "b", first), null);
  }
  assert.equal(seedCommitment("seed-1").length, 64);
  assert.notEqual(seededUnit("seed-1", 0), seededUnit("seed-2", 0));
  assert.notEqual(seededUnit("seed-1", 0), seededUnit("seed-1", 1));
});

test("Even draws from the equilibrium: over many seeds its opening matches the solved mix", () => {
  const sol = solve(DUELS_1);
  const mix = sol.mix(0, 0, 30, 30);
  const counts = new Array<number>(31).fill(0);
  const n = 4_000;
  for (let i = 0; i < n; i++) counts[houseMove("even", startMatch(), "a", `s${i}`)]!++;
  for (let p = 0; p <= 30; p++) assert.ok(Math.abs(counts[p]! / n - mix[p]!) < 0.03, `pull ${p}: ${counts[p]! / n} vs ${mix[p]}`);
});

test("Reader beats a predictable opponent that Even only breaks even against, and both hold their own as either side", () => {
  const steady2 = (s: MatchState, side: Side) => Math.min(2, s.energy[side]);
  const score = (bot: "even" | "reader", n: number) => {
    let net = 0;
    for (let i = 0; i < n; i++) {
      const m = i % 2 === 0 ? play((s, side) => houseMove(bot, s, side, `m${i}`), steady2) : play(steady2, (s, side) => houseMove(bot, s, side, `m${i}`));
      const mine: Side = i % 2 === 0 ? "a" : "b";
      net += m.ending!.winner === mine ? 1 : m.ending!.winner === null ? 0 : -1;
    }
    return net / n;
  };
  const even = score("even", 300), reader = score("reader", 300);
  assert.ok(reader > even + 0.2, `reader ${reader} vs even ${even}`);
  assert.ok(reader > 0.3, `reader ${reader}`);
});

test("Reader reads a fixed pull, a fixed share and an answer to its own last pull", () => {
  // Pulls 6 whatever its energy: the guess is 6 (capped by the energy it has).
  const steady = replay(DUELS_1, [[3, 6], [0, 6], [9, 6], [1, 6]]);
  assert.deepEqual(readOpponent(steady, "a", steady.energy.b), [6, 6, 6, 6]);
  // Pulls half its energy (15 of 30, 8 of 17, 5 of 11, 4 of 8): the guess scales with the 6 it has now.
  const share = replay(DUELS_1, [[16, 15], [0, 8], [6, 5], [0, 4]]);
  assert.equal(share.energy.b, 6);
  assert.deepEqual(readOpponent(share, "a", 6), [3, 3, 3, 3]);
  // Pulls one more than our last pull.
  const outbid = replay(DUELS_1, [[4, 5], [9, 5], [2, 10], [7, 3]]);
  assert.deepEqual(readOpponent(outbid, "a", outbid.energy.b), [8, 8, 8]);
  assert.deepEqual(readOpponent(startMatch(), "a", 30), []);
});

test("Reader beats players that pull a fixed amount or outbid its last pull", () => {
  const players = { steady6: (s: MatchState, side: Side) => Math.min(6, s.energy[side]), outbid: (s: MatchState, side: Side) => Math.min(s.energy[side], (s.rounds.at(-1)?.pull[side === "a" ? "b" : "a"] ?? 5) + 1) };
  for (const [name, them] of Object.entries(players)) {
    let net = 0;
    for (let i = 0; i < 100; i++) {
      const m = i % 2 === 0 ? play((s, side) => houseMove("reader", s, side, `r${i}`), them) : play(them, (s, side) => houseMove("reader", s, side, `r${i}`));
      const mine: Side = i % 2 === 0 ? "a" : "b";
      net += m.ending!.winner === mine ? 1 : m.ending!.winner === null ? 0 : -1;
    }
    assert.ok(net / 100 > 0.7, `${name}: ${net / 100}`);
  }
});

// ---------------------------------------------------------------- ratings, table talk, the entry point

test("Glicko-2 matches the worked example in Glickman's paper", () => {
  const after = rate({ r: 1500, rd: 200, vol: 0.06 }, [
    { opponent: { r: 1400, rd: 30, vol: 0.06 }, score: 1 },
    { opponent: { r: 1550, rd: 100, vol: 0.06 }, score: 0 },
    { opponent: { r: 1700, rd: 300, vol: 0.06 }, score: 0 },
  ]);
  assert.ok(Math.abs(after.r - 1464.06) < 0.05, `${after.r}`);
  assert.ok(Math.abs(after.rd - 151.52) < 0.05, `${after.rd}`);
  assert.ok(Math.abs(after.vol - 0.05999) < 0.00002, `${after.vol}`);
  // No games: only the deviation grows, up to 350.
  assert.ok(rate({ r: 1500, rd: 50, vol: 0.06 }, []).rd > 50);
  assert.equal(rate(START, []).rd, 350);
  // A quarter-weight win moves a new fighter about a quarter as far as a full one.
  const full = rate(START, [{ opponent: { r: 1500, rd: 60, vol: 0.06 }, score: 1 }]).r - 1500;
  const quarter = rate(START, [{ opponent: { r: 1500, rd: 60, vol: 0.06 }, score: 1, weight: 0.25 }]).r - 1500;
  assert.ok(quarter > 0 && quarter < full * 0.5, `${quarter} vs ${full}`);
  assert.equal(conservative({ r: 1600, rd: 50, vol: 0.06 }), 1500);
});

test("table talk: plain lines up to 140 characters, no links, addresses, mentions or hidden text", () => {
  assert.equal(checkTableTalk("  saving my energy, see you in round 12  "), "saving my energy, see you in round 12");
  assert.equal(checkTableTalk(""), "", "saying nothing is fine");
  for (const bad of ["x".repeat(141), "go to claim.lol now", "gm @someone", "send to 7j6tyzmUbb7K1J178ciwuvrTEd6VnK6fwan7tycM6g1Q", "hi\u200bthere", "site dot com"]) {
    assert.throws(() => checkTableTalk(bad), /Table talk|line/, bad);
  }
  assert.equal(checkTableTalk("email me? no. 0.5 energy left, e.g. nothing"), "email me? no. 0.5 energy left, e.g. nothing");
});

test("highwire-core/arena reaches no Node built-in, web3.js or Raydium's SDK", () => {
  const seen = new Set<string>();
  const outside: string[] = [];
  const visit = (url: URL) => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const src = readFileSync(url, "utf8");
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gms)) {
      const spec = m[1]!;
      if (spec.startsWith(".")) visit(new URL(spec, url));
      else if (!spec.startsWith("@noble/hashes/")) outside.push(`${url.pathname.split("/src/")[1]}: ${spec}`);
    }
  };
  visit(new URL("../src/arena/index.ts", import.meta.url));
  assert.deepEqual(outside, []);
  assert.ok(seen.size >= 7);
});
