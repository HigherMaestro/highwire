import bs58 from "bs58";
import { HIGHWIRE_MEMO, MAINNET, MEMO_PROGRAM_ID } from "highwire-core/arena";
import { MAINNET_GENESIS, type RegistrationRpc, type RpcTransaction } from "./registration.ts";
import type { CoinDirectory, CoinFacts } from "./arena/referee.ts";

// Fakes for tests of the relay and of its clients (highwire-relay/testing): an RPC that serves hand-built transactions
// in getTransaction's JSON shape, and a coin directory. Never used outside tests.

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

