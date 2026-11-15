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
  enemyMonHP: 0xcfe5,
  enemyMonPartyPos: 0xcfe7,
  enemyMonStatus: 0xcfe8,
  enemyMonMoves: 0xcfec,
  enemyMonLevel: 0xcff2,
  enemyMonMaxHP: 0xcff3,
  battleMonHP: 0xd014,
  battleMonStatus: 0xd017,
  battleMonMoves: 0xd01b,
  battleMonLevel: 0xd021,
  battleMonMaxHP: 0xd022,
  battleMonPP: 0xd02c,
  isInBattle: 0xd056,
  battleType: 0xd059,
  criticalHitOrOHKO: 0xd05d,
  moveMissed: 0xd05e,
  playerMonNumber: 0xcc2f,
  linkState: 0xd12a,
  linkBattleRandomNumberList: 0xd147,
  partyCount: 0xd162,
  options: 0xd354,
  enemyPartyCount: 0xd89b,
} as const;

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
  same("side 0's Pokémon", a.mine, b.theirs);
  same("side 1's Pokémon", b.mine, a.theirs);
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
