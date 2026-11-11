import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DUELS_1, commit, commitDeadline, fallbackCommitment, fallbackPull, moveCommitment, playerOf, replay, retire, reveal, revealDeadline, sideOf,
  startSeries, timeout, validFallback, type Fallback, type Player, type SeriesState,
} from "../src/arena/index.ts";

// The wager series (docs/wager-mode.md 4.2, 7.2): the on-chain program's twin. Every path the program has, and the
// rules the audit settled: a commit-phase timeout waits until every side still to commit is past its own deadline; a
// move must land before its deadline, never on it; a bank-out lasts the rest of the series; the clock never goes back.

const CONFIG = { rules: DUELS_1, revealSeconds: 120 };
const ID = "11".repeat(32);
const SALT: Record<Player, string> = { A: "aa".repeat(32), B: "bb".repeat(32) };
const nonce = (n: number) => n.toString(16).padStart(64, "0");

function series(fallbacks: Record<Player, Fallback> = { A: { kind: "zero" }, B: { kind: "mirror" } }, at = 0): SeriesState {
  return startSeries(CONFIG, ID, { A: fallbackCommitment(ID, "A", fallbacks.A, SALT.A), B: fallbackCommitment(ID, "B", fallbacks.B, SALT.B) }, at);
}
const hashFor = (s: SeriesState, p: Player, pull: number, n: number) => moveCommitment(ID, s.match, s.game.rounds.length + 1, sideOf(p, s.match), pull, nonce(n));

/** Both players commit and reveal one round, a second apart. */
function play(s: SeriesState, pA: number, pB: number, at: number): number {
  const round = s.game.rounds.length + 1;
  commit(s, "A", s.match, round, hashFor(s, "A", pA, at), at);
  commit(s, "B", s.match, round, hashFor(s, "B", pB, at + 1), at + 1);
  reveal(s, "A", { pull: pA, nonce: nonce(at) }, at + 2);
  reveal(s, "B", { pull: pB, nonce: nonce(at + 1) }, at + 3);
  return at + 5;
}

test("known-answer hashes, the same vectors as the Rust (tests/parity.rs)", () => {
  assert.equal(moveCommitment(ID, 2, 7, "b", 13, "22".repeat(32)), "3ae827910d2eb6b35de306cbb9ecf454e510377ce33bbbe5eb06f087925d9d82");
  assert.equal(fallbackCommitment(ID, "B", { kind: "steady", pull: 9 }, "33".repeat(32)), "cade30188add781fbf53fd6b29380ca9b0d865cb7aedd2365c67278ec46b8da0");
  assert.equal(fallbackCommitment(ID, "A", { kind: "mirror" }, "33".repeat(32)), "3d1d8e85f8cf343b2b1e6fb25d0d9d463b78f824c91aee691e797668fac4be8a");
});

test("the hashes refuse anything the program couldn't accept, instead of wrapping it", () => {
  for (const f of [{ kind: "steady", pull: 100 }, { kind: "steady", pull: -1 }, { kind: "steady", pull: 2.5 }, { kind: "zero", pull: 7 }, { kind: "bogus" }] as unknown as Fallback[]) {
    assert.equal(validFallback(f), false, JSON.stringify(f));
    assert.throws(() => fallbackCommitment(ID, "A", f, SALT.A), /program accepts/);
  }
  for (const [m, r, p] of [[256, 1, 1], [0, 1, 259], [0, 1, Number.NaN], [0, 1, -1], [0, 1.5, 1]]) {
    assert.throws(() => moveCommitment(ID, m!, r!, "a", p!, nonce(1)), /0 to 255/);
  }
});

test("an honest series: sides alternate, each match is the arena's rules, and it ends as soon as it's decided (3-0)", () => {
  const s = series();
  let t = 10;
  for (let m = 0; m < 3; m++) {
    assert.equal(sideOf("A", m), m % 2 === 0 ? "a" : "b");
    const pulls: [number, number][] = [];
    while (s.match === m && !s.ending) {
      const aSide = sideOf("A", m), e = s.game.energy;
      const pA = Math.min(3, e[aSide]), pB = Math.min(2, e[aSide === "a" ? "b" : "a"]);
      pulls.push(aSide === "a" ? [pA, pB] : [pB, pA]);
      t = play(s, pA, pB, t);
    }
    assert.equal(s.results[m]!.winner, "A");
    assert.equal(replay(DUELS_1, pulls).ending!.winner, sideOf("A", m), "the same as replaying the pulls");
  }
  assert.deepEqual(s.ending, { winner: "A", reason: "decided" });
  assert.throws(() => play(s, 1, 1, t), /over/);
  assert.throws(() => timeout(s, t), /over/);
  assert.throws(() => retire(s, "B"), /over/);
});

test("a 3-1 series ends after four matches", () => {
  const s = series();
  let t = 0;
  // A wins, B wins, A wins, A wins: A takes the side it plays each match with one more than B.
  for (const winner of ["A", "B", "A", "A"] as const) {
    const m = s.match;
    while (s.match === m && !s.ending) {
      const wSide = sideOf(winner, m), e = s.game.energy;
      const pW = Math.min(3, e[wSide]), pL = Math.min(2, e[wSide === "a" ? "b" : "a"]);
      t = winner === "A" ? play(s, pW, pL, t) : play(s, pL, pW, t);
    }
  }
  assert.deepEqual(s.results.map((r) => r.winner), ["A", "B", "A", "A"]);
  assert.deepEqual(s.ending, { winner: "A", reason: "decided" });
});

test("withholding never pays: a side that committed and doesn't reveal forfeits the match; both missing is void", () => {
  const s = series();
  commit(s, "A", s.match, 1, hashFor(s, "A", 20, 1), 5);
  commit(s, "B", s.match, 1, hashFor(s, "B", 25, 2), 6);
  reveal(s, "B", { pull: 25, nonce: nonce(2) }, 7);
  assert.equal(revealDeadline(s), 126);
  reveal; // A sees B's 25 and withholds its 20.
  assert.throws(() => timeout(s, 126), /still open/);
  timeout(s, 127);
  assert.deepEqual(s.results[0], { winner: "B", reason: "missed_reveal" });
  assert.equal(s.match, 1);
  commit(s, "A", s.match, 1, hashFor(s, "A", 1, 3), 130);
  commit(s, "B", s.match, 1, hashFor(s, "B", 1, 4), 131);
  timeout(s, 131 + 121);
  assert.deepEqual(s.results[1], { winner: null, reason: "void" });
});

test("a commit-phase timeout waits until every side still to commit is past its own deadline (nothing leaks early)", () => {
  const s = series({ A: { kind: "zero" }, B: { kind: "steady", pull: 5 } });
  // Run B's bank down to 5 seconds in match 1: five rounds where B commits a second before the round's end.
  let t = 0;
  for (let r = 0; r < 5; r++) {
    const round = s.game.rounds.length + 1;
    commit(s, "A", s.match, round, hashFor(s, "A", 0, t), t);
    commit(s, "B", s.match, round, hashFor(s, "B", 0, t + 1), t + 119);
    reveal(s, "A", { pull: 0, nonce: nonce(t) }, t + 120);
    reveal(s, "B", { pull: 0, nonce: nonce(t + 1) }, t + 121);
    t += 121;
  }
  assert.equal(s.bank.B, 600 - 5 * 119);
  assert.equal(commitDeadline(s, sideOf("B", 0)), s.phaseOpenedAt + 5, "B's deadline is its bank, not the round");
  // B's time is up, A's isn't: no timeout yet, so nothing says B is on its fallback.
  const late = s.phaseOpenedAt + 5;
  assert.throws(() => timeout(s, late), /still has time/);
  assert.equal(s.round.b.owesFallback, false);
  // A commits; now the timeout applies, charging B its whole remaining bank.
  commit(s, "A", s.match, 6, hashFor(s, "A", 0, 99), late);
  timeout(s, late);
  assert.equal(s.round.b.owesFallback, true);
  assert.equal(s.bank.B, 0);
  assert.equal(s.bankOut.B, true);
});

test("a move must land before its deadline, never on it; a timeout applies on it", () => {
  const s = series();
  const d = commitDeadline(s, "a");
  assert.throws(() => commit(s, "A", s.match, 1, hashFor(s, "A", 1, 1), d), /too late/);
  commit(s, "B", s.match, 1, hashFor(s, "B", 1, 2), d - 1);
  timeout(s, d);
  assert.equal(s.round.a.owesFallback, true);
});

test("a missed commit owes the committed fallback; a wrong one or the wrong kind is refused; once known it plays itself", () => {
  const s = series({ A: { kind: "steady", pull: 4 }, B: { kind: "zero" } });
  commit(s, "B", s.match, 1, hashFor(s, "B", 2, 2), 5);
  timeout(s, 120);
  assert.equal(s.bank.A, DUELS_1.bankSeconds - DUELS_1.roundSeconds, "charged the round's time");
  assert.throws(() => reveal(s, "A", { pull: 4, nonce: nonce(1) }, 121), /owes its fallback/);
  assert.throws(() => reveal(s, "B", { fallback: { kind: "zero" }, salt: SALT.B }, 121), /committed a pull/);
  assert.throws(() => reveal(s, "A", { fallback: { kind: "steady", pull: 9 }, salt: SALT.A }, 121), /isn't the committed fallback/);
  reveal(s, "A", { fallback: { kind: "steady", pull: 4 }, salt: SALT.A }, 122);
  reveal(s, "B", { pull: 2, nonce: nonce(2) }, 123);
  assert.deepEqual(s.game.rounds[0]!.pull, { a: 4, b: 2 });
  // Round 2: A misses again; its fallback is public now, so it plays as soon as the timeout lands, with no reveal.
  commit(s, "B", s.match, 2, hashFor(s, "B", 6, 3), 130);
  timeout(s, 123 + 120);
  assert.equal(s.round.a.pull, fallbackPull({ kind: "steady", pull: 4 }, s.game, "a"));
  reveal(s, "B", { pull: 6, nonce: nonce(3) }, 250);
  assert.deepEqual(s.game.rounds[1]!.pull, { a: 4, b: 6 });
});

test("mirror plays the opponent's last pull, capped by energy, and 0 in a match's first round", () => {
  const s = series({ A: { kind: "zero" }, B: { kind: "mirror" } });
  let t = play(s, 9, 1, 0);
  // B misses round 2: mirror plays A's last pull, 9.
  commit(s, "A", s.match, 2, hashFor(s, "A", 3, t), t);
  timeout(s, t + 120);
  reveal(s, "B", { fallback: { kind: "mirror" }, salt: SALT.B }, t + 121);
  reveal(s, "A", { pull: 3, nonce: nonce(t) }, t + 122);
  assert.deepEqual(s.game.rounds[1]!.pull, { a: 3, b: 9 });
  assert.equal(fallbackPull({ kind: "mirror" }, { ...s.game, rounds: [] }, "b"), 0);
});

test("a bank-out lasts the rest of the series, and both out voids every match after", () => {
  const s = series({ A: { kind: "zero" }, B: { kind: "zero" } });
  let t = 0;
  // Nobody ever commits: each round charges both 120 seconds of a 600-second bank; after five both are out.
  for (let i = 0; i < 5; i++) {
    t = s.phaseOpenedAt + 120;
    timeout(s, t);
    for (const side of ["a", "b"] as const) if (s.phase === "reveal" && s.round[side].pull === null) reveal(s, playerOf(side, s.match), { fallback: { kind: "zero" }, salt: SALT[playerOf(side, s.match)] }, t);
  }
  assert.deepEqual(s.bankOut, { A: true, B: true });
  // Both out: every remaining match is void at once, and the series is a draw.
  assert.deepEqual(s.results.map((r) => r.reason), ["void", "void", "void", "void", "void"]);
  assert.deepEqual(s.ending, { winner: null, reason: "draw" });
});

test("one side out for the rest of the series: its known fallback plays every round in later matches", () => {
  const s = series({ A: { kind: "zero" }, B: { kind: "steady", pull: 1 } });
  let t = 0;
  // Match 1: B never commits; A pulls 1 each round, tying B's fallback, so the match runs long enough to empty B's bank.
  while (s.match === 0) {
    const round = s.game.rounds.length + 1, n = 1000 + round;
    t = s.phaseOpenedAt;
    commit(s, "A", s.match, round, hashFor(s, "A", 1, n), t);
    // Once B's bank is out, its known fallback plays the moment A commits; A then reveals as usual.
    if (s.phase === "reveal" && s.round[sideOf("B", 0)].pull !== null) { reveal(s, "A", { pull: 1, nonce: nonce(n) }, t); continue; }
    t = s.phaseOpenedAt + Math.min(120, s.bank.B);
    timeout(s, t);
    if (s.phase === "reveal" && s.round[sideOf("B", 0)].pull === null) reveal(s, "B", { fallback: { kind: "steady", pull: 1 }, salt: SALT.B }, t);
    if (s.match === 0 && s.phase === "reveal") reveal(s, "A", { pull: 1, nonce: nonce(n) }, t);
  }
  assert.equal(s.bankOut.B, true);
  assert.equal(s.bank.B, 0, "out for the rest of the series");
  // Match 2: B owes its fallback from the start; it plays itself as soon as A commits.
  assert.equal(s.round[sideOf("B", 1)].owesFallback, true);
  commit(s, "A", s.match, 1, hashFor(s, "A", 2, 500), s.phaseOpenedAt + 1);
  assert.equal(s.phase, "reveal");
  assert.equal(s.round[sideOf("B", 1)].pull, 1);
});

test("moves the program refuses", () => {
  const s = series();
  assert.throws(() => commit(s, "A", s.match, 2, "00".repeat(32), 1), /this is round 1/);
  assert.throws(() => commit(s, "A", s.match, 1, "nothex", 1), /32 bytes/);
  assert.throws(() => commit(s, "C" as Player, s.match, 1, "00".repeat(32), 1), /player is/);
  assert.throws(() => reveal(s, "A", { pull: 1, nonce: nonce(1) }, 1), /not a reveal phase/);
  commit(s, "A", s.match, 1, hashFor(s, "A", 31, 1), 1);
  assert.throws(() => commit(s, "A", s.match, 1, "00".repeat(32), 2), /already committed/);
  commit(s, "B", s.match, 1, hashFor(s, "B", 3, 2), 2);
  assert.throws(() => commit(s, "A", s.match, 2, "00".repeat(32), 3), /not a commit phase/);
  assert.throws(() => reveal(s, "A", { pull: 30, nonce: nonce(1) }, 3), /doesn't match/);
  assert.throws(() => reveal(s, "A", { pull: 31, nonce: nonce(1) }, 3), /illegal pull/);
  assert.throws(() => reveal(s, "A", { pull: 31, nonce: nonce(1) }, 1), /clock went backward/);
  assert.throws(() => timeout(s, 1), /clock went backward/);
  assert.throws(() => reveal(s, "B", { pull: 3, nonce: nonce(2) }, 2 + 121), /too late/);
  reveal(s, "B", { pull: 3, nonce: nonce(2) }, 4);
  assert.throws(() => reveal(s, "B", { pull: 3, nonce: nonce(2) }, 5), /already revealed/);
});

test("a commit names its match: a second copy of match 1's round-1 commit can't stand in match 2's round 1", () => {
  // A commit transaction signed twice (a retry with a new blockhash) can land twice. Match 1 ends in its first round
  // (B withholds its reveal), so the next open round is round 1 again, of match 2, when the second copy arrives.
  const s = series();
  const copy = hashFor(s, "A", 3, 1);
  commit(s, "A", 0, 1, copy, 1);
  commit(s, "B", s.match, 1, hashFor(s, "B", 2, 2), 2);
  reveal(s, "A", { pull: 3, nonce: nonce(1) }, 3);
  timeout(s, revealDeadline(s) + 1);
  assert.deepEqual(s.results, [{ winner: "A", reason: "missed_reveal" }]);
  assert.deepEqual([s.match, s.game.rounds.length, s.phase], [1, 0, "commit"]);

  const attempt = (f: () => void) => { try { f(); return "accepted"; } catch (e) { return `refused: ${(e as Error).message}`; } };
  const t = s.phaseOpenedAt;
  const own = hashFor(s, "A", 4, 7);
  const got: Record<string, unknown> = {
    copy: attempt(() => commit(s, "A", 0, 1, copy, t + 1)),
    own: attempt(() => commit(s, "A", s.match, 1, own, t + 2)),
  };
  commit(s, "B", s.match, 1, hashFor(s, "B", 2, 8), t + 3);
  got.reveal = attempt(() => reveal(s, "A", { pull: 4, nonce: nonce(7) }, t + 4));
  reveal(s, "B", { pull: 2, nonce: nonce(8) }, t + 5);
  // Whoever is still to reveal when the window closes forfeits the match.
  if (s.phase === "reveal") timeout(s, revealDeadline(s) + 1);
  got.match2 = s.results[1] ?? "still in play";
  assert.deepEqual(got, { copy: "refused: this is match 2", own: "accepted", reveal: "accepted", match2: "still in play" });
});

test("retiring forfeits the series, in either phase", () => {
  const s = series();
  retire(s, "B");
  assert.deepEqual(s.ending, { winner: "A", reason: "retired" });
  const r = series();
  commit(r, "A", r.match, 1, hashFor(r, "A", 1, 1), 1);
  commit(r, "B", r.match, 1, hashFor(r, "B", 1, 2), 2);
  retire(r, "A");
  assert.deepEqual(r.ending, { winner: "B", reason: "retired" });
});

test("2,000 random series all end, with the invariants holding throughout", () => {
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4294967296) * n);
  };
  for (let i = 0; i < 2000; i++) {
    const kinds: Fallback[] = [{ kind: "zero" }, { kind: "mirror" }, { kind: "steady", pull: rand(8) }];
    const fb: Record<Player, Fallback> = { A: kinds[rand(3)]!, B: kinds[rand(3)]! };
    const s = series(fb);
    const kept: Record<string, number> = {};
    let t = 0, guard = 0, opened = s.phaseOpenedAt;
    while (!s.ending && guard++ < 4000) {
      t += 1 + rand(30);
      try {
        if (s.phase === "commit") {
          const p: Player = rand(2) ? "A" : "B", side = sideOf(p, s.match), round = s.game.rounds.length + 1;
          const pull = rand(s.game.energy[side] + 1);
          if (rand(6)) { commit(s, p, s.match, round, hashFor(s, p, pull, round * 10 + (p === "A" ? 0 : 1)), t); kept[`${s.match}:${round}:${p}`] = pull; }
          else timeout(s, t);
        } else {
          const p: Player = rand(2) ? "A" : "B", side = sideOf(p, s.match), round = s.game.rounds.length + 1;
          if (s.round[side].owesFallback) reveal(s, p, { fallback: fb[p], salt: SALT[p] }, t);
          else if (rand(30)) reveal(s, p, { pull: kept[`${s.match}:${round}:${p}`] ?? 0, nonce: nonce(round * 10 + (p === "A" ? 0 : 1)) }, t);
          else timeout(s, t);
        }
      } catch { /* refusals are fine; the invariants below are what matter */ }
      assert.ok(s.bank.A >= 0 && s.bank.B >= 0);
      assert.ok(s.phaseOpenedAt >= opened, "phases never open in the past");
      opened = s.phaseOpenedAt;
    }
    assert.ok(s.ending, `series ${i} ended`);
    const wins = (p: Player) => s.results.filter((r) => r.winner === p).length;
    if (s.ending.reason === "decided") assert.ok(wins(s.ending.winner!) > wins(s.ending.winner === "A" ? "B" : "A"));
    if (s.ending.reason === "draw") assert.equal(wins("A"), wins("B"));
  }
});
