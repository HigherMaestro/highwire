// The arena's game (docs/arena.md 4): a tug-of-war on the wire. Two sides pull a node along a short wire; each round both
// choose a pull in secret, the bigger pull moves the node one place their way, and both pay what they pulled. Everything
// here is a pure function of the rules and the moves, so the referee, the pages, replays and agents all agree, and an old
// match replays under the rules it was played with.

/** Side "a" pulls toward the negative end, side "b" toward the positive end. */
export type Side = "a" | "b";

export interface ArenaRules {
  /** Stored with every match, so a match always replays under its own rules. */
  id: string;
  /** The node wins at ±places. */
  places: number;
  /** Starting energy, and the most a side can hold. */
  energy: number;
  /** Energy regained at the start of every round after the first, up to `energy`. */
  regen: number;
  /** After this many rounds, the side the node is on wins. */
  rounds: number;
  /** A middle finish: a draw, or a win for the side that spent less in all (a draw if equal). */
  tieBreak: "none" | "spent";
  /** Time each side may take on one round, and in all, before its fallback plays for it. */
  roundSeconds: number;
  bankSeconds: number;
}

/** The first rules: a wire of seven places, 30 energy regaining 2 a round, 15 rounds. Settled by the simulator. */
export const DUELS_1: ArenaRules = {
  id: "duels-1",
  places: 3,
  energy: 30,
  regen: 2,
  rounds: 15,
  tieBreak: "none",
  roundSeconds: 120,
  bankSeconds: 600,
};

export interface RoundResult {
  pull: Record<Side, number>;
  /** Who won the round, or null for a tie. */
  winner: Side | null;
  /** The node after the round. */
  node: number;
}

export type Ending =
  | { winner: Side; reason: "reached_end" | "rounds_up" | "tie_break" | "forfeit" }
  | { winner: null; reason: "draw" | "void" };

export interface MatchState {
  rules: ArenaRules;
  /** Rounds played so far; the next round is `rounds.length + 1`. */
  rounds: RoundResult[];
  /** Where the node is: negative is toward a's end, positive toward b's. */
  node: number;
  /** Energy each side has for the next round. */
  energy: Record<Side, number>;
  /** Energy each side has spent in all. */
  spent: Record<Side, number>;
  /** null while the match is on. */
  ending: Ending | null;
}

export const other = (s: Side): Side => (s === "a" ? "b" : "a");

/** Where the node is from one side's view: positive is toward that side's own end. */
export const nodeFor = (state: Pick<MatchState, "node">, side: Side) => (side === "b" ? state.node : -state.node);

export function startMatch(rules: ArenaRules = DUELS_1): MatchState {
  return { rules, rounds: [], node: 0, energy: { a: rules.energy, b: rules.energy }, spent: { a: 0, b: 0 }, ending: null };
}

/** Why a pull isn't allowed in this state, or null when it is. */
export function pullProblem(state: MatchState, side: Side, pull: unknown): string | null {
  if (state.ending) return "the match is over";
  if (typeof pull !== "number" || !Number.isInteger(pull)) return "a pull is a whole number";
  if (pull < 0) return "a pull can't be negative";
  if (pull > state.energy[side]) return `a pull can't be more than the ${state.energy[side]} energy left`;
  return null;
}

/** The state after one round. Throws on a pull that isn't allowed. */
export function playRound(state: MatchState, pullA: number, pullB: number): MatchState {
  for (const [side, pull] of [["a", pullA], ["b", pullB]] as const) {
    const problem = pullProblem(state, side, pull);
    if (problem) throw new Error(`${side}: ${problem}`);
  }
  const { rules } = state;
  const winner: Side | null = pullA > pullB ? "a" : pullB > pullA ? "b" : null;
  const node = state.node + (winner === "b" ? 1 : winner === "a" ? -1 : 0);
  const rounds = [...state.rounds, { pull: { a: pullA, b: pullB }, winner, node }];
  // Both pay; energy comes back for the next round, up to the cap.
  const energy = { a: Math.min(rules.energy, state.energy.a - pullA + rules.regen), b: Math.min(rules.energy, state.energy.b - pullB + rules.regen) };
  const spent = { a: state.spent.a + pullA, b: state.spent.b + pullB };
  const next: MatchState = { rules, rounds, node, energy, spent, ending: null };
  if (Math.abs(node) >= rules.places) next.ending = { winner: node > 0 ? "b" : "a", reason: "reached_end" };
  else if (rounds.length >= rules.rounds) next.ending = finalWord(next);
  return next;
}

/** The result when the rounds run out with the node short of either end. */
function finalWord(state: MatchState): Ending {
  if (state.node !== 0) return { winner: state.node > 0 ? "b" : "a", reason: "rounds_up" };
  if (state.rules.tieBreak === "spent" && state.spent.a !== state.spent.b) return { winner: state.spent.a < state.spent.b ? "a" : "b", reason: "tie_break" };
  return { winner: null, reason: "draw" };
}

/** A whole match from its rounds' pulls, as stored: a replay, or the referee checking itself. */
export function replay(rules: ArenaRules, pulls: [number, number][]): MatchState {
  let s = startMatch(rules);
  for (const [a, b] of pulls) s = playRound(s, a, b);
  return s;
}

/** A side quits mid-match: a loss for it. */
export function forfeit(state: MatchState, side: Side): MatchState {
  if (state.ending) return state;
  return { ...state, ending: { winner: other(side), reason: "forfeit" } };
}

/** Neither side is there: no result. */
export function voidMatch(state: MatchState): MatchState {
  if (state.ending) return state;
  return { ...state, ending: { winner: null, reason: "void" } };
}

// ---------------------------------------------------------------- fallbacks (docs/arena.md 4.4)

/** What plays for a side that runs out of time: a fixed menu, declared when it joins. */
export type Fallback = { kind: "zero" } | { kind: "steady"; pull: number } | { kind: "mirror" };

export function parseFallback(text: string): Fallback | null {
  if (text === "zero") return { kind: "zero" };
  if (text === "mirror") return { kind: "mirror" };
  const m = /^steady:(\d{1,2})$/.exec(text);
  return m ? { kind: "steady", pull: Number(m[1]) } : null;
}

/** The fallback's pull in this state: always allowed (capped by the side's energy). */
export function fallbackPull(f: Fallback, state: MatchState, side: Side): number {
  const cap = state.energy[side];
  if (f.kind === "zero") return 0;
  if (f.kind === "steady") return Math.min(cap, f.pull);
  const last = state.rounds.at(-1);
  return Math.min(cap, last ? last.pull[other(side)] : 0);
}

// ---------------------------------------------------------------- the chess clock (docs/arena.md 4.1)

export interface ClockCharge {
  /** Seconds left in the side's bank after this round. */
  bank: number;
  /** The fallback plays this round: the side ran out of round time or of bank. */
  fallback: boolean;
  /** The bank is empty: the fallback plays every round from now on. */
  bankOut: boolean;
}

/**
 * Charges a side for one round. `waited` is how long the round waited on that side (time counts only then); the most a
 * round can cost is its round time, and a side whose bank is already empty is charged nothing and falls back.
 */
export function chargeClock(rules: ArenaRules, bank: number, waited: number): ClockCharge {
  if (!(waited >= 0)) throw new Error("waited is a number of seconds, 0 or more");
  if (bank <= 0) return { bank: 0, fallback: true, bankOut: true };
  const cost = Math.min(waited, rules.roundSeconds, bank);
  const left = bank - cost;
  return { bank: left, fallback: waited >= rules.roundSeconds || left <= 0, bankOut: left <= 0 };
}
