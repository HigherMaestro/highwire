// Writes programs/line-wager/tests/fixtures/series.ndjson: random wager series played by
// packages/core/src/arena/series.ts, every event with whether it was accepted (and the error's kind if not) and the
// state after it, one series a line. The Rust program's tests (tests/parity.rs) replay every event and compare.
//
// Players get personas (present, slow, absent), so banks run out and both-banks-out voids happen; faults are mixed in on
// purpose (wrong phase, wrong match, wrong round, a second copy of an earlier match's commit arriving at the same round
// number, the wrong kind of reveal, illegal pulls, bad reveals, wrong fallbacks, a clock going backward, moves exactly on
// a deadline, moves after the series ended). It refuses to write fixtures that miss a branch: every label in COVERAGE
// must be hit at least MIN times. (NothingDue isn't one: in a commit phase at least one side is always still to commit,
// so it's unreachable by construction, in both languages.)
//
// usage: npm run wager-fixtures -w highwire-core [-- --n 2000 --seed 20261109]
import { createWriteStream, mkdirSync } from "node:fs";
import { DUELS_1, fallbackCommitment, moveCommitment, sideOf, startSeries, commit, reveal, timeout, retire, commitDeadline, revealDeadline, type Fallback, type Player, type SeriesState } from "../src/arena/index.ts";

const arg = (k: string, d: number) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg("n", 2000), SEED = arg("seed", 20261109), MIN = arg("min", 5);
const REASON: Record<string, number> = { reached_end: 1, rounds_up: 2, tie_break: 3, draw: 4, missed_reveal: 5, void: 6 };
const SERIES_REASON: Record<string, number> = { decided: 1, draw: 2, retired: 3 };
const P = (p: Player | null) => (p === null ? null : p === "A" ? 0 : 1);

// mulberry32: a small deterministic PRNG with good low bits.
let seed = SEED;
const rand = (n: number) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4294967296) * n);
};
const chance = (n: number) => rand(n) === 0;
const hex32 = () => Array.from({ length: 32 }, () => rand(256).toString(16).padStart(2, "0")).join("");

/** The error's kind, as the Rust names it. */
function kindOf(message: string): string {
  const table: [RegExp, string][] = [
    [/series is over/, "Over"], [/not a (commit|reveal) phase/, "WrongPhase"], [/this is match/, "WrongMatch"], [/this is round/, "WrongRound"],
    [/already committed/, "AlreadyCommitted"], [/too late/, "TooLate"], [/nothing has timed out/, "NothingDue"],
    [/still has time|still open/, "StillOpen"], [/already revealed/, "AlreadyRevealed"], [/owes its fallback/, "OwesFallback"],
    [/committed a pull; reveal it/, "NoFallbackOwed"], [/committed fallback/, "WrongFallback"], [/doesn't match the commitment/, "BadReveal"],
    [/illegal pull/, "IllegalPull"], [/player is/, "BadPlayer"], [/clock went backward/, "ClockBackward"],
  ];
  for (const [re, k] of table) if (re.test(message)) return k;
  throw new Error(`no kind for "${message}"`);
}

const snap = (s: SeriesState) => ({
  match: s.match, phase: s.phase === "commit" ? 0 : 1, phaseOpenedAt: s.phaseOpenedAt,
  node: s.game.node, energy: [s.game.energy.a, s.game.energy.b], spent: [s.game.spent.a, s.game.spent.b], rounds: s.game.rounds.length,
  lastPull: (() => { const l = s.game.rounds.at(-1); return l ? [l.pull.a, l.pull.b] : [0, 0]; })(),
  bank: [s.bank.A, s.bank.B], bankOut: [s.bankOut.A, s.bankOut.B],
  hashes: [s.round.a.hash, s.round.b.hash], pulls: [s.round.a.pull, s.round.b.pull], owes: [s.round.a.owesFallback, s.round.b.owesFallback],
  fallbackKnown: [s.fallback.A !== null, s.fallback.B !== null],
  results: s.results.map((r) => [P(r.winner), REASON[r.reason]]),
  ending: s.ending ? [P(s.ending.winner), SERIES_REASON[s.ending.reason]] : null,
});
const fb = (f: Fallback) => ({ kind: f.kind === "zero" ? 0 : f.kind === "steady" ? 1 : 2, pull: f.kind === "steady" ? f.pull : 0 });

const COVERAGE: Record<string, number> = {};
const hit = (k: string) => (COVERAGE[k] = (COVERAGE[k] ?? 0) + 1);
for (const k of ["bank-out", "void: both banks out", "void: both missed reveals", "missed reveal", "reached end", "rounds up", "draw match",
  "series won by A", "series won by B", "series drawn", "retired in commit", "retired in reveal", "decided 3-0", "decided 3-1", "decided in 5",
  "fallback auto-played", "both fallbacks at once", "commit 1s before deadline", "commit on deadline refused", "timeout on deadline",
  "reveal on window end", "reveal after window refused", "copy of an earlier match's commit refused",
  "Over", "WrongPhase", "WrongMatch", "WrongRound", "AlreadyCommitted", "TooLate", "StillOpen", "AlreadyRevealed", "OwesFallback",
  "NoFallbackOwed", "WrongFallback", "BadReveal", "IllegalPull", "ClockBackward"]) COVERAGE[k] = 0;

type Persona = "present" | "slow" | "absent";
const persona = (): Persona => (chance(10) ? "absent" : chance(4) ? "slow" : "present");

const file = new URL("../../../programs/line-wager/tests/fixtures/series.ndjson", import.meta.url);
// The folder is git-ignored, so a fresh checkout doesn't have it.
mkdirSync(new URL(".", file), { recursive: true });
const out = createWriteStream(file);
out.write(JSON.stringify({ rules: "duels-1", revealSeconds: 120, seed: SEED, n: N }) + "\n");
let events = 0;

for (let i = 0; i < N; i++) {
  const id = hex32(), salt = { A: hex32(), B: hex32() };
  const pick = (): Fallback => [{ kind: "zero" } as Fallback, { kind: "mirror" } as Fallback, { kind: "steady", pull: rand(12) } as Fallback][rand(3)]!;
  const fallbacks: Record<Player, Fallback> = { A: pick(), B: pick() };
  const who: Record<Player, Persona> = { A: persona(), B: persona() };
  const start = 1_800_000_000 + rand(1000);
  const s = startSeries({ rules: DUELS_1, revealSeconds: 120 }, id, { A: fallbackCommitment(id, "A", fallbacks.A, salt.A), B: fallbackCommitment(id, "B", fallbacks.B, salt.B) }, start);
  const evs: unknown[] = [];
  const kept: Record<string, { pull: number; nonce: string }> = {};
  /** Every commit the series accepted, as sent: a copy of one can arrive again later (a retry that landed twice). */
  const sent: Record<Player, { match: number; round: number; hash: string }[]> = { A: [], B: [] };
  const tryDo = (ev: Record<string, unknown>, f: () => void) => {
    const before = { results: s.results.length, owes: [s.round.a.owesFallback, s.round.b.owesFallback], pulls: [s.round.a.pull, s.round.b.pull], match: s.match, phase: s.phase, bankOut: [s.bankOut.A, s.bankOut.B] };
    let ok = true, error: string | null = null;
    try { f(); } catch (e) { ok = false; error = kindOf((e as Error).message); hit(error); }
    if (ok) {
      if (!before.bankOut[0] && s.bankOut.A) hit("bank-out");
      if (!before.bankOut[1] && s.bankOut.B) hit("bank-out");
      for (const r of s.results.slice(before.results)) {
        if (r.reason === "void") hit(ev.kind === "timeout" && before.phase === "reveal" && s.results.length === before.results + 1 ? "void: both missed reveals" : "void: both banks out");
        if (r.reason === "missed_reveal") hit("missed reveal");
        if (r.reason === "reached_end") hit("reached end");
        if (r.reason === "rounds_up") hit("rounds up");
        if (r.reason === "draw") hit("draw match");
      }
      if (s.match === before.match && s.phase === "reveal") {
        const auto = (["a", "b"] as const).filter((side, j) => s.round[side].owesFallback && s.round[side].pull !== null && before.pulls[j] === null && ev.kind !== "revealFallback");
        if (auto.length) hit("fallback auto-played");
      }
      if (s.results.length > before.results && ev.kind !== "revealFallback" && before.owes[0] && before.owes[1]) hit("both fallbacks at once");
    }
    evs.push({ ...ev, ok, error, after: snap(s) });
  };
  let t = start, guard = 0;
  while (!s.ending && guard++ < 6000) {
    // Time moves on; sometimes to exactly a deadline, sometimes a long way.
    const j = rand(40);
    if (j === 0 && s.phase === "commit") t = Math.max(t, commitDeadline(s, rand(2) ? "a" : "b") - rand(2));
    else if (j === 1 && s.phase === "reveal") t = Math.max(t, revealDeadline(s) + rand(2));
    else t += chance(20) ? 60 + rand(120) : 1 + rand(8);
    if (chance(3000)) { const p: Player = rand(2) ? "A" : "B"; if (s.phase === "commit") hit("retired in commit"); else hit("retired in reveal"); tryDo({ kind: "retire", player: P(p) }, () => retire(s, p)); break; }
    if (chance(200)) { const back = s.phaseOpenedAt - 1 - rand(5); tryDo({ kind: "timeout", at: back }, () => timeout(s, back)); continue; }
    if (chance(10)) {
      const lateC = s.phase === "commit" && (["a", "b"] as const).some((side) => !(s.round[side].hash || s.round[side].owesFallback) && t === commitDeadline(s, side));
      tryDo({ kind: "timeout", at: t }, () => timeout(s, t));
      if (lateC && evs.length && (evs.at(-1) as { ok: boolean }).ok) hit("timeout on deadline");
      continue;
    }
    const m = s.match, round = s.game.rounds.length + 1, key = `${m}:${round}`;
    const acting = (["A", "B"] as const).filter((q) => who[q] !== "absent" && !(who[q] === "slow" && chance(3)));
    const want = acting.filter((q) => {
      const r = s.round[sideOf(q, m)];
      return s.phase === "commit" ? !(r.hash || r.owesFallback) : r.pull === null;
    });
    if (!want.length && !chance(6)) continue;
    const p: Player = want.length && !chance(8) ? want[rand(want.length)]! : rand(2) ? "A" : "B";
    const side = sideOf(p, m);
    const wrongPhase = chance(30);
    const doCommit = (s.phase === "commit") !== wrongPhase;
    // A second copy of a commit this player made in an earlier match, for the round number that's open again now, while
    // its commit for this round is still to come: all a commit that named only its round would need to be accepted.
    const copy = s.phase === "commit" && !(s.round[side].hash || s.round[side].owesFallback) && t < commitDeadline(s, side) ? sent[p].find((c) => c.match < m && c.round === round) : undefined;
    if (copy && chance(10)) {
      tryDo({ kind: "commit", player: P(p), match: copy.match, round: copy.round, hash: copy.hash, at: t }, () => commit(s, p, copy.match, copy.round, copy.hash, t));
      if ((evs.at(-1) as { error: string | null }).error === "WrongMatch") hit("copy of an earlier match's commit refused");
      continue;
    }
    if (doCommit) {
      const pull = chance(150) ? s.game.energy[side] + 1 + rand(5) : rand(s.game.energy[side] + 1);
      const nonce = hex32();
      const r = chance(50) ? round + 1 : round;
      // Another match of the five, or (rarely) a number that's no match at all.
      const mm = chance(40) ? (chance(4) ? 5 + rand(251) : (m + 1 + rand(4)) % 5) : m;
      const hash = moveCommitment(id, m, chance(60) ? round + 1 : round, side, pull, nonce);
      const deadline = s.phase === "commit" ? commitDeadline(s, side) : 0;
      tryDo({ kind: "commit", player: P(p), match: mm, round: r, hash, at: t }, () => { commit(s, p, mm, r, hash, t); kept[`${p}:${key}`] = { pull, nonce }; sent[p].push({ match: mm, round: r, hash }); });
      const last = evs.at(-1) as { ok: boolean; error: string | null };
      if (deadline && t === deadline - 1 && last.ok) hit("commit 1s before deadline");
      if (deadline && t === deadline && last.error === "TooLate") hit("commit on deadline refused");
    } else {
      const window = s.phase === "reveal" ? revealDeadline(s) : 0;
      const owes = s.round[side].owesFallback, wrongKind = chance(30);
      if (owes !== wrongKind) {
        const f = chance(20) ? ({ kind: "steady", pull: 7 } as Fallback) : fallbacks[p];
        tryDo({ kind: "revealFallback", player: P(p), fallback: fb(f), salt: salt[p], at: t }, () => reveal(s, p, { fallback: f, salt: salt[p] }, t));
      } else {
        const k = kept[`${p}:${key}`] ?? { pull: 0, nonce: hex32() };
        const pull = chance(30) ? (k.pull + 1) % 31 : k.pull;
        tryDo({ kind: "reveal", player: P(p), pull, nonce: k.nonce, at: t }, () => reveal(s, p, { pull, nonce: k.nonce }, t));
      }
      const last = evs.at(-1) as { ok: boolean; error: string | null };
      if (window && t === window && last.ok) hit("reveal on window end");
      if (window && t > window && last.error === "TooLate") hit("reveal after window refused");
    }
  }
  if (s.ending) {
    const w = s.ending.winner, n = s.results.length;
    if (s.ending.reason === "draw") hit("series drawn");
    else if (w === "A") hit("series won by A");
    else if (w === "B") hit("series won by B");
    if (s.ending.reason === "decided") hit(n === 3 ? "decided 3-0" : n === 4 ? "decided 3-1" : "decided in 5");
    // Anything after the end is refused.
    for (let k = 0; k < 2; k++) {
      t += 1;
      const p: Player = rand(2) ? "A" : "B";
      if (rand(2)) tryDo({ kind: "timeout", at: t }, () => timeout(s, t));
      else tryDo({ kind: "commit", player: P(p), match: s.match, round: 1, hash: "00".repeat(32), at: t }, () => commit(s, p, s.match, 1, "00".repeat(32), t));
    }
  }
  out.write(JSON.stringify({ seriesId: id, fallbackHash: [s.fallbackHash.A, s.fallbackHash.B], start, personas: [who.A, who.B], events: evs }) + "\n");
  events += evs.length;
}
out.end();
await new Promise<void>((r) => out.on("finish", () => r()));

const missing = Object.entries(COVERAGE).filter(([, n]) => n < MIN);
console.log(`wrote ${N} series, ${events} events (seed ${SEED})`);
console.log(Object.entries(COVERAGE).map(([k, n]) => `  ${k}: ${n}`).join("\n"));
if (missing.length) {
  console.error(`coverage below ${MIN}: ${missing.map(([k, n]) => `${k} (${n})`).join(", ")}`);
  process.exit(1);
}
