import type { Rig, Side } from "./rig.ts";

// Pokémon Yellow's memory, as far as a link battle needs it (docs/link-battles.md 7, 17). Addresses are the English
// release's, from the public disassembly's RAM layout (its symbol names), and match the ones JK Clawseum's spike read.
// Each game sees itself as the player: its own Pokémon are `battleMon`, the other game's are `enemyMon`.

export const ADDR = {
  currentMenuItem: 0xcc26,
  topMenuItemY: 0xcc24,
  topMenuItemX: 0xcc25,
  maxMenuItem: 0xcc28,
  playerMoveListIndex: 0xcc2e,
  serialExchangeNybbleReceiveData: 0xcc3e,
  serialExchangeNybbleSendData: 0xcc42,
  playerSelectedMove: 0xccdc,
  enemySelectedMove: 0xccdd,
  linkBattleRandomNumberListIndex: 0xccde,
  actionResultOrTookBattleTurn: 0xcd6a,
  battleResult: 0xcf0b,
  enemyMonSpecies2: 0xcfd7,
  battleMonSpecies2: 0xcfd8,
  enemyMoveNum: 0xcfcb,
  enemyMovePower: 0xcfcd,
  playerMoveNum: 0xcfd1,
  playerMovePower: 0xcfd3,
  enemyMonHP: 0xcfe5,
  enemyMonPartyPos: 0xcfe7,
  enemyMonStatus: 0xcfe8,
  enemyMonMoves: 0xcfec,
  enemyMonLevel: 0xcff2,
  enemyMonMaxHP: 0xcff3,
  enemyMonPP: 0xcffd,
  battleMonHP: 0xd014,
  battleMonStatus: 0xd017,
  battleMonMoves: 0xd01b,
  battleMonLevel: 0xd021,
  battleMonMaxHP: 0xd022,
  battleMonPP: 0xd02c,
  isInBattle: 0xd056,
  battleType: 0xd059,
  damageMultipliers: 0xd05a,
  criticalHitOrOHKO: 0xd05d,
  moveMissed: 0xd05e,
  playerBattleStatus1: 0xd061,
  playerBattleStatus2: 0xd062,
  enemyBattleStatus1: 0xd066,
  enemyBattleStatus2: 0xd067,
  playerDisabledMove: 0xd06c,
  enemyDisabledMove: 0xd071,
  damage: 0xd0d6,
  whichPokemon: 0xcf91,
  menuWatchedKeys: 0xcc29,
  playerMonNumber: 0xcc2f,
  linkState: 0xd12a,
  linkBattleRandomNumberList: 0xd147,
  partyCount: 0xd162,
  partySpecies: 0xd163,
  partyMons: 0xd16a,
  options: 0xd354,
  enemyPartyCount: 0xd89b,
  enemyPartySpecies: 0xd89c,
  enemyMons: 0xd8a3,
} as const;

/** A party Pokémon's record: 44 bytes, from wPartyMon1 (and wEnemyMon1 for the other side's party). */
export const PARTY_MON = { length: 0x2c, hp: 0x01, status: 0x04, moves: 0x08, pp: 0x1d, level: 0x21, maxHp: 0x22 } as const;

/**
 * The one release the rig plays: the English Pokémon Yellow, by its header (title, header checksum, global checksum),
 * which the public disassembly's build matches byte for byte (SHA-1 cc7d03262ebfaf2f06772c1a480c7d9d5f4a38e1).
 */
export const GAME = { title: "POKEMON YELLOW", headerChecksum: 0x97, globalChecksum: 0x047c } as const;

/** Throws unless `rom` is the release the code addresses below are for. */
export function checkGame(rom: Uint8Array): void {
  const title = String.fromCharCode(...rom.subarray(0x134, 0x134 + GAME.title.length));
  const global = ((rom[0x14e] ?? 0) << 8) | (rom[0x14f] ?? 0);
  if (rom.length !== 0x100000 || title !== GAME.title || rom[0x14d] !== GAME.headerChecksum || global !== GAME.globalChecksum) {
    throw new Error("This isn't the English Pokémon Yellow the rig is built for.");
  }
}

/**
 * Where the game's battle code is, as [ROM bank, address], from the public disassembly's symbols for this release.
 * The rig watches these to know what each game is doing (docs/link-battles.md 7.2), never guessing from the screen.
 */
export const CODE = {
  /** HandleMenuInput_.getJoypadState: any menu, polling for a button. */
  menuPoll: [0x00, 0x3ad5],
  /** DisplayBattleMenu.handleBattleMenuInput: the FIGHT / PKMN / ITEM / RUN menu is up. */
  battleMenu: [0x0f, 0x4ff8],
  /** MoveSelectionMenu: the move list. */
  moveMenu: [0x0f, 0x5320],
  /** PartyMenuOrRockOrRun.partyMenuWasSelected: the party, from PKMN. */
  partyMenu: [0x0f, 0x51e3],
  /** PartyMenuOrRockOrRun.partyMonWasSelected: SWITCH / STATS / CANCEL. */
  switchMenu: [0x0f, 0x521c],
  /** ChooseNextMon: the party after a faint, the forced switch. */
  forcedSwitch: [0x0f, 0x483c],
  /** LinkBattleExchangeData: the choice goes over the cable. */
  exchange: [0x0f, 0x5777],
  /** LinkBattleExchangeData.syncLoop1: waiting for the other game's choice. */
  exchangeWait: [0x0f, 0x57ad],
  /** BattleMenu_RunWasSelected: RUN, which the rig must never reach. */
  run: [0x0f, 0x5301],
  /** ExecutePlayerMove / ExecuteEnemyMove: a side's part of the turn starts (whether or not it can move). */
  playerActs: [0x0f, 0x57d0],
  enemyActs: [0x0f, 0x6842],
  /** PlayerCanExecuteMove / EnemyCanExecuteMove: a move is used (after sleep, paralysis, confusion and the rest). */
  playerUsesMove: [0x0f, 0x5822],
  enemyUsesMove: [0x0f, 0x68b1],
  /** HandleIfPlayerMoveMissed / HandleIfEnemyMoveMissed: a damaging move's hit, critical and effectiveness are known. */
  playerMoveResolved: [0x0f, 0x5877],
  enemyMoveResolved: [0x0f, 0x6908],
  /** HandlePlayerBlackOut: this game's player has nothing left. TrainerBattleVictory: the other game's hasn't. */
  blackOut: [0x0f, 0x489c],
  victory: [0x0f, 0x46b8],
  /** EnemyRan: the other game ran. */
  enemyRan: [0x0f, 0x4218],
} as const satisfies Record<string, readonly [number, number]>;

/**
 * Moves the format bans because they desync link battles (docs/link-battles.md 4.1): Counter, Bide and Psywave, and
 * Metronome and Mirror Move, which can call them. Ids are the game's move numbers.
 */
export const BANNED_MOVES: ReadonlyMap<number, string> = new Map([
  [68, "Counter"],
  [117, "Bide"],
  [118, "Metronome"],
  [119, "Mirror Move"],
  [149, "Psywave"],
]);

/** wBattleMonStatus bits: sleep counts in the low three, then poison, burn, freeze, paralysis. */
export const STATUS = { SLEEP: 0b111, POISON: 1 << 3, BURN: 1 << 4, FREEZE: 1 << 5, PARALYSIS: 1 << 6 } as const;

/** wPlayerBattleStatus1 / 2 bits the legal actions depend on. */
export const BATTLE_STATUS1 = { STORING_ENERGY: 1 << 0, THRASHING: 1 << 1, CHARGING_UP: 1 << 4, TRAPPING: 1 << 5 } as const;
export const BATTLE_STATUS2 = { USING_RAGE: 1 << 0, NEEDS_TO_RECHARGE: 1 << 5 } as const;

/** One of this game's own party, as the party record holds it. */
export interface PartyMon {
  species: number;
  level: number;
  hp: number;
  maxHp: number;
  status: number;
  moves: number[];
  pp: number[];
}

/** This game's own party, in order. The active Pokémon's HP is current in battle memory, not here: use battleMonHP. */
export function party(rig: Rig, side: Side): PartyMon[] {
  const count = Math.min(rig.read(side, ADDR.partyCount), 6);
  return Array.from({ length: count }, (_, i) => {
    const base = ADDR.partyMons + i * PARTY_MON.length;
    return {
      species: rig.read(side, ADDR.partySpecies + i),
      level: rig.read(side, base + PARTY_MON.level),
      hp: rig.read16(side, base + PARTY_MON.hp),
      maxHp: rig.read16(side, base + PARTY_MON.maxHp),
      status: rig.read(side, base + PARTY_MON.status),
      moves: rig.readBytes(side, base + PARTY_MON.moves, 4),
      pp: rig.readBytes(side, base + PARTY_MON.pp, 4).map((pp) => pp & 0x3f),
    };
  });
}

/** wLinkState values. */
export const LINK_STATE = { NONE: 0x00, IN_CABLE_CLUB: 0x01, START_BATTLE: 0x03, BATTLING: 0x04 } as const;

/** The shared dice: 10 bytes, of which BattleRandom cycles through the first 9, remaking each as 5x+1 when it wraps. */
export const DICE_LENGTH = 10;

export interface Mon {
  species: number;
  level: number;
  hp: number;
  maxHp: number;
  status: number;
}

/** What one game holds about the battle, raw. */
export interface Snapshot {
  linkState: number;
  isInBattle: number;
  battleResult: number;
  mine: Mon;
  theirs: Mon;
  myMoves: number[];
  myPP: number[];
  selected: { mine: number; theirs: number };
  menu: { item: number; top: [number, number]; max: number };
  dice: number[];
  diceIndex: number;
}

export function snapshot(rig: Rig, side: Side): Snapshot {
  const r = (a: number) => rig.read(side, a);
  return {
    linkState: r(ADDR.linkState),
    isInBattle: r(ADDR.isInBattle),
    battleResult: r(ADDR.battleResult),
    mine: {
      species: r(ADDR.battleMonSpecies2),
      level: r(ADDR.battleMonLevel),
      hp: rig.read16(side, ADDR.battleMonHP),
      maxHp: rig.read16(side, ADDR.battleMonMaxHP),
      status: r(ADDR.battleMonStatus),
    },
    theirs: {
      species: r(ADDR.enemyMonSpecies2),
      level: r(ADDR.enemyMonLevel),
      hp: rig.read16(side, ADDR.enemyMonHP),
      maxHp: rig.read16(side, ADDR.enemyMonMaxHP),
      status: r(ADDR.enemyMonStatus),
    },
    myMoves: rig.readBytes(side, ADDR.battleMonMoves, 4),
    myPP: rig.readBytes(side, ADDR.battleMonPP, 4).map((pp) => pp & 0x3f),
    selected: { mine: r(ADDR.playerSelectedMove), theirs: r(ADDR.enemySelectedMove) },
    menu: { item: r(ADDR.currentMenuItem), top: [r(ADDR.topMenuItemY), r(ADDR.topMenuItemX)], max: r(ADDR.maxMenuItem) },
    dice: rig.readBytes(side, ADDR.linkBattleRandomNumberList, DICE_LENGTH),
    diceIndex: r(ADDR.linkBattleRandomNumberListIndex),
  };
}

/**
 * Where the two games disagree about the battle: each game's own Pokémon against the other game's view of its enemy,
 * and the dice. Empty when they agree (docs/link-battles.md 4.3, 4.4).
 */
export function disagreements(a: Snapshot, b: Snapshot): string[] {
  const out: string[] = [];
  const same = (what: string, x: unknown, y: unknown) => {
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${what}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
  };
  // A fainted Pokémon's own game clears its status; the other game's view keeps it. Down is down.
  const view = (mon: Mon) => (mon.hp === 0 ? { ...mon, status: 0 } : mon);
  same("side 0's Pokémon", view(a.mine), view(b.theirs));
  same("side 1's Pokémon", view(b.mine), view(a.theirs));
  same("dice", a.dice, b.dice);
  same("dice index", a.diceIndex, b.diceIndex);
  return out;
}

/**
 * Deals fresh dice into both games: the same bytes, the index back to the start (docs/link-battles.md 4.1). Call only
 * at a decision point, when neither game is mid-roll.
 */
export function dealDice(rig: Rig, dice: Uint8Array): void {
  if (dice.length !== DICE_LENGTH) throw new Error(`The dice are ${DICE_LENGTH} bytes.`);
  for (const side of [0, 1] as const) {
    dice.forEach((v, i) => rig.write(side, ADDR.linkBattleRandomNumberList + i, v));
    rig.write(side, ADDR.linkBattleRandomNumberListIndex, 0);
  }
}
