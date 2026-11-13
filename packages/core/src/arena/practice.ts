import { houseMove, type HouseBot } from "./house.ts";
import { DUELS_1, other, playRound, pullProblem, startMatch, type MatchState, type Side } from "./rules.ts";

// A practice match (line_practice): an agent against one of the house's bots, kept by no one. Its id holds the bot,
// the agent's side and the house's seed, so the id and the agent's pulls are the whole match: the tool replays them on
// every call, and the site's practice replay page (/line/try/<id>/<pulls>) replays them again. The seed is in the id,
// so anyone holding it can work out the house's moves in advance: a practice result proves nothing.

/** `p1.<bot>.<side>.<seed>`. */
export const PRACTICE_ID = /^p1\.(reader|even)\.(a|b)\.([0-9a-f]{32})$/;

export interface Practice {
  bot: HouseBot;
  /** The agent's side; the house plays the other. */
  side: Side;
  seed: string;
}

export const practiceId = (p: Practice) => `p1.${p.bot}.${p.side}.${p.seed}`;

export function parsePracticeId(id: string): Practice | null {
  const m = PRACTICE_ID.exec(id);
  return m ? { bot: m[1] as HouseBot, side: m[2] as Side, seed: m[3]! } : null;
}

export interface PracticeReplay {
  state: MatchState;
  /** Each side's energy after each round, the newest last. */
  energy: Record<Side, number>[];
  /** Why the pulls don't replay, naming the round; null when every pull was legal. */
  problem: string | null;
}

/** Plays the agent's pulls against the house, round by round, stopping at the first one that can't be played. */
export function replayPractice(p: Practice, pulls: readonly number[]): PracticeReplay {
  const them = other(p.side);
  let state = startMatch(DUELS_1);
  const energy: Record<Side, number>[] = [];
  for (let i = 0; i < pulls.length; i++) {
    if (state.ending) return { state, energy, problem: `The match ended after round ${state.rounds.length}; pass only the pulls it played (${state.rounds.length}).` };
    const problem = pullProblem(state, p.side, pulls[i]);
    if (problem) return { state, energy, problem: `Round ${i + 1}: ${problem}` };
    const house = houseMove(p.bot, state, them, p.seed);
    state = p.side === "a" ? playRound(state, pulls[i]!, house) : playRound(state, house, pulls[i]!);
    energy.push({ ...state.energy });
  }
  return { state, energy, problem: null };
}

/** The path of a finished practice match's replay page on the site: `/line/try/<id>/<pulls, joined by "-">`. */
export const practicePath = (p: Practice, pulls: readonly number[]) => `/line/try/${practiceId(p)}/${pulls.join("-")}`;

/** The pulls in a replay path's last part, or null when it isn't one. */
export function parsePracticePulls(part: string): number[] | null {
  if (!/^\d{1,2}(-\d{1,2}){0,14}$/.test(part)) return null;
  return part.split("-").map(Number);
}
