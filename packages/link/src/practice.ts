import { randomBytes } from "node:crypto";
import { type Action, BattleError, type Outcome } from "./battle.ts";
import { LinkMatch, type MatchState, watch } from "./match.ts";
import type { FilmJob } from "./record.ts";
import type { Side } from "./rig.ts";
import { BANNED_MOVES, DICE_LENGTH } from "./yellow.ts";
import { narrate, type PlayerView, type SpectatorView } from "./view.ts";
import { FORMAT } from "./state.ts";

// Practice against the house (docs/link-battles.md 6, 9), as whole steps: start a battle, or play the agent's move and
// the house's through to the agent's next decision. Each step opens the battle from its stored state and returns the new
// one, so the referee keeps nothing in memory, and a step is the unit the host runs one at a time (the emulator is one
// per process). Turns where the agent isn't asked (its Pokémon recharging, say) are played for it, with the house's
// decision only, until it is asked or the battle ends.

export interface PracticeStep {
  state: MatchState;
  /** The packed battle at the agent's next decision; null once it's over. */
  packed: Uint8Array | null;
  view: PlayerView;
  spectator: SpectatorView | null;
  turn: number;
  ended: null | { reason: "knockout" | "draw" | "void"; winner: "you" | "house" | null; message?: string };
  /** The turns this step played, to film after the answer (record.ts); the opening's too, on a start. */
  film: FilmJob[];
}

/** A side's labels for narration: the house's and the fighter's names. */
export type Labels = [string, string];

const dice = () => new Uint8Array(randomBytes(DICE_LENGTH));
/** The turn cap (4.2): turns where somebody chose, so forced replacements count and locked-in turns don't. */
export const TURN_CAP = 60;
/** How long one step plays turns the agent isn't asked about before handing back (the next call continues). */
const STEP_MS = 20_000;

/** A turn just played, as a film job: from the battle before it, with its decisions and dice. */
function job(before: Uint8Array, decisions: [Action | null, Action | null], dice: Uint8Array, r: ReturnType<LinkMatch["play"]>): FilmJob[] {
  return r.turn ? [{ turn: r.turn.turn, before, decisions, dice: [...dice], events: JSON.stringify(r.turn.events) }] : [];
}

const chosenTurns = (state: MatchState) => state.turns.filter((t) => t.decisions.some((d) => d !== null)).length;

function ended(state: MatchState, agent: Side): PracticeStep["ended"] {
  if (state.void) return { reason: "void", winner: null, message: state.void.message };
  const o: Outcome | null = state.outcome;
  if (!o) return null;
  if (o.winner === null) return { reason: "draw", winner: null };
  return { reason: "knockout", winner: o.winner === agent ? "you" : "house" };
}

/**
 * Plays turns the agent isn't asked about (the house's alone, or nobody's) until it is, the battle ends or the step's
 * time is up, then builds the step. Every turn since the agent's last decision is told in its view.
 */
async function settle(rom: Uint8Array, match: LinkMatch, state: MatchState, packed: Uint8Array | null, agent: Side, labels: Labels, since: number, film: FilmJob[]): Promise<PracticeStep> {
  const house = (1 - agent) as Side;
  const until = performance.now() + STEP_MS;
  while (packed && !match.asked(agent) && performance.now() < until) {
    const decisions: [Action | null, Action | null] = [null, null];
    decisions[house] = match.asked(house) ? match.house(house) : null;
    const d = dice();
    const r = match.play(decisions, d);
    film = [...film, ...job(packed, decisions, d, r)];
    state = r.state;
    packed = r.packed;
    if (packed) match = await LinkMatch.open(rom, state, packed);
  }
  if (packed && !ended(state, agent) && chosenTurns(state) >= TURN_CAP) {
    state = { ...state, outcome: { winner: null, reason: "draw" }, final: match.facts(0) };
    packed = null;
  }
  const live = packed ? match : undefined;
  const view = match.view(agent, state);
  const told = state.turns.filter((t) => t.turn > since);
  view.last_turn = told.flatMap((t) => [...(told.length > 1 ? [`Turn ${t.turn}:`] : []), ...narrate(t, match.data, (s) => (s === agent ? "Your" : "Their"))]);
  return { state, packed, view, spectator: watch(state, match.data, labels, live), turn: state.turn, ended: ended(state, agent), film };
}

/** Starts a practice. `trainers` are the names the games show for each side (the fighter's ticker, and the house). */
export async function practiceStart(rom: Uint8Array, bootstrap: [Uint8Array, Uint8Array], agent: Side, labels: Labels, trainers?: readonly [string, string]): Promise<PracticeStep> {
  const { match, packed } = await LinkMatch.start(rom, bootstrap, trainers);
  const opening: FilmJob = { turn: 0, before: null, decisions: [null, null], dice: [], events: "", ...(trainers ? { trainers } : {}) };
  return settle(rom, match, match.state, packed, agent, labels, 0, [opening]);
}

/**
 * The agent's move, the house's, and on to the agent's next decision. With no action, continues a battle where the agent
 * isn't asked (a step that ran out of time). An illegal move, or a missing one, throws BattleError "illegal".
 */
export async function practiceMove(rom: Uint8Array, state: MatchState, packed: Uint8Array, agent: Side, action: Action | null, labels: Labels): Promise<PracticeStep> {
  const match = await LinkMatch.open(rom, state, packed);
  if (!match.asked(agent)) {
    if (action) throw new BattleError("illegal", "It isn't your turn to choose; call with no action to let the battle go on.");
    return settle(rom, match, state, packed, agent, labels, state.turn, []);
  }
  if (!action) throw new BattleError("illegal", "Choose one of the legal actions in your view.");
  const legal = match.legal(agent);
  const ok =
    legal &&
    (action.kind === "switch"
      ? legal.switches.includes(action.to)
      : legal.kind === "turn" && (action.kind === "fight" ? legal.fight : legal.moves.includes(action.slot)));
  if (!ok) throw new BattleError("illegal", "That action isn't one of the legal actions in your view.");
  const house = (1 - agent) as Side;
  const decisions: [Action | null, Action | null] = [null, null];
  decisions[agent] = action;
  decisions[house] = match.asked(house) ? match.house(house) : null;
  const d = dice();
  const r = match.play(decisions, d);
  const next = r.packed ? await LinkMatch.open(rom, r.state, r.packed) : match;
  return settle(rom, next, r.state, r.packed, agent, labels, state.turn, job(packed, decisions, d, r));
}

/** The rules, for link_rules (6): the format, the actions, what's banned and how practice works. */
export function linkRules() {
  return {
    format: FORMAT,
    game: "A real Game Boy link battle, run by Highwire's referee on two emulated Game Boys joined by an emulated link cable.",
    actions: {
      move: "{ kind: \"move\", slot } uses the move in that slot (0 to 3) of your Pokémon that's out.",
      fight: "{ kind: \"fight\" } when FIGHT goes straight on and the game picks the move: Struggle, or a Pokémon asleep, frozen, or locked into a move.",
      switch: "{ kind: \"switch\", to } sends out that party place (0 to 5) instead. After a faint it's the only action.",
    },
    legal: "Every view lists the legal actions, read from the game itself. Anything else is refused.",
    banned_moves: [...BANNED_MOVES.values()],
    banned_why: "They desync link battles in the original game, so they're never legal while anything else is.",
    hidden: "You see what your own screen shows: your team in full, the other side's Pokémon out with its HP as a bar, what it has shown, and the moves it has used.",
    dice: "Fresh random dice are dealt into both games every turn, so nothing you see predicts the next roll.",
    team: "Both sides have the same three Pokémon at level 50: Charizard, Blastoise and Venusaur, with fixed moves.",
    cap: `After ${TURN_CAP} turns where somebody chose, the battle is a draw.`,
    practice: "link_practice plays Highwire's house fighter: it picks the move with the best expected damage and switches out of bad matches. Unrated, one at a time, kept for an hour after your last move. Send the `turn` from the view you're answering with each action; when the view says waiting, call with no action and the battle goes on.",
  };
}
