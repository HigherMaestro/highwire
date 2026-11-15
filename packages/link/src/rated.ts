import { createHash, randomBytes } from "node:crypto";
import { type Action, BattleError, type Legal, type Outcome } from "./battle.ts";
import type { GameData } from "./data.ts";
import { LinkMatch, type MatchState, watch } from "./match.ts";
import { TURN_CAP, type Labels } from "./practice.ts";
import type { FilmJob } from "./record.ts";
import type { Side } from "./rig.ts";
import { DICE_LENGTH } from "./yellow.ts";
import { narrate, type PlayerView, type SideFacts, type SpectatorView } from "./view.ts";

// A rated link battle as the engine plays it (docs/link-battles.md 4.2, 8.2): two sides, each an agent or the house,
// started from the bootstrap and then resolved a turn at a time from the decisions the referee holds. Each step plays
// the turn and on through any turn nobody is asked about (both locked in, or only the house asked), and returns what the
// referee needs for the next: both sides' views, the spectators', who is asked, each asked side's fallback for this
// turn and the house's decision. The referee keeps the decisions until the turn resolves and never serves them.

/** What a side declares at join, for the turns it misses (4.2). */
export type FallbackKind = "first" | "strongest" | "random";
export const FALLBACKS: readonly FallbackKind[] = ["first", "strongest", "random"];

/** Each side: an agent with its fallback, or the house. `seed` makes `random` fallbacks the match's own. */
export interface RatedSides {
  kinds: [{ house: true } | { house: false; fallback: FallbackKind }, { house: true } | { house: false; fallback: FallbackKind }];
  seed: string;
}

export interface RatedStep {
  state: MatchState;
  /** The packed battle at the next decision; null once it's over. */
  packed: Uint8Array | null;
  turn: number;
  /** Which sides are asked at this decision point. */
  asked: [boolean, boolean];
  /** Each side's own view (6.1): served only to that side. */
  views: [PlayerView, PlayerView];
  spectator: SpectatorView | null;
  /** Each asked agent's fallback for this decision point: held by the referee, never served. */
  fallbacks: [Action | null, Action | null];
  /** The house's decision for this point, made from its own side's facts when the turn opens. */
  house: [Action | null, Action | null];
  /** Turns where somebody chose (the cap counts these, 4.2). */
  chosen: number;
  ended: null | { reason: "knockout" | "draw" | "void"; winner: Side | null; message?: string };
  /** The turns this step played, to film after the answer; the opening's too, on a start. */
  film: FilmJob[];
}

/** How long one step plays turns nobody is asked about before handing back (the referee resolves again). */
const STEP_MS = 20_000;
const dice = () => new Uint8Array(randomBytes(DICE_LENGTH));
const chosenTurns = (state: MatchState) => state.turns.filter((t) => t.decisions.some((d) => d !== null)).length;

/**
 * A side's fallback for a decision point: a forced switch sends the first Pokémon still standing; FIGHT that goes
 * straight on is FIGHT; otherwise `first` is the first usable move, `strongest` the most powerful (power read from the
 * game), `random` a move chosen by the match's seed and the turn. No usable move at all: the first switch.
 */
export function fallbackAction(legal: Legal, facts: SideFacts, data: GameData, kind: FallbackKind, seed: string, turn: number, side: Side): Action {
  if (legal.kind === "forced") return { kind: "switch", to: legal.switches[0]! };
  if (legal.fight) return { kind: "fight" };
  if (!legal.moves.length) return { kind: "switch", to: legal.switches[0]! };
  if (kind === "strongest") {
    const power = (slot: number) => data.move(facts.mineMoves[slot] ?? 0)?.power ?? 0;
    const best = [...legal.moves].sort((a, b) => power(b) - power(a) || a - b)[0]!;
    return { kind: "move", slot: best };
  }
  if (kind === "random") {
    const h = createHash("sha256").update(`${seed}:${turn}:${side}`).digest();
    return { kind: "move", slot: legal.moves[h.readUInt32BE(0) % legal.moves.length]! };
  }
  return { kind: "move", slot: legal.moves[0]! };
}

function ended(state: MatchState): RatedStep["ended"] {
  if (state.void) return { reason: "void", winner: null, message: state.void.message };
  const o: Outcome | null = state.outcome;
  if (!o) return null;
  return { reason: o.winner === null ? "draw" : "knockout", winner: o.winner };
}

/** The step at the match's decision point: views, who's asked, fallbacks and the house's choice. */
function stepAt(match: LinkMatch, state: MatchState, packed: Uint8Array | null, sides: RatedSides, labels: Labels, since: number, film: FilmJob[]): RatedStep {
  const live = packed ? match : undefined;
  const told = state.turns.filter((t) => t.turn > since);
  const views = ([0, 1] as const).map((side) => {
    const v = match.view(side, state);
    v.last_turn = told.flatMap((t) => [...(told.length > 1 ? [`Turn ${t.turn}:`] : []), ...narrate(t, match.data, (s) => (s === side ? "Your" : "Their"))]);
    return v;
  }) as [PlayerView, PlayerView];
  const asked: [boolean, boolean] = packed ? [match.asked(0), match.asked(1)] : [false, false];
  const fallbacks: [Action | null, Action | null] = [null, null];
  const house: [Action | null, Action | null] = [null, null];
  for (const side of [0, 1] as const) {
    if (!asked[side]) continue;
    const k = sides.kinds[side];
    if (k.house) house[side] = match.house(side);
    else fallbacks[side] = fallbackAction(match.legal(side)!, match.facts(side), match.data, k.fallback, sides.seed, state.turn + 1, side);
  }
  return { state, packed, turn: state.turn, asked, views, spectator: watch(state, match.data, labels, live), fallbacks, house, chosen: chosenTurns(state), ended: ended(state), film };
}

/**
 * Plays turns nobody but the house is asked about, until an agent is asked, the battle ends, the cap is reached or the
 * step's time is up, then builds the step.
 */
async function settle(rom: Uint8Array, match: LinkMatch, state: MatchState, packed: Uint8Array | null, sides: RatedSides, labels: Labels, since: number, film: FilmJob[]): Promise<RatedStep> {
  const until = performance.now() + STEP_MS;
  const agentAsked = (m: LinkMatch) => ([0, 1] as const).some((s) => !sides.kinds[s].house && m.asked(s));
  while (packed && !agentAsked(match) && performance.now() < until) {
    const decisions: [Action | null, Action | null] = [null, null];
    for (const s of [0, 1] as const) if (match.asked(s)) decisions[s] = match.house(s);
    const d = dice();
    const r = match.play(decisions, d);
    if (r.turn) film = [...film, { turn: r.turn.turn, before: packed, decisions, dice: [...d], events: JSON.stringify(r.turn.events) }];
    state = r.state;
    packed = r.packed;
    if (packed) match = await LinkMatch.open(rom, state, packed);
  }
  if (packed && !state.outcome && !state.void && chosenTurns(state) >= TURN_CAP) {
    state = { ...state, outcome: { winner: null, reason: "draw" }, final: match.facts(0) };
    packed = null;
  }
  return stepAt(match, state, packed, sides, labels, since, film);
}

/** Starts a rated match from the bootstrap, with the trainers' names written in (trainers.ts). */
export async function ratedStart(rom: Uint8Array, bootstrap: [Uint8Array, Uint8Array], sides: RatedSides, labels: Labels, trainers?: readonly [string, string]): Promise<RatedStep> {
  const { match, packed } = await LinkMatch.start(rom, bootstrap, trainers);
  const opening: FilmJob = { turn: 0, before: null, decisions: [null, null], dice: [], events: "", ...(trainers ? { trainers } : {}) };
  return settle(rom, match, match.state, packed, sides, labels, 0, [opening]);
}

/**
 * Resolves the turn open at `packed` with each asked side's decision (the referee's: an agent's own, its fallback, or
 * the house's), and on to the next point an agent is asked. With no side asked (a step that ran out of time), goes on.
 * An action the game won't take throws BattleError "illegal" (the referee only holds legal ones).
 */
export async function ratedResolve(rom: Uint8Array, state: MatchState, packed: Uint8Array, decisions: [Action | null, Action | null], sides: RatedSides, labels: Labels): Promise<RatedStep> {
  const match = await LinkMatch.open(rom, state, packed);
  const asked: [boolean, boolean] = [match.asked(0), match.asked(1)];
  if (!asked[0] && !asked[1]) return settle(rom, match, state, packed, sides, labels, state.turn, []);
  for (const s of [0, 1] as const) {
    if (asked[s] !== Boolean(decisions[s])) throw new BattleError("illegal", `Side ${s} ${asked[s] ? "must decide" : "isn't asked"} this turn.`);
  }
  const d = dice();
  const r = match.play(decisions, d);
  const film: FilmJob[] = r.turn ? [{ turn: r.turn.turn, before: packed, decisions, dice: [...d], events: JSON.stringify(r.turn.events) }] : [];
  const next = r.packed ? await LinkMatch.open(rom, r.state, r.packed) : match;
  return settle(rom, next, r.state, r.packed, sides, labels, state.turn, film);
}

/** Whether `action` is one of `legal`'s (the referee's check before it holds a decision). */
export function isLegal(legal: Legal | null, action: Action): boolean {
  if (!legal) return false;
  if (action.kind === "switch") return legal.switches.includes(action.to);
  return legal.kind === "turn" && (action.kind === "fight" ? legal.fight : legal.moves.includes(action.slot));
}
