import bs58 from "bs58";
import { HIGHWIRE_MEMO, MAINNET, MEMO_PROGRAM_ID } from "highwire-core/arena";
import { MAINNET_GENESIS, type RegistrationRpc, type RpcTransaction } from "./registration.ts";
import type { CoinDirectory, CoinFacts } from "./arena/referee.ts";
import type { LinkAction, LinkEngine, LinkStep } from "./link/referee.ts";
import type { LinkMatchStep, RatedSidesSpec } from "./link/arena.ts";
import { RelayError } from "./errors.ts";

// Fakes for tests of the relay and of its clients (highwire-relay/testing): an RPC that serves hand-built transactions
// in getTransaction's JSON shape, a coin directory, and a link battles engine without the emulator. Never used outside
// tests.

export const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
export const OTHER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
export const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
export const MINT2 = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const LAUNCHLAB = MAINNET.launchLabProgram;
const SYSTEM = "11111111111111111111111111111111";

let sigN = 0;
/** A fresh base58 signature-shaped string. */
export function signature(): string {
  sigN++;
  const b = new Uint8Array(64);
  b[0] = sigN & 255;
  b[1] = (sigN >> 8) & 255;
  b[63] = 7;
  return bs58.encode(b);
}

const memoIx = (text: string, programIdIndex: number) => ({ programIdIndex, accounts: [], data: bs58.encode(new TextEncoder().encode(text)) });

export interface LaunchOptions {
  payer?: string;
  mint?: string;
  platform?: string;
  memo?: string | null;
  failed?: boolean;
  discriminator?: string;
}

/** A LaunchLab initialize_v2 launch, shaped as higher.fun's launches are: payer, creator, config, platform, ..., mint at 6. */
export function launchTx(o: LaunchOptions = {}, blockTime = 1_700_000_000): RpcTransaction {
  const payer = o.payer ?? WALLET;
  const keys = [payer, payer, MAINNET.launchLabSolConfig, o.platform ?? MAINNET.rewardsPlatform, "PoolStatePoo1111111111111111111111111111111", "Vau1tVau1t111111111111111111111111111111111", o.mint ?? MINT, LAUNCHLAB, MEMO_PROGRAM_ID, SYSTEM];
  const disc = o.discriminator ?? "4399af27da102620";
  const data = new Uint8Array(40);
  for (let i = 0; i < 8; i++) data[i] = parseInt(disc.slice(i * 2, i * 2 + 2), 16);
  const ixs = [{ programIdIndex: 7, accounts: [0, 1, 2, 3, 4, 5, 6, 9], data: bs58.encode(data) }];
  if (o.memo !== null) ixs.push(memoIx(o.memo ?? HIGHWIRE_MEMO, 8));
  return { slot: 1, blockTime, meta: { err: o.failed ? { InstructionError: [0, "Custom"] } : null }, transaction: { signatures: [signature()], message: { accountKeys: keys, instructions: ixs } } };
}

/** The registration memo transaction: from `payer`, carrying `memo`, landing at `blockTimeMs`. */
export function memoTx(payer: string, memo: string, blockTimeMs: number, failed = false): RpcTransaction {
  return {
    slot: 2,
    blockTime: Math.floor(blockTimeMs / 1000),
    meta: { err: failed ? { InstructionError: [0, "Custom"] } : null },
    transaction: { signatures: [signature()], message: { accountKeys: [payer, MEMO_PROGRAM_ID], instructions: [memoIx(memo, 1)] } },
  };
}

export class FakeRpc implements RegistrationRpc {
  txs = new Map<string, RpcTransaction>();
  genesis = MAINNET_GENESIS;
  down = false;
  async genesisHash() {
    if (this.down) throw new Error("down");
    return this.genesis;
  }
  async getTransaction(sig: string) {
    if (this.down) throw new Error("down");
    return this.txs.get(sig) ?? null;
  }
  /** Files a transaction under a new signature and returns it. */
  add(tx: RpcTransaction): string {
    const sig = signature();
    this.txs.set(sig, tx);
    return sig;
  }
}

export class FakeCoins implements CoinDirectory {
  coins = new Map<string, CoinFacts>();
  constructor(now: number, creator = WALLET) {
    for (const [mint, name, ticker] of [[MINT, "Wire Cat", "WCAT"], [MINT2, "Second", "TWO"]] as const) {
      this.coins.set(mint, { name, ticker, createdAt: now - 3 * 86_400_000, holders: 40, volumeSol: 12, rugFlag: false, creatorHolds: true, creator });
    }
  }
  async coin(mint: string) {
    return this.coins.get(mint) ?? null;
  }
}

// ---------------------------------------------------------------- link battles

/** The fake rated battle's state: each side's hits left, and the turn. */
export type FakeLinkState = { hp: [number, number]; turn: number };
const HIT: LinkAction = { kind: "move", slot: 0 };
const WAIT: LinkAction = { kind: "move", slot: 1 };

/**
 * A link battles engine without the emulator, for the referee's tests and the tools': rated battles where each side has
 * three hits in it ("Hit" lands one, "Wait" doesn't), with views, fallbacks (Wait) and the house (it hits).
 */
export class FakeLinkEngine implements LinkEngine {
  starts = 0;
  resolves = 0;
  /** When set, the next resolve throws it once (a function that died). */
  failOnce: Error | null = null;
  /** When set, every resolve throws it (a turn the rig can't play). */
  failAlways: Error | null = null;
  /** When set, starts and resolutions wait for it: to hold one open while other calls arrive. */
  gateStart: Promise<void> | null = null;
  gateResolve: Promise<void> | null = null;
  /** When set, every start throws it (a rig that's down). */
  failStart: Error | null = null;
  /** When set, a resolution whose decisions it accepts is refused by the game, as an illegal action would be. */
  refuse: ((decisions: [LinkAction | null, LinkAction | null]) => boolean) | null = null;
  films: string[] = [];
  async rules() {
    return { format: "colosseum-1" };
  }
  async start(): Promise<LinkStep> {
    throw new Error("practice isn't under test here");
  }
  async move(): Promise<LinkStep> {
    throw new Error("practice isn't under test here");
  }
  async film(match: string) {
    this.films.push(match);
  }
  private step(s: FakeLinkState, sides: RatedSidesSpec): LinkMatchStep {
    const over = s.hp[0] <= 0 || s.hp[1] <= 0;
    const asked: [boolean, boolean] = [!over, !over];
    const view = (side: 0 | 1) => ({
      phase: over ? "ended" : "choose",
      turn: s.turn,
      you: { hp: s.hp[side] },
      them: { hp_percent: Math.round((s.hp[1 - side]! / 3) * 100) },
      legal: over ? [] : [{ action: HIT, label: "Hit" }, { action: WAIT, label: "Wait" }],
      only_for: `side ${side}`,
    });
    return {
      state: s,
      packed: over ? null : new TextEncoder().encode(JSON.stringify(s)),
      turn: s.turn,
      asked,
      views: [view(0), view(1)],
      spectator: { turn: s.turn, bars: s.hp.map((h) => Math.round((h / 3) * 100)) },
      fallbacks: [asked[0] && !sides.kinds[0].house ? WAIT : null, asked[1] && !sides.kinds[1].house ? WAIT : null],
      house: [asked[0] && sides.kinds[0].house ? HIT : null, asked[1] && sides.kinds[1].house ? HIT : null],
      chosen: s.turn,
      ended: over ? (s.hp[0] <= 0 && s.hp[1] <= 0 ? { reason: "draw", winner: null } : { reason: "knockout", winner: s.hp[0] <= 0 ? 1 : 0 }) : null,
      format: "colosseum-1",
      version: "v1",
      film: [s.turn],
    };
  }
  async startMatch(sides: RatedSidesSpec) {
    this.starts++;
    if (this.gateStart) await this.gateStart;
    if (this.failStart) throw this.failStart;
    return this.step({ hp: [3, 3], turn: 0 }, sides);
  }
  async resolveMatch(state: unknown, packed: Uint8Array, decisions: [LinkAction | null, LinkAction | null], sides: RatedSidesSpec) {
    this.resolves++;
    if (this.gateResolve) await this.gateResolve;
    if (this.failAlways) throw this.failAlways;
    if (this.failOnce) {
      const e = this.failOnce;
      this.failOnce = null;
      throw e;
    }
    if (this.refuse?.(decisions)) throw new RelayError("bad_request", "The game refused that action.");
    const s = JSON.parse(new TextDecoder().decode(packed)) as FakeLinkState;
    if (JSON.stringify(s) !== JSON.stringify(state)) throw new Error("the packed battle and the document disagree");
    const hp: [number, number] = [...s.hp];
    if (decisions[0]?.kind === "move" && decisions[0].slot === 0) hp[1]--;
    if (decisions[1]?.kind === "move" && decisions[1].slot === 0) hp[0]--;
    return this.step({ hp, turn: s.turn + 1 }, sides);
  }
}
