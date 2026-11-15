import { type Action, Battle, BattleError, type Legal, type Outcome, type Phase } from "./battle.ts";
import { type GameData, gameData } from "./data.ts";
import { houseChoice } from "./house.ts";
import { Rig, type Side } from "./rig.ts";
import { FORMAT, pack, RIG_VERSION, unpack } from "./state.ts";
import { checkGame, DICE_LENGTH, party, snapshot, ADDR } from "./yellow.ts";
import { writeTrainers } from "./trainers.ts";
import { playerView, spectatorView, type PlayerView, type SideFacts, type SpectatorView, type Turn, viewPhase } from "./view.ts";

// A link battle as the referee runs it (docs/link-battles.md 8.2): started from a bootstrap, then, a turn at a time,
// opened from its packed state, played, and packed again, so nothing depends on memory surviving between requests. The
// store, the clocks, pairing and ratings are the referee's (packages/relay); this is only the battle.

/** What the referee keeps about a match beside its packed state: small, so long-polls read only this. */
export interface MatchState {
  format: string;
  version: string;
  turn: number;
  /** Each game's phase at the current decision point. */
  phases: [Phase, Phase];
  /** The species each side opened with. */
  opening: [number, number];
  turns: Turn[];
  outcome: Outcome | null;
  /** Why the battle stopped without an outcome: a stuck rig or a desync voids it (4.3). */
  void?: { kind: string; message: string };
  /** Game 0's facts when the battle ended, for the finished replay's exact numbers. */
  final?: SideFacts;
}

let cachedData: { rom: Uint8Array; data: GameData } | null = null;
const dataFor = (rom: Uint8Array) => (cachedData?.rom === rom ? cachedData.data : (cachedData = { rom, data: gameData(rom) }).data);

/** Reads what one side's own game holds (view.ts builds its view from this and nothing else). */
function factsOf(rig: Rig, side: Side): SideFacts {
  const s = snapshot(rig, side);
  return { team: party(rig, side), out: rig.read(side, ADDR.playerMonNumber), mine: s.mine, theirs: s.theirs, mineMoves: s.myMoves, mineMovePP: s.myPP };
}

export class LinkMatch {
  private constructor(
    private readonly rig: Rig,
    private readonly battle: Battle,
    readonly state: MatchState,
    readonly data: GameData,
  ) {}

  /**
   * Starts a match from a bootstrap: both games saved at the battle's first menu (7.4). `trainers` are the names the
   * games show for each side (trainers.ts); without them the bootstrap's own stay.
   */
  static async start(rom: Uint8Array, bootstrap: [Uint8Array, Uint8Array], trainers?: readonly [string, string]): Promise<{ match: LinkMatch; packed: Uint8Array }> {
    checkGame(rom);
    const rig = await Rig.create(rom);
    rig.loadState(0, bootstrap[0]);
    rig.loadState(1, bootstrap[1]);
    if (trainers) writeTrainers(rig, trainers);
    const battle = new Battle(rig);
    if (battle.runToDecision()) throw new Error("The bootstrap ended before its first decision.");
    const s = snapshot(rig, 0);
    const state: MatchState = { format: FORMAT, version: RIG_VERSION, turn: 0, phases: [battle.phase(0), battle.phase(1)], opening: [s.mine.species, s.theirs.species], turns: [], outcome: null };
    return { match: new LinkMatch(rig, battle, state, dataFor(rom)), packed: pack(rig, battle) };
  }

  /** Opens a match at its decision point, from its state and packed battle. */
  static async open(rom: Uint8Array, state: MatchState, packed: Uint8Array): Promise<LinkMatch> {
    if (state.outcome || state.void) throw new Error("This match is over.");
    if (state.version !== RIG_VERSION) throw new Error(`This match was started by another version of the rig (${state.version}).`);
    const rig = await Rig.create(rom);
    const { battle } = unpack(rig, packed);
    return new LinkMatch(rig, battle, state, dataFor(rom));
  }

  /** Whether `side` has a decision to make this turn. */
  asked(side: Side): boolean {
    return this.battle.asked(side);
  }

  legal(side: Side): Legal | null {
    return this.battle.legal(side);
  }

  facts(side: Side): SideFacts {
    return factsOf(this.rig, side);
  }

  /** The house's decision for `side`, from that side's own facts (9). */
  house(side: Side): Action | null {
    const legal = this.legal(side);
    return legal ? houseChoice(legal, this.facts(side), this.data) : null;
  }

  /** One side's view, of this match's state or of a later one (its battle's last turn, once it's over). */
  view(side: Side, state: MatchState = this.state): PlayerView {
    const over = Boolean(state.outcome || state.void);
    return playerView({ side, phase: viewPhase(this.battle.phase(side), over), turn: state.turn, facts: this.facts(side), legal: over ? null : this.legal(side), turns: state.turns, opening: state.opening, names: this.data });
  }

  /**
   * Plays one turn: the decisions of the sides asked (null for a side that isn't) and ten fresh bytes of dice. Returns
   * the new state and, unless the battle is over, its packed battle. A stuck rig or a desync voids the match (4.3).
   */
  play(decisions: [Action | null, Action | null], dice: Uint8Array): { state: MatchState; packed: Uint8Array | null; turn: Turn | null } {
    if (dice.length !== DICE_LENGTH) throw new Error(`The dice are ${DICE_LENGTH} bytes.`);
    const s = this.state;
    try {
      const { record, outcome } = this.battle.play(decisions, dice);
      const turn: Turn = { turn: record.turn, decisions: record.decisions, events: record.events, sides: record.sides };
      const turns = [...s.turns, turn];
      if (outcome) return { state: { ...s, turn: record.turn, turns, outcome, final: factsOf(this.rig, 0) }, packed: null, turn };
      const state: MatchState = { ...s, turn: record.turn, turns, phases: [this.battle.phase(0), this.battle.phase(1)] };
      return { state, packed: pack(this.rig, this.battle), turn };
    } catch (error) {
      if (!(error instanceof BattleError) || error.kind === "illegal") throw error;
      // The battle as it stood, so its page keeps the stage and every turn.
      return { state: { ...s, void: { kind: error.kind, message: error.message }, final: factsOf(this.rig, 0) }, packed: null, turn: null };
    }
  }
}

/** The spectators' view of a match from its state alone when it's over, or with the open match while it's live. */
export function watch(state: MatchState, data: GameData, labels: [string, string], live?: LinkMatch): SpectatorView | null {
  const facts0 = live ? live.facts(0) : state.final;
  if (!facts0) return null;
  return spectatorView({ live: Boolean(live), turn: state.turn, facts0, turns: state.turns, opening: state.opening, names: data, labels });
}
