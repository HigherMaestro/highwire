// Writes programs/line-wager/tests/fixtures/series.json: random wager series played by packages/core/src/arena/series.ts,
// every event with whether it was accepted and the state after it. The Rust program's tests (tests/parity.rs) replay
// every event and compare. usage: npm run wager-fixtures -w highwire-core [-- <series>]   (default 400)
import { writeFileSync } from "node:fs";
import { DUELS_1, fallbackCommitment, moveCommitment, sideOf, startSeries, commit, reveal, timeout, retire, type Fallback, type Player, type SeriesState } from "../src/arena/index.ts";

const N = Number(process.argv[2] ?? 400);
const REASON: Record<string, number> = { reached_end: 1, rounds_up: 2, tie_break: 3, draw: 4, missed_reveal: 5, void: 6 };
const SERIES_REASON: Record<string, number> = { decided: 1, draw: 2, retired: 3 };
const P = (p: Player | null) => (p === null ? null : p === "A" ? 0 : 1);

// mulberry32: a small PRNG with good low bits (a plain LCG's low bits cycle quickly).
let seed = 20261109;
const rand = (n: number) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return (((x ^ (x >>> 14)) >>> 0) / 4294967296 * n) | 0;
};
const hex32 = () => Array.from({ length: 32 }, () => rand(256).toString(16).padStart(2, "0")).join("");

const snap = (s: SeriesState) => ({
  match: s.match, phase: s.phase === "commit" ? 0 : 1, phaseOpenedAt: s.phaseOpenedAt,
  node: s.game.node, energy: [s.game.energy.a, s.game.energy.b], rounds: s.game.rounds.length,
  bank: [s.bank.A, s.bank.B], bankOut: [s.bankOut.A, s.bankOut.B],
  pulls: [s.round.a.pull, s.round.b.pull], owes: [s.round.a.owesFallback, s.round.b.owesFallback],
  results: s.results.map((r) => [P(r.winner), REASON[r.reason]]),
  ending: s.ending ? [P(s.ending.winner), SERIES_REASON[s.ending.reason]] : null,
});
const fb = (f: Fallback) => ({ kind: f.kind === "zero" ? 0 : f.kind === "steady" ? 1 : 2, pull: f.kind === "steady" ? f.pull : 0 });

const out = [];
for (let i = 0; i < N; i++) {
  const id = hex32(), salt = { A: hex32(), B: hex32() };
  const kinds = (): Fallback => [{ kind: "zero" } as Fallback, { kind: "mirror" } as Fallback, { kind: "steady", pull: rand(12) } as Fallback][rand(3)]!;
  const fallbacks: Record<Player, Fallback> = { A: kinds(), B: kinds() };
  const start = 1_800_000_000 + rand(1000);
  const s = startSeries({ rules: DUELS_1, revealSeconds: 120 }, id, { A: fallbackCommitment(id, "A", fallbacks.A, salt.A), B: fallbackCommitment(id, "B", fallbacks.B, salt.B) }, start);
  const events: unknown[] = [];
  const kept: Record<string, { pull: number; nonce: string }> = {};
  const tryDo = (ev: Record<string, unknown>, f: () => void) => {
    let ok = true;
    try { f(); } catch { ok = false; }
    events.push({ ...ev, ok, after: snap(s) });
  };
  let t = start, guard = 0;
  // Players mostly do the right thing (so matches end by the rules), with faults mixed in: late or missed moves,
  // wrong rounds, illegal pulls, bad reveals, wrong fallbacks, stray timeouts and the odd retirement.
  while (!s.ending && guard++ < 4000) {
    t += rand(25) === 0 ? 60 + rand(120) : 1 + rand(8);
    if (rand(1500) === 0) { const p: Player = rand(2) ? "A" : "B"; tryDo({ kind: "retire", player: P(p) }, () => retire(s, p)); break; }
    if (rand(12) === 0) { tryDo({ kind: "timeout", at: t }, () => timeout(s, t)); continue; }
    const m = s.match, round = s.game.rounds.length + 1, key = `${m}:${round}`;
    const want = (["A", "B"] as const).filter((q) => {
      const r = s.round[sideOf(q, m)];
      return s.phase === "commit" ? !(r.hash || r.owesFallback) : r.pull === null;
    });
    const p: Player = want.length && rand(8) !== 0 ? want[rand(want.length)]! : rand(2) ? "A" : "B";
    const side = sideOf(p, m);
    if (s.phase === "commit") {
      const pull = rand(150) === 0 ? s.game.energy[side] + 1 + rand(5) : rand(s.game.energy[side] + 1);
      const nonce = hex32();
      const hash = moveCommitment(id, m, rand(40) === 0 ? round + 1 : round, side, pull, nonce);
      tryDo({ kind: "commit", player: P(p), round, hash, at: t }, () => { commit(s, p, round, hash, t); kept[`${p}:${key}`] = { pull, nonce }; });
    } else if (s.round[side].owesFallback) {
      const f = rand(20) === 0 ? ({ kind: "steady", pull: 7 } as Fallback) : fallbacks[p];
      tryDo({ kind: "revealFallback", player: P(p), fallback: fb(f), salt: salt[p], at: t }, () => reveal(s, p, { fallback: f, salt: salt[p] }, t));
    } else {
      const k = kept[`${p}:${key}`] ?? { pull: 0, nonce: hex32() };
      const pull = rand(30) === 0 ? (k.pull + 1) % 31 : k.pull;
      tryDo({ kind: "reveal", player: P(p), pull, nonce: k.nonce, at: t }, () => reveal(s, p, { pull, nonce: k.nonce }, t));
    }
  }
  out.push({ seriesId: id, fallbackHash: [s.fallbackHash.A, s.fallbackHash.B], start, events });
}
const path = new URL("../../../programs/line-wager/tests/fixtures/series.json", import.meta.url);
writeFileSync(path, JSON.stringify({ rules: "duels-1", revealSeconds: 120, series: out }));
const events = out.reduce((n, s) => n + s.events.length, 0);
console.log(`wrote ${out.length} series, ${events} events`);
