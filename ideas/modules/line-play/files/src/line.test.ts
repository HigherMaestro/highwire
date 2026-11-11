import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DUELS_1, houseMove, playRound, startMatch, type MatchState } from "highwire-core/arena";
import { checkProblems, choosePull, playMatch, RevealCheckFailed, stateOf, talk, type LineSettings, type MatchView } from "./line.ts";

const settings: LineSettings = { opponent: "agent", fallback: "mirror", matches_per_day: 4, strategy: "reader", talk: true, talk_chance: 0.3, lines: ["hi"] };

function view(m: MatchState, side: "a" | "b"): MatchView {
  const them = side === "a" ? "b" : "a";
  return {
    match: "t",
    round: m.rounds.length + 1,
    you: { side, name: "me" },
    opponent: { kind: "house", name: "Reader" },
    energy: { you: m.energy[side], them: m.energy[them] },
    node: side === "b" ? m.node : -m.node,
    rounds: m.rounds.map((r, i) => ({ round: i + 1, you: r.pull[side], them: r.pull[them], won: "tie", node: r.node })),
    ending: null,
    checks: { your_moves_verified: 0, problems: [] },
  };
}

test("the view rebuilds the game exactly, from either side", () => {
  let m = startMatch(DUELS_1);
  m = playRound(m, 7, 3);
  m = playRound(m, 2, 9);
  for (const side of ["a", "b"] as const) assert.deepEqual(stateOf(view(m, side)), m);
});

test("every pull it chooses is legal, through whole matches against the house", () => {
  for (let i = 0; i < 50; i++) {
    let m = startMatch(DUELS_1);
    while (!m.ending) {
      const p = choosePull(view(m, "a"), "reader", `s${i}`);
      assert.ok(Number.isInteger(p) && p >= 0 && p <= m.energy.a, `pull ${p} with ${m.energy.a} energy`);
      m = playRound(m, p, houseMove("even", m, "b", `h${i}`));
    }
  }
});

test("table talk: only sometimes, only its own lines, never when it's off", () => {
  assert.equal(talk({ ...settings, talk: false }, () => 0), "");
  assert.equal(talk(settings, () => 0.9), "");
  assert.equal(talk(settings, () => 0.1), "hi");
});

/** A tiny referee behind the line_* tools: one match against a house bot, a queue that answers "waiting" once. */
function fakeReferee(opts: { lateOnce?: boolean } = {}) {
  let m = startMatch(DUELS_1);
  let joins = 0;
  let lateOnce = opts.lateOnce ?? false;
  const calls: string[] = [];
  const shown = (): MatchView => ({ ...view(m, "a"), match: "m1", round: m.ending ? null : m.rounds.length + 1, ending: m.ending ? { result: m.ending.winner === "a" ? "win" : m.ending.winner === null ? "draw" : "loss", reason: m.ending.reason } : null });
  const call = async (name: string, args: Record<string, unknown>) => {
    calls.push(name);
    if (name === "line_join") return ++joins === 1 ? { ok: true, body: { waiting: true } } : { ok: true, body: shown() };
    if (name === "line_state") return { ok: true, body: shown() };
    if (name === "line_move") {
      if (lateOnce) {
        lateOnce = false;
        m = playRound(m, 0, houseMove("even", m, "b", "x")); // the round timed out: the fallback played
        return { ok: false, body: { error: "late", code: "line_late" } };
      }
      assert.equal(args.round, m.rounds.length + 1);
      m = playRound(m, args.pull as number, houseMove("even", m, "b", "x"));
      return { ok: true, body: shown() };
    }
    throw new Error(name);
  };
  return { call, calls };
}

test("a match from the queue to the end: it waits, moves every round, recovers from a late round, and logs the result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "line-play-"));
  const ref = fakeReferee({ lateOnce: true });
  const lines: string[] = [];
  const v = await playMatch(ref, settings, (l) => lines.push(l), dir);
  assert.ok(v?.ending, "it played to the end");
  assert.equal(ref.calls.filter((c) => c === "line_join").length, 2, "called again after waiting");
  assert.ok(ref.calls.includes("line_state"), "looked again after the late round");
  const [file] = readdirSync(dir);
  assert.match(readFileSync(join(dir, file!), "utf8"), /^- .* against Reader .* · https:\/\/highwire\.fun\/line\/match\/m1/m);
  assert.ok(lines.some((l) => /^Playing Reader/.test(l)));
});

test("a failed check is a problem to stop on: the referee's record of a move, or the house's seed", () => {
  const base = { ...view(startMatch(DUELS_1), "a"), match: "m1" };
  assert.deepEqual(checkProblems(base), []);
  assert.deepEqual(checkProblems({ ...base, checks: { your_moves_verified: 3, problems: [], house: "verified: fine" } }), []);
  assert.deepEqual(checkProblems({ ...base, checks: { your_moves_verified: 2, problems: ["round 3: recorded 4, sent 5"] } }), ["round 3: recorded 4, sent 5"]);
  assert.equal(checkProblems({ ...base, checks: { your_moves_verified: 3, problems: [], house: "FAILED: the seed" } }).length, 1);
  assert.match(new RevealCheckFailed("m1", ["x"]).message, /m1: x .*line\/match\/m1/);
});
