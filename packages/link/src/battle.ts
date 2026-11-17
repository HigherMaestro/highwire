import type { Key, Rig, Side, Stop } from "./rig.ts";
import {
  ADDR,
  BANNED_MOVES,
  BATTLE_STATUS1,
  CODE,
  dealDice,
  disagreements,
  PARTY_MON,
  party,
  snapshot,
  STATUS,
  type Field,
  type Mon,
  type Snapshot,
} from "./yellow.ts";

// A whole link battle on the rig (docs/link-battles.md 7.2, 7.3, 4.4): where each game is, which actions are legal,
// the buttons that make a decision, and the record of each turn as both games show it. Everything is read from the
// games' own code and memory: the rig watches the CPU execute the game's menu, link exchange and battle routines
// (CODE), so a decision point is the game itself waiting, never a guess from timing or the screen.

/** What one game is doing, judged over the last frame. */
export type Phase =
  /** The FIGHT / PKMN / ITEM / RUN menu, waiting for a button. */
  | "menu"
  /** The move list. */
  | "moves"
  /** The party, from PKMN. */
  | "party"
  /** SWITCH / STATS / CANCEL. */
  | "switch-menu"
  /** The party after a faint: the forced switch. */
  | "forced"
  /** Waiting on the cable for the other game's choice. */
  | "waiting"
  /** Anything else: text, animations, the turn playing out. */
  | "busy";

/** A decision for one side. Slots and party places count from 0, as the game's memory does. */
export type Action = { kind: "move"; slot: number } | { kind: "fight" } | { kind: "switch"; to: number };

/** What one side may do at a decision point; null when it isn't asked this turn. */
export type Legal =
  | {
      kind: "turn";
      /** Usable move slots; empty when FIGHT goes straight on (asleep, frozen, trapped, Struggle). */
      moves: number[];
      /** True when FIGHT is the move: the game picks it (Struggle, sleep, a turn the move continues itself). */
      fight: boolean;
      switches: number[];
    }
  | { kind: "forced"; switches: number[] };

export type Outcome = { winner: Side | null; reason: "knockout" | "draw" };

/** One step of a turn as one game saw it, with sides named absolutely (0 and 1), not as "player" and "enemy". */
export type TurnEvent =
  /** A side's part of the turn starts: first is who moved first. A side that then uses no move couldn't (asleep,
   * paralysed, flinched, hurt in confusion, charging) or switched. */
  | { kind: "acts"; side: Side }
  | { kind: "used"; side: Side; move: number }
  | { kind: "resolved"; side: Side; move: number; missed: boolean; critical: boolean; effectiveness: number; damage: number };

/** What a turn changed on one side, absolute (side 0 and side 1), from both games' agreed view. */
export interface SideChange {
  species: [number, number];
  hp: [number, number];
  maxHp: number;
  status: [number, number];
  /** Stat stages after minus before, by attack, defense, speed, special, accuracy, evasion. */
  stages: number[];
  /** The field before the turn (what the side was locked into, for the story of a turn it didn't choose). */
  was: Field;
  /** Field effects that came on, and that went off. */
  fieldOn: (keyof Field)[];
  fieldOff: (keyof Field)[];
  switched: boolean;
  fainted: boolean;
}

function change(before: Mon, after: Mon): SideChange {
  const keys = Object.keys(after.field) as (keyof Field)[];
  const switched = before.species !== after.species && !after.field.transformed;
  return {
    species: [before.species, after.species],
    hp: [before.hp, after.hp],
    maxHp: after.maxHp,
    status: [before.status, after.status],
    was: before.field,
    stages: switched ? after.stages.map(() => 0) : after.stages.map((v, i) => v - (before.stages[i] ?? v)),
    fieldOn: keys.filter((k) => after.field[k] && !before.field[k]),
    fieldOff: keys.filter((k) => !after.field[k] && before.field[k]),
    switched,
    fainted: before.hp > 0 && after.hp === 0,
  };
}

export interface TurnRecord {
  turn: number;
  dice: number[];
  decisions: [Action | null, Action | null];
  /** The events as game 0 saw them; game 1's matched, or the battle would have ended in a desync. */
  events: TurnEvent[];
  /** What changed on each side. */
  sides: [SideChange, SideChange];
  before: [Snapshot, Snapshot];
  after: [Snapshot, Snapshot];
  frames: number;
}

export class BattleError extends Error {
  constructor(
    readonly kind: "stuck" | "desync" | "illegal" | "ran",
    message: string,
  ) {
    super(message);
  }
}

const CONTEXTS = ["battleMenu", "moveMenu", "partyMenu", "switchMenu", "forcedSwitch", "exchange"] as const;
const PHASE_OF: Record<(typeof CONTEXTS)[number], Phase> = {
  battleMenu: "menu",
  moveMenu: "moves",
  partyMenu: "party",
  switchMenu: "switch-menu",
  forcedSwitch: "forced",
  exchange: "busy",
};
const STOPS = new Set<keyof typeof CODE>(["playerActs", "enemyActs", "playerUsesMove", "enemyUsesMove", "playerMoveResolved", "enemyMoveResolved", "run"]);
const SIDES: readonly Side[] = [0, 1];

/** Frames a turn may take before the rig calls it stuck (docs/link-battles.md 4.3). */
export const TURN_BUDGET = 6000;
/** Frames one menu step (a button and the game's answer) may take. */
const STEP_BUDGET = 600;
/**
 * Frames both games may take to reach their end of battle once one has. One game can lag the other by a whole faint
 * sequence (a last Pokémon's Explosion: its own faint is silent, the other game plays both), measured at over 650.
 */
const FINISH_BUDGET = 3600;

/** The main battle menu's two columns, by the cursor's X (wTopMenuItemX). */
const LEFT_COLUMN = 9;
const RIGHT_COLUMN = 15;

export class Battle {
  private readonly ids: Record<keyof typeof CODE, number>;
  private readonly phases: [Phase, Phase] = ["busy", "busy"];
  private events: [TurnEvent[], TurnEvent[]] = [[], []];
  private turnNumber = 0;
  private readonly startCounts: [number, number];

  private readonly resumed: [Phase, Phase] | null;
  /** Each game's main-loop stamp at the last decision point: a later one means a new turn has begun. */
  private mark: [number, number];

  /**
   * Watches the game's code on `rig`, whose two games are in a link battle. A battle resumed from states saved at a
   * decision point passes the phases and turn it was saved at: until a menu opens, the rig can't see which menu is up
   * (the routine that opened it ran before the save), so it trusts them while that menu polls.
   */
  constructor(
    private readonly rig: Rig,
    resume?: { phases: [Phase, Phase]; turn: number },
  ) {
    this.resumed = resume?.phases ?? null;
    this.turnNumber = resume?.turn ?? 0;
    rig.clearWatches();
    const ids = {} as Record<keyof typeof CODE, number>;
    for (const [name, [bank, addr]] of Object.entries(CODE) as [keyof typeof CODE, readonly [number, number]][]) {
      ids[name] = rig.watch(addr, bank, STOPS.has(name));
    }
    this.ids = ids;
    this.startCounts = [this.count(0), this.count(1)];
    // Resumed at a turn nobody chooses (both games locked in, waiting on the cable), it's a decision point at once.
    const lockedIn = this.resumed?.[0] === "waiting" && this.resumed?.[1] === "waiting";
    this.mark = lockedIn ? [-1, -1] : [0, 0];
  }

  private mainLoop(side: Side): number {
    return this.rig.stamps(side)[this.ids.mainLoop]!;
  }

  get turn(): number {
    return this.turnNumber;
  }

  phase(side: Side): Phase {
    return this.phases[side];
  }

  /**
   * Runs both games until a decision point (every game at a menu or waiting on the cable, at least one at a menu) or the
   * end. Returns the outcome at the end, or null at a decision point.
   */
  runToDecision(budget = TURN_BUDGET): Outcome | null {
    for (let i = 0; i < budget; i++) {
      this.frame();
      const end = this.ended();
      if (end) return this.finish();
      if (this.atDecision()) return null;
    }
    throw new BattleError("stuck", `No decision point within ${budget} frames (phases ${this.phases.join(", ")}).`);
  }

  /**
   * Whether both games are at a decision point now: each at a menu or waiting on the cable, and at least one at a menu;
   * or a turn nobody chooses, where both games began a new turn and went straight to the cable (both locked in: Rage,
   * charging, recharging, a continuing Thrash), which is its own turn, not part of the one before.
   */
  atDecision(): boolean {
    const ready = (p: Phase) => p === "menu" || p === "forced" || p === "waiting";
    if (!ready(this.phases[0]) || !ready(this.phases[1])) return false;
    if (this.asked(0) || this.asked(1)) return true;
    return SIDES.every((side) => this.phases[side] === "waiting" && this.mainLoop(side) > this.mark[side]);
  }

  /** Whether `side` has a choice to make at this decision point. */
  asked(side: Side): boolean {
    return this.phases[side] === "menu" || this.phases[side] === "forced";
  }

  /** What `side` may do now, read from its own game; null when it isn't asked. */
  legal(side: Side): Legal | null {
    const r = (addr: number) => this.rig.read(side, addr);
    const own = party(this.rig, side);
    const active = r(ADDR.playerMonNumber);
    const switches = own.flatMap((mon, i) => (i !== active && mon.hp > 0 ? [i] : []));
    if (this.phases[side] === "forced") return { kind: "forced", switches };
    if (this.phases[side] !== "menu") return null;
    const goesStraightOn =
      (r(ADDR.battleMonStatus) & (STATUS.SLEEP | STATUS.FREEZE)) !== 0 ||
      (r(ADDR.playerBattleStatus1) & (BATTLE_STATUS1.STORING_ENERGY | BATTLE_STATUS1.TRAPPING)) !== 0 ||
      (r(ADDR.enemyBattleStatus1) & BATTLE_STATUS1.TRAPPING) !== 0;
    const moves = this.rig.readBytes(side, ADDR.battleMonMoves, 4);
    const pp = this.rig.readBytes(side, ADDR.battleMonPP, 4).map((v) => v & 0x3f);
    const disabled = (r(ADDR.playerDisabledMove) >> 4) - 1;
    const usable = goesStraightOn ? [] : moves.flatMap((move, slot) => (move !== 0 && pp[slot]! > 0 && slot !== disabled ? [slot] : []));
    // A banned move is never legal while anything else is, even if a team carries one (the format's teams don't).
    const allowed = usable.filter((slot) => !BANNED_MOVES.has(moves[slot]!));
    return { kind: "turn", moves: allowed.length || switches.length ? allowed : usable, fight: usable.length === 0, switches };
  }

  /** Throws unless `action` is legal for `side` now. */
  check(side: Side, action: Action): void {
    const legal = this.legal(side);
    if (!legal) throw new BattleError("illegal", `Side ${side} isn't asked this turn.`);
    const ok =
      action.kind === "switch"
        ? legal.switches.includes(action.to)
        : legal.kind === "turn" && (action.kind === "fight" ? legal.fight : legal.moves.includes(action.slot));
    if (!ok) throw new BattleError("illegal", `Side ${side} can't ${JSON.stringify(action)} (${JSON.stringify(legal)}).`);
  }

  /**
   * Plays one turn from a decision point: deals the dice into both games, makes each asked side's decision with its
   * buttons (side 0 first), and runs to the next decision point or the end. Returns the turn's record and, at the end,
   * the outcome.
   */
  play(decisions: [Action | null, Action | null], dice: Uint8Array): { record: TurnRecord; outcome: Outcome | null } {
    if (!this.atDecision()) throw new BattleError("illegal", "Not at a decision point.");
    for (const side of SIDES) {
      const action = decisions[side];
      if (this.asked(side) !== (action !== null)) {
        throw new BattleError("illegal", `Side ${side} ${this.asked(side) ? "must decide" : "isn't asked"} this turn.`);
      }
      if (action) this.check(side, action);
    }
    const before = [snapshot(this.rig, 0), snapshot(this.rig, 1)] as [Snapshot, Snapshot];
    const f0 = this.rig.frameCount;
    // This turn has begun in both games: the next one is the next main-loop pass.
    this.mark = [this.mainLoop(0), this.mainLoop(1)];
    dealDice(this.rig, dice);
    this.alignTurnStart();
    for (const side of SIDES) if (decisions[side]?.kind === "fight") this.alignStaleMove(side);
    this.events = [[], []];
    for (const side of SIDES) {
      const action = decisions[side];
      if (action) this.decide(side, action);
    }
    const outcome = this.runToDecision();
    this.turnNumber++;
    const after = [snapshot(this.rig, 0), snapshot(this.rig, 1)] as [Snapshot, Snapshot];
    const differ = JSON.stringify(this.events[0]) !== JSON.stringify(this.events[1]);
    if (differ) {
      throw new BattleError("desync", `The games saw turn ${this.turnNumber} differently: ${JSON.stringify(this.events)}.`);
    }
    if (!outcome) {
      const views = disagreements(after[0], after[1]);
      if (views.length) throw new BattleError("desync", `After turn ${this.turnNumber}: ${views.join("; ")}.`);
    }
    const record: TurnRecord = {
      turn: this.turnNumber,
      dice: [...dice],
      decisions,
      events: this.events[0],
      // Game 0's view: its own Pokémon is side 0, its enemy side 1 (the games were just checked to agree).
      sides: [change(before[0].mine, after[0].mine), change(before[0].theirs, after[0].theirs)],
      before,
      after,
      frames: this.rig.frameCount - f0,
    };
    return { record, outcome };
  }

  /**
   * Two more of the game's own link desyncs, corrected at every decision point (docs/link-battles.md 14.5):
   * - A flinch is cleared at the start of each turn, except in the game of a side that's raging or recharging, which
   *   skips the reset: a side flinched at the end of one turn then loses its next in one game and acts in the other.
   *   A flinch only ever counts within the turn it's inflicted, so here every flinch flag is clear in both games.
   * - A game never lowers its copy of the other side's PP, and Disable checks the target's PP: once a move is out of
   *   PP, the two games disable different moves. Here each game's copy of the other side's PP (the Pokémon out and the
   *   party records) is set to that side's own, true PP.
   */
  private alignTurnStart(): void {
    const FLINCHED = 1 << 3;
    for (const side of SIDES) {
      const other = (1 - side) as Side;
      for (const addr of [ADDR.playerBattleStatus1, ADDR.enemyBattleStatus1]) this.rig.write(side, addr, this.rig.read(side, addr) & ~FLINCHED);
      this.rig.readBytes(other, ADDR.battleMonPP, 4).forEach((pp, i) => this.rig.write(side, ADDR.enemyMonPP + i, pp));
      const count = Math.min(this.rig.read(other, ADDR.partyCount), 6);
      for (let k = 0; k < count; k++) {
        const at = (base: number) => base + k * PARTY_MON.length + PARTY_MON.pp;
        this.rig.readBytes(other, at(ADDR.partyMons), 4).forEach((pp, i) => this.rig.write(side, at(ADDR.enemyMons) + i, pp));
      }
    }
  }

  /**
   * The game's own stale-move desyncs (docs/link-battles.md 14.2, 14.5): when FIGHT skips the move list (asleep, frozen),
   * a game keeps whatever move was selected last, perhaps another Pokémon's, while the other game looks up the move slot
   * sent over the cable. They then disagree on what was used if a Fire move thaws it mid-turn, and on who moves first if
   * the stale move is Quick Attack. Setting the selected move to that slot's makes both games agree. When the game picks
   * the move itself after FIGHT (Struggle, a trapped Pokémon that can't move), it overwrites this in both games alike.
   */
  private alignStaleMove(side: Side): void {
    const moves = this.rig.readBytes(side, ADDR.battleMonMoves, 4);
    let slot = this.rig.read(side, ADDR.playerMoveListIndex);
    // The slot left over from the last move list may be past this Pokémon's moves: then its first move, in both games.
    if (slot >= 4 || moves[slot] === 0) slot = Math.max(0, moves.findIndex((m) => m !== 0));
    this.rig.write(side, ADDR.playerMoveListIndex, slot);
    this.rig.write(side, ADDR.playerSelectedMove, moves[slot]!);
  }

  // ---- The buttons (docs/link-battles.md 7.3) ----

  private decide(side: Side, action: Action): void {
    if (this.phases[side] === "forced") {
      if (action.kind !== "switch") throw new BattleError("illegal", "After a faint, the only action is a switch.");
      this.cursorTo(side, "forced", action.to);
      this.tap(side, "A", ["waiting"]);
      this.landed(side, action);
      return;
    }
    if (action.kind === "switch") {
      this.mainMenu(side, RIGHT_COLUMN);
      this.tap(side, "A", ["party"]);
      this.cursorTo(side, "party", action.to);
      this.tap(side, "A", ["switch-menu"]);
      this.cursorTo(side, "switch-menu", 0);
      this.tap(side, "A", ["waiting"]);
      this.landed(side, action);
      return;
    }
    this.mainMenu(side, LEFT_COLUMN);
    const next = this.tap(side, "A", ["moves", "waiting"]);
    if (action.kind === "fight") {
      if (next === "moves") throw new BattleError("illegal", `Side ${side}'s game offered moves for a straight FIGHT.`);
      return;
    }
    if (next === "waiting") throw new BattleError("illegal", `Side ${side}'s game went straight on; the move wasn't a choice.`);
    // The move list's items count from 1 (its row 0 is the box's border).
    this.cursorTo(side, "moves", action.slot + 1);
    this.tap(side, "A", ["waiting"]);
    this.landed(side, action);
  }

  /** Checks the game took the decision (7.3): the move it selected, or the Pokémon it's sending out. */
  private landed(side: Side, action: Action): void {
    const r = (addr: number) => this.rig.read(side, addr);
    const ok =
      action.kind === "move"
        ? r(ADDR.playerSelectedMove) === r(ADDR.battleMonMoves + action.slot)
        : action.kind === "switch"
          ? r(ADDR.whichPokemon) === action.to
          : true;
    if (!ok) throw new BattleError("stuck", `Side ${side}'s game didn't take ${JSON.stringify(action)}.`);
  }

  /** Puts the main menu's cursor on FIGHT (left column) or PKMN (right column), top row, and checks it isn't on RUN. */
  private mainMenu(side: Side, column: number): void {
    for (let tries = 0; tries < 4; tries++) {
      const x = this.rig.read(side, ADDR.topMenuItemX);
      const item = this.rig.read(side, ADDR.currentMenuItem);
      if (x === column && item === 0) return;
      if (x !== column) this.tap(side, column === LEFT_COLUMN ? "LEFT" : "RIGHT", ["menu"]);
      else this.tap(side, "UP", ["menu"]);
    }
    throw new BattleError("stuck", `Side ${side}'s battle menu cursor didn't reach ${column === LEFT_COLUMN ? "FIGHT" : "PKMN"}.`);
  }

  /** Moves a list menu's cursor to `item` by reading where it is, a press at a time. */
  private cursorTo(side: Side, phase: Phase, item: number): void {
    for (let tries = 0; tries < 8; tries++) {
      const at = this.rig.read(side, ADDR.currentMenuItem);
      if (at === item) return;
      this.tap(side, at < item ? "DOWN" : "UP", [phase]);
    }
    throw new BattleError("stuck", `Side ${side}'s cursor didn't reach item ${item} in the ${phase}.`);
  }

  /**
   * Presses `key` on one side and runs until that side's game is in one of `then`, retrying the press once if the game
   * didn't take it (docs/link-battles.md 7.3). Returns the phase it reached.
   */
  private tap(side: Side, key: Key, then: Phase[]): Phase {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = this.where(side);
      this.rig.key(side, key, true);
      this.frame();
      this.frame();
      this.rig.key(side, key, false);
      for (let i = 0; i < STEP_BUDGET; i++) {
        this.frame();
        if (this.ended()) throw new BattleError("stuck", `The battle ended while side ${side} was choosing.`);
        const now = this.phases[side];
        if (then.includes(now) && this.where(side) !== before) return now;
      }
    }
    throw new BattleError("stuck", `Side ${side} pressed ${key} twice and didn't reach ${then.join(" or ")}.`);
  }

  /** Where a side's menus are: its phase and cursor, to tell when a press has landed. */
  private where(side: Side): string {
    const r = (addr: number) => this.rig.read(side, addr);
    return `${this.phases[side]} ${r(ADDR.currentMenuItem)} ${r(ADDR.topMenuItemX)}`;
  }

  // ---- Watching the games ----

  private count(side: Side): number {
    return this.rig.stamps(side)[this.rig.stamps(side).length - 1]!;
  }

  /** Runs one whole frame, noting what each stop watch shows, and judges each game's phase over it. */
  private frame(): void {
    const start = [this.count(0), this.count(1)];
    for (;;) {
      const stop = this.rig.run(1);
      if (!stop) break;
      this.onStop(stop);
      if (!this.rig.midFrame) break;
    }
    for (const side of SIDES) this.phases[side] = this.judge(side, start[side]!);
  }

  private judge(side: Side, since: number): Phase {
    const stamps = this.rig.stamps(side);
    const hit = (name: keyof typeof CODE) => stamps[this.ids[name]]! > since;
    if (hit("exchangeWait")) return "waiting";
    if (!hit("menuPoll")) return "busy";
    let latest: (typeof CONTEXTS)[number] | null = null;
    for (const name of CONTEXTS) if (!latest || stamps[this.ids[name]]! > stamps[this.ids[latest]]!) latest = name;
    if (latest && stamps[this.ids[latest]]! > 0) return PHASE_OF[latest];
    // No menu has opened since the rig was made: a battle resumed from saved states trusts the phase it was saved at; a
    // bootstrap (saved at the battle's first menu, docs/link-battles.md 7.4) is known by the main menu's cursor frame:
    // row 14, either column, two rows.
    const saved = this.resumed?.[side];
    if (saved === "menu" || saved === "forced") return saved;
    const r = (addr: number) => this.rig.read(side, addr);
    const x = r(ADDR.topMenuItemX);
    const mainMenu = r(ADDR.topMenuItemY) === 14 && (x === LEFT_COLUMN || x === RIGHT_COLUMN) && r(ADDR.maxMenuItem) === 1;
    return mainMenu ? "menu" : "busy";
  }

  private onStop(stop: Stop): void {
    const { side } = stop;
    const other = (1 - side) as Side;
    const r = (addr: number) => this.rig.read(side, addr);
    const name = (Object.keys(this.ids) as (keyof typeof CODE)[]).find((n) => this.ids[n] === stop.watch);
    if (name === "run") throw new BattleError("ran", `Side ${side}'s game reached RUN.`);
    const resolved = (who: Side, move: number) => ({
      kind: "resolved" as const,
      side: who,
      move,
      missed: r(ADDR.moveMissed) !== 0,
      critical: r(ADDR.criticalHitOrOHKO) === 1,
      effectiveness: r(ADDR.damageMultipliers) & 0x7f,
      damage: this.rig.read16(side, ADDR.damage),
    });
    if (name === "playerActs") this.events[side].push({ kind: "acts", side });
    if (name === "enemyActs") this.events[side].push({ kind: "acts", side: other });
    if (name === "playerUsesMove") this.events[side].push({ kind: "used", side, move: r(ADDR.playerMoveNum) });
    if (name === "enemyUsesMove") this.events[side].push({ kind: "used", side: other, move: r(ADDR.enemyMoveNum) });
    if (name === "playerMoveResolved") this.events[side].push(resolved(side, r(ADDR.playerMoveNum)));
    if (name === "enemyMoveResolved") this.events[side].push(resolved(other, r(ADDR.enemyMoveNum)));
  }

  private ended(): boolean {
    return SIDES.some((side) => this.result(side) !== null);
  }

  /** "lost" when this game blacked out, "won" when it beat the other's last Pokémon, "ran" if the other ran. */
  private result(side: Side): "lost" | "won" | "ran" | null {
    const stamps = this.rig.stamps(side);
    const since = (name: keyof typeof CODE) => stamps[this.ids[name]]! > this.startCounts[side];
    if (since("blackOut")) return "lost";
    if (since("victory")) return "won";
    if (since("enemyRan")) return "ran";
    return null;
  }

  /** Runs until both games have reached their end of battle, and checks they agree on it. */
  private finish(): Outcome {
    for (let i = 0; i < FINISH_BUDGET && SIDES.some((side) => this.result(side) === null); i++) this.frame();
    const [a, b] = [this.result(0), this.result(1)];
    if (a === "ran" || b === "ran") throw new BattleError("ran", "A game ran from the battle.");
    if (a === "lost" && b === "lost") return { winner: null, reason: "draw" };
    if (a === "won" && b === "lost") return { winner: 0, reason: "knockout" };
    if (a === "lost" && b === "won") return { winner: 1, reason: "knockout" };
    throw new BattleError("desync", `The games ended differently: side 0 ${a}, side 1 ${b}.`);
  }
}
