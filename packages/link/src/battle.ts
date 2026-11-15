import type { Key, Rig, Side, Stop } from "./rig.ts";
import {
  ADDR,
  BANNED_MOVES,
  BATTLE_STATUS1,
  CODE,
  dealDice,
  disagreements,
  party,
  snapshot,
  STATUS,
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

export interface TurnRecord {
  turn: number;
  dice: number[];
  decisions: [Action | null, Action | null];
  /** The events as game 0 saw them; game 1's matched, or the battle would have ended in a desync. */
  events: TurnEvent[];
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

/** The main battle menu's two columns, by the cursor's X (wTopMenuItemX). */
const LEFT_COLUMN = 9;
const RIGHT_COLUMN = 15;

export class Battle {
  private readonly ids: Record<keyof typeof CODE, number>;
  private readonly phases: [Phase, Phase] = ["busy", "busy"];
  private events: [TurnEvent[], TurnEvent[]] = [[], []];
  private turnNumber = 0;
  private readonly startCounts: [number, number];

  /** Watches the game's code on `rig`, whose two games are in a link battle. */
  constructor(private readonly rig: Rig) {
    const ids = {} as Record<keyof typeof CODE, number>;
    for (const [name, [bank, addr]] of Object.entries(CODE) as [keyof typeof CODE, readonly [number, number]][]) {
      ids[name] = rig.watch(addr, bank, STOPS.has(name));
    }
    this.ids = ids;
    this.startCounts = [this.count(0), this.count(1)];
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

  /** Whether both games are at a decision point now. */
  atDecision(): boolean {
    const ready = (p: Phase) => p === "menu" || p === "forced" || p === "waiting";
    return ready(this.phases[0]) && ready(this.phases[1]) && (this.asked(0) || this.asked(1));
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
    dealDice(this.rig, dice);
    for (const side of SIDES) if (decisions[side]?.kind === "fight") this.alignFrozenMove(side);
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
      before,
      after,
      frames: this.rig.frameCount - f0,
    };
    return { record, outcome };
  }

  /**
   * The game's own thaw desync (docs/link-battles.md 14.2): a frozen Pokémon selects no move, but a Fire move can thaw it
   * mid-turn, and then it attacks. Its own game uses whatever move was selected last (perhaps another Pokémon's), while
   * the other game looks up the move slot sent over the cable. Setting the selected move to that slot's makes both games
   * use the same one.
   */
  private alignFrozenMove(side: Side): void {
    if ((this.rig.read(side, ADDR.battleMonStatus) & STATUS.FREEZE) === 0) return;
    const slot = this.rig.read(side, ADDR.playerMoveListIndex);
    const move = slot < 4 ? this.rig.read(side, ADDR.battleMonMoves + slot) : 0;
    if (move !== 0) this.rig.write(side, ADDR.playerSelectedMove, move);
  }

  // ---- The buttons (docs/link-battles.md 7.3) ----

  private decide(side: Side, action: Action): void {
    if (this.phases[side] === "forced") {
      if (action.kind !== "switch") throw new BattleError("illegal", "After a faint, the only action is a switch.");
      this.cursorTo(side, "forced", action.to);
      this.tap(side, "A", ["waiting"]);
      return;
    }
    if (action.kind === "switch") {
      this.mainMenu(side, RIGHT_COLUMN);
      this.tap(side, "A", ["party"]);
      this.cursorTo(side, "party", action.to);
      this.tap(side, "A", ["switch-menu"]);
      this.cursorTo(side, "switch-menu", 0);
      this.tap(side, "A", ["waiting"]);
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
    // No menu has opened since the rig was made: a battle loaded from a state saved at its menu (the bootstraps are,
    // docs/link-battles.md 7.4). The main battle menu is known by its cursor's frame: row 14, either column, two rows.
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
    for (let i = 0; i < STEP_BUDGET && SIDES.some((side) => this.result(side) === null); i++) this.frame();
    const [a, b] = [this.result(0), this.result(1)];
    if (a === "ran" || b === "ran") throw new BattleError("ran", "A game ran from the battle.");
    if (a === "lost" && b === "lost") return { winner: null, reason: "draw" };
    if (a === "won" && b === "lost") return { winner: 0, reason: "knockout" };
    if (a === "lost" && b === "won") return { winner: 1, reason: "knockout" };
    throw new BattleError("desync", `The games ended differently: side 0 ${a}, side 1 ${b}.`);
  }
}
