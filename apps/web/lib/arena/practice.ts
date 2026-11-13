import { parsePracticeId, parsePracticePulls, practicePath, replayPractice, type Practice } from "highwire-core/arena";
import type { ArenaMatch } from "./data.ts";

// A finished practice match (line_practice) for its replay page, /line/try/<id>/<pulls>: rebuilt from the link alone by
// the same code the tool runs, so the page keeps nothing and asks no one. Only a finished match whose every pull was
// legal gets a page. The agent has no name here (practice has no fighter): it's "The agent".

export const AGENT = "The agent";
export const botName = (p: Practice) => (p.bot === "reader" ? "Reader" : "Even");

export interface PracticeMatch {
  practice: Practice;
  pulls: number[];
  path: string;
  match: ArenaMatch;
}

export function practiceMatch(id: string, pullsPart: string): PracticeMatch | null {
  const practice = parsePracticeId(decodeURIComponent(id));
  const pulls = parsePracticePulls(pullsPart);
  if (!practice || !pulls) return null;
  const { state, energy, problem } = replayPractice(practice, pulls);
  if (problem || !state.ending || state.rounds.length !== pulls.length) return null;
  const house = practice.side === "a" ? "b" : "a";
  const side = (s: "a" | "b") =>
    s === house ? { kind: "house" as const, id: `house:${practice.bot}`, name: botName(practice), bank: 0 } : { kind: "fighter" as const, id: "practice", name: AGENT, bank: 0 };
  const reveal = (pull: number) => ({ pull, nonce: "", line: "", arrivedMs: 0, fallback: false, commitment: "" });
  const match: ArenaMatch = {
    id: `${practice.bot}.${practice.side}.${practice.seed}`,
    rules: state.rules.id,
    sides: { a: side("a"), b: side("b") },
    round: null,
    node: state.node,
    energy: state.energy,
    spent: state.spent,
    rounds: state.rounds.map((r, i) => ({ round: i + 1, openedAt: 0, a: reveal(r.pull.a), b: reveal(r.pull.b), winner: r.winner, node: r.node, energy: energy[i]! })),
    house: { bot: practice.bot, side: house, seedCommitment: "", seed: practice.seed },
    ending: state.ending,
    endedAt: null,
  };
  return { practice, pulls, path: practicePath(practice, pulls), match };
}
