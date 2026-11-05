import { createVestingAccount, getPdaVestId, LaunchpadConfig, TxVersion } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { HigherApi } from "../higher/api.ts";
import {
  CLASSIC_RESERVE,
  COMPUTE_UNITS,
  CREATOR_LOCK,
  FEE_MODES,
  LAUNCH_FEE_CAP_LAMPORTS,
  coinUrl,
  platformFor,
  type FeeMode,
} from "../higher/constants.ts";
import { HigherError, ValidationError } from "../lib/errors.ts";
import type { Chain } from "./chain.ts";
import { UnsafeTransactionError } from "./decode.ts";
import { finish, priorityFee, type BuiltTx, type Envelope } from "./envelope.ts";
import { checkSlippage } from "./quote.ts";
import { lamportsNumber } from "./units.ts";

// build_launch: higher.fun's create-coin flow (Raydium SDK
// launchpad.createLaunchpad on the fee mode's platform config, the launch fee
// as the last instruction, an optional first buy) plus, for a creator lock,
// the second transaction that assigns the locked tokens to the creator.

export interface LaunchInput {
  wallet: PublicKey;
  name: string;
  ticker: string;
  description?: string;
  /** The coin's metadata JSON, already hosted. Without it the build stops at prepared metadata. */
  metadataUri?: string;
  imageUrl?: string;
  website?: string;
  x?: string;
  telegram?: string;
  mode: FeeMode;
  /** New school only: lock this % of supply for the creator (1-10). */
  creatorLockPct?: number;
  /** Lamports for the creator's first buy, in the same transaction. */
  devBuyLamports?: bigint;
  slippageBps: number;
  /** The new coin's mint keypair. Highwire generates one per idempotency key; it only ever signs the coin's creation. */
  mint: Keypair;
  simulate?: boolean;
}

export interface LaunchFee {
  lamports: bigint;
  treasury: PublicKey;
}

export type LaunchResult =
  | { status: "needs_metadata"; metadata: LaunchMetadata; nextStep: string }
  | { status: "already_launched"; mint: string; url: string }
  | {
      status: "built";
      mint: string;
      poolId: string;
      mode: FeeMode;
      platformId: string;
      launchFee: { sol: number; treasury: string; checked: string } | null;
      devBuySol: number;
      creatorLock: { pct: number; tokens: bigint } | null;
      envelope: Envelope;
    };

export interface LaunchMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string | null;
  extensions: { website?: string; twitter?: string; telegram?: string };
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const INVISIBLE = /[\p{Cf}✓✔☑✅\u{1F5F8}\u{1F7E2}™®©]/u;

/** The checks higher.fun's create form applies, so a coin we build is one the site would accept. */
export function validateLaunch(input: LaunchInput): void {
  const bad = (m: string): never => {
    throw new ValidationError(m);
  };
  const name = input.name.normalize("NFKC").trim();
  if (name.length < 1 || name.length > 32) bad("name must be 1-32 characters");
  if (CONTROL.test(name) || INVISIBLE.test(name)) bad("name contains control, invisible or badge characters");
  if (!/^[A-Za-z0-9]{1,10}$/.test(input.ticker)) bad("ticker must be 1-10 letters or digits");
  if ((input.description ?? "").length > 500) bad("description must be at most 500 characters");
  const https = (v: string | undefined, what: string, host?: RegExp) => {
    if (v === undefined) return;
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return bad(`${what} must be a URL`);
    }
    if (u.protocol !== "https:" || v.length > 200) bad(`${what} must be an https URL of at most 200 characters`);
    if (host && !host.test(u.hostname)) bad(`${what} must be on ${host.source.replace(/\\|\^|\$|\(\?:www\\\.\)\?/g, "")}`);
  };
  https(input.website, "website");
  https(input.x, "x", /^(?:www\.)?(?:x|twitter)\.com$/);
  https(input.telegram, "telegram", /^(?:t\.me|telegram\.me)$/);
  https(input.imageUrl, "image_url");
  https(input.metadataUri, "metadata_uri");
  if (input.creatorLockPct !== undefined) {
    if (input.mode !== "rewards") bad("a creator lock needs New school (rewards); Old school coins lock higher.fun's 1% instead");
    if (!Number.isInteger(input.creatorLockPct) || input.creatorLockPct < CREATOR_LOCK.minPct || input.creatorLockPct > CREATOR_LOCK.maxPct) {
      bad(`creator lock must be a whole ${CREATOR_LOCK.minPct}-${CREATOR_LOCK.maxPct}% of supply`);
    }
  }
  if (input.devBuyLamports !== undefined && input.devBuyLamports < 0n) bad("dev buy must not be negative");
  checkSlippage(input.slippageBps);
}

/** The metadata JSON a launch points at, in the shape higher.fun uploads (Metaplex token standard). */
export function launchMetadata(input: LaunchInput): LaunchMetadata {
  return {
    name: input.name.normalize("NFKC").trim(),
    symbol: input.ticker.toUpperCase(),
    description: input.description ?? "",
    image: input.imageUrl ?? null,
    extensions: {
      ...(input.website ? { website: input.website } : {}),
      ...(input.x ? { twitter: input.x } : {}),
      ...(input.telegram ? { telegram: input.telegram } : {}),
    },
  };
}

/**
 * The launch fee, checked the way higher.fun's site checks it: at or under the
 * cap, and paid to the fee wallet recorded on-chain in the New school platform
 * config (the site checks against that one for both modes).
 */
export async function checkedLaunchFee(chain: Chain, api: HigherApi | null): Promise<LaunchFee | null> {
  if (chain.cluster !== "mainnet" || !api) return null;
  const quoted = await api.launchFee();
  const lamports = BigInt(quoted.lamports);
  if (lamports === 0n || !quoted.treasury) return null;
  if (lamports > LAUNCH_FEE_CAP_LAMPORTS) {
    throw new UnsafeTransactionError(`the launch fee (${lamportsNumber(lamports)} SOL) is above higher.fun's cap of ${lamportsNumber(LAUNCH_FEE_CAP_LAMPORTS)} SOL`);
  }
  const platform = await chain.platform(new PublicKey(platformFor(chain.cluster, "rewards")));
  if (platform.platformClaimFeeWallet.toBase58() !== quoted.treasury) {
    throw new UnsafeTransactionError("the launch fee isn't going to higher.fun's fee wallet (the API's treasury differs from the on-chain platform config)");
  }
  return { lamports, treasury: new PublicKey(quoted.treasury) };
}

export async function buildLaunch(chain: Chain, api: HigherApi | null, input: LaunchInput): Promise<LaunchResult> {
  validateLaunch(input);
  if (!input.metadataUri) {
    const metadata = launchMetadata(input);
    return {
      status: "needs_metadata",
      metadata,
      nextStep:
        "higher.fun only uploads images and metadata for a signed-in wallet (a Sign-In With Solana message), which " +
        "Highwire can't sign. Host this metadata JSON (with the image) yourself, on IPFS or Arweave, or create the coin's " +
        "metadata on higher.fun, then call build_launch again with metadata_uri set to its https URL and the same idempotency key.",
    };
  }

  const wallet = input.wallet;
  const mint = input.mint;
  const poolId = chain.launchPoolId(mint.publicKey);
  if (await chain.connection.getAccountInfo(poolId)) {
    return { status: "already_launched", mint: mint.publicKey.toBase58(), url: coinUrl(mint.publicKey.toBase58()) };
  }
  if (api && chain.cluster === "mainnet") {
    const { available } = await api.ticker(input.ticker.toUpperCase());
    if (!available) throw new ValidationError(`$${input.ticker.toUpperCase()} is taken on higher.fun. Pick another ticker.`, { code: "ticker_taken" });
  }

  const platformId = new PublicKey(platformFor(chain.cluster, input.mode));
  const [fee, launchConfig, microLamports, configInfo] = await Promise.all([
    checkedLaunchFee(chain, api),
    chain.launchConfig(),
    priorityFee(chain, [mint.publicKey, chain.key("launchLabSolConfig")]),
    chain.connection.getAccountInfo(chain.key("launchLabSolConfig")),
  ]);
  if (!configInfo) throw new HigherError("LaunchLab config not found", { code: "unavailable" });
  const supply = BigInt(launchConfig.defaultParams.supplyInit);

  let lock: { amount: bigint; cliff: number; unlock: number; supply?: bigint } | null = null;
  if (input.mode === "classic") {
    lock = { amount: (supply * BigInt(CLASSIC_RESERVE.pct)) / 100n, cliff: CLASSIC_RESERVE.cliffSeconds, unlock: CLASSIC_RESERVE.unlockSeconds, supply };
  } else if (input.creatorLockPct) {
    const maxLockRate = BigInt(LaunchpadConfig.decode(configInfo.data).maxLockRate.toString());
    if (10_000n * BigInt(input.creatorLockPct) > maxLockRate) throw new ValidationError("that lock exceeds LaunchLab's cap for this config");
    lock = { amount: (supply * BigInt(input.creatorLockPct)) / 100n, cliff: CREATOR_LOCK.cliffSeconds, unlock: CREATOR_LOCK.unlockSeconds };
  }

  const devBuy = input.devBuyLamports ?? 0n;
  const raydium = await chain.raydium(wallet);
  const created = await raydium.launchpad.createLaunchpad({
    computeBudgetConfig: { units: COMPUTE_UNITS.create, microLamports },
    ...(fee ? { txTipConfig: { address: fee.treasury, amount: new BN(fee.lamports.toString()) } } : {}),
    programId: chain.key("launchLabProgram"),
    authProgramId: chain.key("launchLabAuth"),
    platformId,
    configId: chain.key("launchLabSolConfig"),
    mintA: mint.publicKey,
    decimals: 6,
    mintBDecimals: 9,
    name: launchMetadata(input).name,
    symbol: input.ticker.toUpperCase(),
    uri: input.metadataUri,
    migrateType: "cpmm",
    buyAmount: new BN(devBuy.toString()),
    createOnly: devBuy === 0n,
    slippage: new BN(input.slippageBps),
    ...(lock?.supply !== undefined ? { supply: new BN(lock.supply.toString()) } : {}),
    ...(lock
      ? { totalLockedAmount: new BN(lock.amount.toString()), cliffPeriod: new BN(lock.cliff), unlockPeriod: new BN(lock.unlock) }
      : {}),
    extraSigners: [mint],
    feePayer: wallet,
    txVersion: TxVersion.V0,
  });
  const sdkPoolId = created.extInfo.address.poolId;
  if (!sdkPoolId.equals(poolId)) throw new UnsafeTransactionError("the SDK built a launch for a different pool");

  const expectBase = { wallet, platformId, extraSigners: [mint.publicKey] };
  const feeExpect = fee ? { launchFee: { to: fee.treasury, maxLamports: fee.lamports } } : {};
  const txs: BuiltTx[] = created.transactions.map((t, i) => {
    if (!(t instanceof VersionedTransaction)) throw new Error("expected v0 transactions from createLaunchpad");
    const needsMint = t.message.staticAccountKeys
      .slice(0, t.message.header.numRequiredSignatures)
      .some((k) => k.equals(mint.publicKey));
    return {
      tx: t,
      label: i === 0 ? (devBuy > 0n && created.transactions.length === 1 ? "create the coin and make the first buy" : "create the coin") : "first buy",
      presign: needsMint ? [mint] : [],
      dependsOn: i === 0 ? [] : [0],
      // The fee rides on the last instruction of the create; the checker needs it on whichever transaction carries it.
      expect: { ...expectBase, ...(t.message.compiledInstructions.length && hasTransferTo(t, fee?.treasury) ? feeExpect : {}) },
    };
  });

  if (input.mode === "rewards" && lock) {
    const vestingRecord = getPdaVestId(chain.key("launchLabProgram"), poolId, wallet).publicKey;
    const ix = createVestingAccount(chain.key("launchLabProgram"), wallet, wallet, poolId, vestingRecord, new BN(lock.amount.toString()));
    const { blockhash } = await chain.connection.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
    txs.push({ tx, label: "assign the creator lock to the creator", dependsOn: [0], expect: { wallet, vestingPool: poolId } });
  }

  const done = await finish({ chain, wallet, kind: "launch", txs, simulate: input.simulate });

  // The checks higher.fun's site runs on a launch before it asks the wallet to sign.
  const launches = done.decoded.flatMap((d) => d.launches);
  if (launches.length !== 1) throw new UnsafeTransactionError("expected exactly one coin creation");
  const l = launches[0]!;
  if (l.mint !== mint.publicKey.toBase58()) throw new UnsafeTransactionError("the coin's address isn't the one generated for it");
  if (l.creator !== wallet.toBase58()) throw new UnsafeTransactionError("the coin isn't being created for the wallet");
  if (l.platform !== platformId.toBase58()) throw new UnsafeTransactionError("the coin isn't launching with the fee mode you picked");
  if (fee) {
    const paid = done.decoded.flatMap((d) => d.transfers).filter((t) => t.to === fee.treasury.toBase58());
    if (paid.length !== 1 || paid[0]!.lamports !== fee.lamports) throw new UnsafeTransactionError("the launch fee in the transaction isn't the one quoted");
  }
  const trades = done.decoded.flatMap((d) => d.trades);
  if (devBuy > 0n) {
    if (trades.length !== 1 || trades[0]!.kind !== "curve-buy") throw new UnsafeTransactionError("expected exactly one first buy");
    if (trades[0]!.amountIn !== devBuy) throw new UnsafeTransactionError("the first buy spends a different amount than asked");
    if (trades[0]!.minOut <= 0n) throw new UnsafeTransactionError("the first buy has no minimum-out guard");
  } else if (trades.length > 0) {
    throw new UnsafeTransactionError("the transaction trades although no first buy was asked for");
  }

  return {
    status: "built",
    mint: mint.publicKey.toBase58(),
    poolId: poolId.toBase58(),
    mode: input.mode,
    platformId: platformId.toBase58(),
    launchFee: fee
      ? { sol: lamportsNumber(fee.lamports), treasury: fee.treasury.toBase58(), checked: "treasury matches the platform's on-chain fee wallet; under the cap" }
      : null,
    devBuySol: lamportsNumber(devBuy),
    creatorLock: input.mode === "rewards" && lock && input.creatorLockPct ? { pct: input.creatorLockPct, tokens: lock.amount } : null,
    envelope: done.envelope,
  };
}

function hasTransferTo(tx: VersionedTransaction, to: PublicKey | undefined): boolean {
  if (!to) return false;
  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions.some(
    (ix) =>
      keys[ix.programIdIndex]?.toBase58() === "11111111111111111111111111111111" &&
      ix.data.length === 12 &&
      Buffer.from(ix.data).readUInt32LE(0) === 2 &&
      keys[ix.accountKeyIndexes[1] ?? -1]?.equals(to),
  );
}

export function describeFeeMode(mode: FeeMode) {
  const m = FEE_MODES[mode];
  return { mode, label: m.label, summary: m.summary };
}

/** What makes two build_launch calls the same coin. Metadata and the first buy may change between retries. */
export function launchFingerprint(cluster: string, input: Pick<LaunchInput, "wallet" | "name" | "ticker" | "mode">): string {
  return [cluster, input.wallet.toBase58(), input.name.normalize("NFKC").trim(), input.ticker.toUpperCase(), input.mode].join("|");
}

/**
 * Mint keypairs by idempotency key, so a retried build_launch reuses the same
 * mint: the coin can only be created once, and the launch fee rides in the same
 * transaction, so a retry never pays twice. Held in memory only.
 */
export class LaunchKeys {
  private readonly entries = new Map<string, { fingerprint: string; mint: Keypair; at: number }>();
  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000, private readonly max = 1000) {}

  get(key: string, fingerprint: string, now = Date.now()): Keypair {
    for (const [k, e] of this.entries) if (now - e.at > this.ttlMs) this.entries.delete(k);
    const found = this.entries.get(key);
    if (found) {
      if (found.fingerprint !== fingerprint) {
        throw new ValidationError("This idempotency key was used for a different launch. Use a new key for a new coin.", {
          code: "idempotency_conflict",
        });
      }
      return found.mint;
    }
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const mint = Keypair.generate();
    this.entries.set(key, { fingerprint, mint, at: now });
    return mint;
  }
}
