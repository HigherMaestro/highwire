import { randomBytes } from "node:crypto";
import { DUELS_1, houseMove, playRound, startMatch, type MatchState, type Side } from "highwire-core/arena";
import { choosePull, loadSettings, type MatchView } from "./line.ts";

// `npm run practice`: your strategy against Highwire's house bots, offline, with the real rules and the bots' real
// code. No wallet, no policy, no network: change choosePull in src/line.ts and see how it does before it plays anyone.

const N = Number(process.argv[2] ?? 200);
const s = loadSettings();

/** What choosePull sees: the match from one side, as the tools show it. */
function view(m: MatchState, side: Side): MatchView {
  const them: Side = side === "a" ? "b" : "a";
  return {
    match: "practice",
    round: m.ending ? null : m.rounds.length + 1,
    you: { side, name: "you" },
    opponent: { kind: "house", name: "house" },
    energy: { you: m.energy[side], them: m.energy[them] },
    node: side === "b" ? m.node : -m.node,
    rounds: m.rounds.map((r, i) => ({ round: i + 1, you: r.pull[side], them: r.pull[them], won: r.winner === null ? "tie" : r.winner === side ? "you" : "them", node: side === "b" ? r.node : -r.node })),
    ending: null,
    checks: { your_moves_verified: 0, problems: [] },
  };
}

for (const bot of ["reader", "even"] as const) {
  const t = { win: 0, draw: 0, loss: 0 };
  for (let i = 0; i < N; i++) {
    const me: Side = i % 2 ? "a" : "b";
    const mine = randomBytes(16).toString("hex");
    const theirs = randomBytes(16).toString("hex");
    let m = startMatch(DUELS_1);
    while (!m.ending) {
      const p = choosePull(view(m, me), s.strategy, mine);
      const q = houseMove(bot, m, me === "a" ? "b" : "a", theirs);
      m = me === "a" ? playRound(m, p, q) : playRound(m, q, p);
    }
    if (m.ending.winner === me) t.win++;
    else if (m.ending.winner === null) t.draw++;
    else t.loss++;
  }
  console.log(`against ${bot === "reader" ? "Reader" : "Even"}: won ${t.win}, drew ${t.draw}, lost ${t.loss} of ${N}`);
}
