import { test } from "node:test";
import assert from "node:assert/strict";
import { DUELS_1, fallbackCommitment, fallbackPull, moveCommitment, playerOf, replay, retire, reveal, commit, sideOf, startSeries, timeout, type Fallback, type Player, type SeriesState } from "../src/arena/index.ts";

// The wager series (docs/wager-mode.md 4.2, 7.2): the on-chain program's twin. Every path the program has: honest play,
// side alternation, the early end, a missed reveal, a missed commit and its committed fallback, a bank running out,
// both banks out, a drawn series, retiring, and moves the program must refuse.

const CONFIG = { rules: DUELS_1, revealSeconds: 120 };
const ID = "11".repeat(32);
const SALT: Record<Player, string> = { A: "aa".repeat(32), B: "bb".repeat(32) };
const nonce = (n: number) => n.toString(16).padStart(64, "0");

function series(fallbacks: Record<Player, Fallback> = { A: { kind: "zero" }, B: { kind: "mirror" } }, at = 0): SeriesState {
  return startSeries(CONFIG, ID, { A: fallbackCommitment(ID, "A", fallbacks.A, SALT.A), B: fallbackCommitment(ID, "B", fallbacks.B, SALT.B) }, at);
}

/** Both players commit and reveal one round, 5 seconds apart. */
function play(s: SeriesState, pA: number, pB: number, at: number): number {
  const round = s.game.rounds.length + 1, m = s.match;
  commit(s, "A", round, moveCommitment(ID, m, round, sideOf("A", m), pA, nonce(at)), at);
  commit(s, "B", round, moveCommitment(ID, m, round, sideOf("B", m), pB, nonce(at + 1)), at + 1);
  reveal(s, "A", { pull: pA, nonce: nonce(at) }, at + 2);
  reveal(s, "B", { pull: pB, nonce: nonce(at + 1) }, at + 3);
  return at + 5;
}

test("an honest series: sides alternate, each match is the arena's rules, and it ends as soon as it's decided", () => {
  const s = series();
  let t = 10;
  // A always out-pulls B by one in every match, whichever side A is on: A wins three straight and the series ends.
  for (let m = 0; m < 3; m++) {
    assert.equal(s.match, m);
    assert.equal(sideOf("A", m), m % 2 === 0 ? "a" : "b");
    const pulls: [number, number][] = [];
    while (s.match === m && !s.ending) {
      const e = s.game.energy, aSide = sideOf("A", m);
      const pA = Math.min(3, e[aSide]), pB = Math.min(2, e[aSide === "a" ? "b" : "a"]);
      pulls.push(aSide === "a" ? [pA, pB] : [pB, pA]);
      t = play(s, pA, pB, t);
    }
    assert.equal(s.results[m]!.winner, "A");
    assert.equal(replay(DUELS_1, pulls).ending!.winner, sideOf("A", m), "the same as replaying the pulls");
  }
  assert.deepEqual(s.ending, { winner: "A", reason: "decided" });
  assert.equal(s.results.length, 3);
  assert.throws(() => play(s, 1, 1, t), /over/);
});

test("withholding never pays: a side that committed and doesn't reveal forfeits the match", () => {
  const s = series();
  commit(s, "A", 1, moveCommitment(ID, 0, 1, "a", 20, nonce(1)), 5);
  commit(s, "B", 1, moveCommitment(ID, 0, 1, "b", 25, nonce(2)), 6);
  reveal(s, "B", { pull: 25, nonce: nonce(2) }, 7);
  // A sees B's 25 and withholds its 20.
  assert.throws(() => timeout(s, 6 + 120), /still open/);
  timeout(s, 6 + 121);
  assert.deepEqual(s.results[0], { winner: "B", reason: "missed_reveal" });
  assert.equal(s.match, 1, "the next match opened");
  assert.equal(s.phase, "commit");
});

test("both sides missing their reveals makes the match void", () => {
  const s = series();
  commit(s, "A", 1, moveCommitment(ID, 0, 1, "a", 1, nonce(1)), 1);
  commit(s, "B", 1, moveCommitment(ID, 0, 1, "b", 1, nonce(2)), 1);
  timeout(s, 1 + 121);
  assert.deepEqual(s.results[0], { winner: null, reason: "void" });
});

test("a missed commit owes the committed fallback; a wrong one is refused; once known it plays itself", () => {
  const s = series({ A: { kind: "steady", pull: 4 }, B: { kind: "zero" } });
  commit(s, "B", 1, moveCommitment(ID, 0, 1, "b", 2, nonce(2)), 5);
  assert.throws(() => timeout(s, 120), /nothing has timed out/);
  timeout(s, 121);
  assert.equal(s.round.a.owesFallback, true);
  assert.equal(s.bank.A, DUELS_1.bankSeconds - DUELS_1.roundSeconds, "charged the round's time");
  assert.equal(s.phase, "reveal");
  assert.throws(() => reveal(s, "A", { pull: 4, nonce: nonce(1) }, 122), /owes its fallback/);
  assert.throws(() => reveal(s, "A", { fallback: { kind: "steady", pull: 9 }, salt: SALT.A }, 122), /isn't the committed fallback/);
  reveal(s, "A", { fallback: { kind: "steady", pull: 4 }, salt: SALT.A }, 122);
  reveal(s, "B", { pull: 2, nonce: nonce(2) }, 123);
  assert.deepEqual(s.game.rounds[0]!.pull, { a: 4, b: 2 });
  // Round 2: A misses again; its fallback is public now, so it plays as soon as B commits, with no reveal needed.
  commit(s, "B", 2, moveCommitment(ID, 0, 2, "b", 6, nonce(3)), 130);
  timeout(s, 123 + 121);
  assert.equal(s.round.a.pull, fallbackPull({ kind: "steady", pull: 4 }, s.game, "a"));
  reveal(s, "B", { pull: 6, nonce: nonce(3) }, 250);
  assert.deepEqual(s.game.rounds[1]!.pull, { a: 4, b: 6 });
});

test("a bank that runs out owes the fallback every round; both banks out makes the match void", () => {
  const s = series({ A: { kind: "zero" }, B: { kind: "zero" } });
  let t = 0;
  // Neither side ever commits: each round costs both 120 seconds of a 600-second bank.
  for (let i = 0; i < 5 && s.match === 0; i++) {
    t += 121;
    timeout(s, t);
    if (s.phase === "reveal") {
      if (s.round.a.pull === null) reveal(s, playerOf("a", 0), { fallback: { kind: "zero" }, salt: SALT[playerOf("a", 0)] }, t);
      if (s.round.b.pull === null && s.match === 0) reveal(s, playerOf("b", 0), { fallback: { kind: "zero" }, salt: SALT[playerOf("b", 0)] }, t);
    }
  }
  assert.deepEqual(s.results[0], { winner: null, reason: "void" }, "both banks out: nobody's there");
  assert.equal(s.match, 1);
});

test("a level series after five matches is a draw", () => {
  const s = series();
  let t = 0;
  for (let m = 0; m < 5; m++) while (s.match === m && !s.ending) t = play(s, 2, 2, t);
  assert.equal(s.results.length, 5);
  assert.ok(s.results.every((r) => r.winner === null));
  assert.deepEqual(s.ending, { winner: null, reason: "draw" });
});

test("moves the program refuses", () => {
  const s = series();
  assert.throws(() => commit(s, "A", 2, "00".repeat(32), 1), /this is round 1/);
  assert.throws(() => commit(s, "A", 1, "nothex", 1), /32 bytes/);
  assert.throws(() => commit(s, "A", 1, "00".repeat(32), 121), /too late/);
  commit(s, "A", 1, moveCommitment(ID, 0, 1, "a", 31, nonce(1)), 1);
  assert.throws(() => commit(s, "A", 1, "00".repeat(32), 2), /already committed/);
  assert.throws(() => reveal(s, "A", { pull: 31, nonce: nonce(1) }, 2), /not a reveal phase/);
  commit(s, "B", 1, moveCommitment(ID, 0, 1, "b", 3, nonce(2)), 2);
  assert.throws(() => reveal(s, "A", { pull: 30, nonce: nonce(1) }, 3), /doesn't match/);
  assert.throws(() => reveal(s, "A", { pull: 31, nonce: nonce(1) }, 3), /illegal pull/);
  assert.throws(() => reveal(s, "B", { pull: 3, nonce: nonce(2) }, 2 + 121), /too late/);
});

test("retiring forfeits the series", () => {
  const s = series();
  retire(s, "B");
  assert.deepEqual(s.ending, { winner: "A", reason: "retired" });
  assert.throws(() => retire(s, "A"), /over/);
});

test("2,000 random series all end, every match by the arena's rules", () => {
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let i = 0; i < 2000; i++) {
    const kinds: Fallback[] = [{ kind: "zero" }, { kind: "mirror" }, { kind: "steady", pull: rand(8) }];
    const fb: Record<Player, Fallback> = { A: kinds[rand(3)]!, B: kinds[rand(3)]! };
    const s = series(fb);
    let t = 0, guard = 0;
    while (!s.ending && guard++ < 2000) {
      t += 1 + rand(20);
      const round = s.game.rounds.length + 1, m = s.match;
      if (s.phase === "commit") {
        for (const p of ["A", "B"] as const) {
          const side = sideOf(p, m);
          if (s.round[side].hash || s.round[side].owesFallback || s.phase !== "commit" || s.match !== m) continue;
          if (rand(10) === 0) continue; // sometimes miss the commit
          const pull = rand(s.game.energy[side] + 1);
          commit(s, p, round, moveCommitment(ID, m, round, side, pull, nonce(round * 2 + (p === "A" ? 0 : 1))), t);
          (s as any)[`_${p}`] = pull;
        }
        if (s.phase === "commit" && !s.ending) { t += 121; try { timeout(s, t); } catch { /* nothing due */ } }
      } else {
        for (const p of ["A", "B"] as const) {
          const side = sideOf(p, s.match);
          if (s.phase !== "reveal" || s.round[side].pull !== null || s.match !== m) continue;
          if (rand(40) === 0) continue; // rarely miss a reveal
          if (s.round[side].owesFallback) reveal(s, p, { fallback: fb[p], salt: SALT[p] }, t);
          else reveal(s, p, { pull: (s as any)[`_${p}`], nonce: nonce(round * 2 + (p === "A" ? 0 : 1)) }, t);
        }
        if (s.phase === "reveal" && !s.ending && s.match === m) { t += 121; timeout(s, t); }
      }
    }
    assert.ok(s.ending, `series ${i} ended`);
    assert.ok(s.results.length >= 3 && s.results.length <= 5, `series ${i}: ${s.results.length} matches`);
  }
});
