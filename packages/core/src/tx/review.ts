import { Buffer } from "buffer";
import { PublicKey, VersionedTransaction, type AddressLookupTableAccount } from "@solana/web3.js";
import { ADDRESSES, feeModeOfPlatform, LAUNCH_FEE_CAP_LAMPORTS, type Cluster } from "../higher/constants.ts";
import {
  assertSafe,
  describeTransaction,
  DISCRIMINATORS,
  NATIVE_MINT_ADDRESS,
  PROGRAMS,
  resolveInstructions,
  summaryLines,
  UnsafeTransactionError,
  type DecodedTransaction,
  type Expectations,
} from "./decode.ts";
import type { Envelope } from "./format.ts";
import { MAX_CLOCK_SKEW_SECONDS } from "./refresh.ts";
import { formatLamports, formatTokens } from "./units.ts";

// The review the signing page runs before it lets a wallet sign. A sign link
// can come from anyone, so nothing in the envelope is trusted except the bytes:
// each transaction is decoded again from its base64, its summary is rebuilt
// from the instructions, and it must pass the same allow-list Highwire's
// builders enforce, with the expectations inferred from the bytes and pinned
// to higher.fun's own platform configs and fee wallet.
//
// Browser-safe: web3.js and plain modules only.

/** Where the launch-fee wallet sits in a LaunchLab PlatformConfig account: after the discriminator and the epoch. */
export const PLATFORM_CLAIM_FEE_WALLET_OFFSET = 16;

/** Reads `platformClaimFeeWallet` from a LaunchLab PlatformConfig account's data. */
export function platformClaimFeeWallet(data: Uint8Array): string {
  if (data.length < PLATFORM_CLAIM_FEE_WALLET_OFFSET + 32) throw new UnsafeTransactionError("the platform config account is too short");
  return new PublicKey(data.subarray(PLATFORM_CLAIM_FEE_WALLET_OFFSET, PLATFORM_CLAIM_FEE_WALLET_OFFSET + 32)).toBase58();
}

export interface ReviewContext {
  /** The page's clock, in unix seconds: a link that claims to be built later than this (and some skew) is refused. */
  now?: number;
  /** What verifyAttestation said about the link: "invalid" means it was changed after highwire.fun built it. */
  attestation?: "verified" | "unverified" | "invalid";
  /**
   * higher.fun's launch-fee wallet, read on-chain from the New school platform config (the same check the builder
   * runs). Without it, a launch that pays a fee fails the review.
   */
  launchFeeWallet?: string | null;
  /** Lookup tables the transactions use, fetched from the RPC. */
  lookupTables?: AddressLookupTableAccount[];
}

export interface Effect {
  /** What leaves the wallet, what arrives, or what else happens. */
  kind: "spend" | "receive" | "other";
  text: string;
}

export interface ReviewedTransaction {
  index: number;
  /** What the transaction does, rebuilt from its bytes. The link's own label is never shown: anyone can write it. */
  label: string;
  tx: VersionedTransaction | null;
  decoded: DecodedTransaction | null;
  /** Rebuilt from the bytes. Show this, not the envelope's own summary. */
  summary: string[];
  /** Whether the envelope's summary says the same as the bytes. */
  summaryMatches: boolean;
  effects: Effect[];
  /** Lamports: 5,000 per signature. */
  networkFeeLamports: bigint;
  /** Lamports: the compute limit times the priority fee, the most the priority fee can cost. */
  priorityFeeLamports: bigint;
  dependsOn: number[];
  /** Reasons not to sign. Empty means the transaction passed every check. */
  problems: string[];
}

export interface EnvelopeReview {
  cluster: Cluster;
  wallet: string;
  /** What the transactions do, from their bytes: what the page's title says, whatever the link calls itself. */
  kind: Envelope["kind"];
  transactions: ReviewedTransaction[];
  /** Every problem, prefixed with its transaction. Empty means safe to offer for signing (simulation still to come). */
  problems: string[];
  /** The mints of coins this envelope creates. */
  launches: string[];
  /** Coins traded, by mint. */
  coins: string[];
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const DEFAULT_CU_PER_IX = 200_000n;

function decodeBytes(base64: string): VersionedTransaction {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
  if (tx.version !== 0) throw new UnsafeTransactionError("not a v0 transaction");
  return tx;
}

function effectsOf(d: DecodedTransaction, launchFeeWallet: string | null | undefined): Effect[] {
  const out: Effect[] = [];
  for (const l of d.launches) out.push({ kind: "other", text: `Create the coin $${l.symbol} ("${l.name}"), mint ${l.mint}` });
  for (const t of d.trades) {
    if (t.kind === "curve-buy") {
      out.push({ kind: "spend", text: `${formatLamports(t.amountIn)} SOL` });
      out.push({ kind: "receive", text: `at least ${formatTokens(t.minOut)} tokens of ${t.mint}` });
    } else if (t.kind === "curve-sell") {
      out.push({ kind: "spend", text: `${formatTokens(t.amountIn)} tokens of ${t.mint}` });
      out.push({ kind: "receive", text: `at least ${formatLamports(t.minOut)} SOL` });
    } else if (t.inputMint === NATIVE_MINT_ADDRESS) {
      out.push({ kind: "spend", text: `${formatLamports(t.amountIn)} SOL` });
      out.push({ kind: "receive", text: `at least ${formatTokens(t.minOut)} tokens of ${t.outputMint}` });
    } else {
      out.push({ kind: "spend", text: `${formatTokens(t.amountIn)} tokens of ${t.inputMint}` });
      out.push({ kind: "receive", text: `at least ${formatLamports(t.minOut)} SOL` });
    }
  }
  for (const t of d.transfers) {
    if (launchFeeWallet && t.to === launchFeeWallet) out.push({ kind: "spend", text: `${formatLamports(t.lamports)} SOL launch fee to higher.fun (${t.to})` });
  }
  for (const c of d.claims) {
    out.push({ kind: "receive", text: c.kind === "curve" ? "your curve creator fees, as SOL" : `your creator fees from Raydium pool ${c.from}` });
  }
  for (const l of d.locks) out.push({ kind: "other", text: `Lock ${formatTokens(l.amount)} tokens for you, vesting after graduation (pool ${l.pool})` });
  return out;
}

/** A transaction's title, from what its instructions do. */
function titleOf(d: DecodedTransaction): string {
  const launch = d.launches[0];
  if (launch) return d.trades.length ? `Create the coin $${launch.symbol} and buy some` : `Create the coin $${launch.symbol}`;
  if (d.claims.length) return "Claim your creator fees";
  if (d.locks.length) return "Lock some of your new coin's supply for you";
  const t = d.trades[0];
  if (t?.kind === "curve-buy") return "Buy a coin on the bonding curve";
  if (t?.kind === "curve-sell") return "Sell a coin on the bonding curve";
  if (t?.kind === "cpmm-swap") return t.inputMint === NATIVE_MINT_ADDRESS ? "Buy a coin in its Raydium pool" : "Sell a coin in its Raydium pool";
  if (d.transfers.length || d.tokenTransfers.length) return "Send to another wallet";
  return "A transaction";
}

/** What kind of envelope these transactions make, from their bytes. */
function kindOf(txs: ReviewedTransaction[]): Envelope["kind"] | null {
  const d = txs.map((t) => t.decoded).filter((x): x is DecodedTransaction => x !== null);
  if (d.some((x) => x.launches.length)) return "launch";
  if (d.some((x) => x.claims.length)) return "claim";
  if (d.some((x) => x.trades.length)) return "trade";
  if (d.some((x) => x.transfers.length || x.tokenTransfers.length)) return "transfer";
  return null;
}

/**
 * How much worse than the simulated outcome a trade accepts, in percent: its minimum out against what the simulation
 * actually gets (token base units on a buy, lamports on a sell). Null when there's nothing to compare.
 */
export function acceptedSlippagePct(minOut: bigint, simulatedOut: bigint): number | null {
  if (simulatedOut <= 0n) return null;
  if (minOut >= simulatedOut) return 0;
  return Number(((simulatedOut - minOut) * 10_000n) / simulatedOut) / 100;
}

/** What the transaction must stick to, worked out from its own instructions and pinned to higher.fun's addresses. */
function expectationsOf(
  tx: VersionedTransaction,
  cluster: Cluster,
  wallet: PublicKey,
  presigned: string[],
  ctx: ReviewContext,
  createdPools: string[],
  problems: string[],
): Expectations {
  const a = ADDRESSES[cluster];
  const L = DISCRIMINATORS.launchLab;
  const ixs = resolveInstructions(tx, ctx.lookupTables ?? []);
  const platforms = new Set<string>();
  const mints: string[] = [];
  let creates = 0;
  let feeTransfer = false;
  for (const ix of ixs) {
    const p = ix.programId.toBase58();
    if (p === a.launchLabProgram) {
      const disc = hex(ix.data.subarray(0, 8));
      if (disc === L.initializeV2 || disc === L.buyExactIn || disc === L.sellExactIn) platforms.add(ix.keys[3]?.toBase58() ?? "?");
      if (disc === L.initializeV2) {
        creates++;
        mints.push(ix.keys[6]?.toBase58() ?? "?");
      }
    }
    if (p === PROGRAMS.system && ctx.launchFeeWallet && ix.data.length === 12 && ix.data.readUInt32LE(0) === 2) {
      if (ix.keys[1]?.toBase58() === ctx.launchFeeWallet) feeTransfer = true;
    }
  }
  let platformId: PublicKey | undefined;
  if (platforms.size > 1) problems.push("it trades or launches on more than one LaunchLab platform");
  else if (platforms.size === 1) {
    const id = [...platforms][0]!;
    if (!feeModeOfPlatform(cluster, id)) problems.push(`it uses LaunchLab platform ${id}, which isn't higher.fun's`);
    else platformId = new PublicKey(id);
  }
  if (feeTransfer && creates === 0) problems.push("it pays a launch fee without launching a coin");
  // The only extra signer allowed is the new coin's mint, already signed by Highwire.
  const extraSigners = mints.filter((m) => presigned.includes(m)).map((m) => new PublicKey(m));
  return {
    wallet,
    platformId,
    extraSigners,
    ...(feeTransfer && ctx.launchFeeWallet ? { launchFee: { to: new PublicKey(ctx.launchFeeWallet), maxLamports: LAUNCH_FEE_CAP_LAMPORTS } } : {}),
    ...(createdPools.length === 1 ? { vestingPool: new PublicKey(createdPools[0]!) } : {}),
  };
}

/**
 * Re-checks every transaction in an envelope from its bytes. Never throws for a bad transaction: each problem is
 * reported, and a transaction with any problem must not be signed.
 */
export function reviewEnvelope(env: Envelope, ctx: ReviewContext = {}): EnvelopeReview {
  const cluster = env.cluster;
  const wallet = new PublicKey(env.wallet);
  const createdPools: string[] = [];
  const transactions: ReviewedTransaction[] = env.transactions.map((t) => {
    const problems: string[] = [];
    const base: ReviewedTransaction = {
      index: t.index,
      label: `Transaction ${t.index + 1}`,
      tx: null,
      decoded: null,
      summary: [],
      summaryMatches: false,
      effects: [],
      networkFeeLamports: 0n,
      priorityFeeLamports: 0n,
      dependsOn: t.dependsOn,
      problems,
    };
    let tx: VersionedTransaction;
    try {
      tx = decodeBytes(t.base64);
    } catch (err) {
      problems.push(`its bytes aren't a v0 Solana transaction (${err instanceof Error ? err.message : String(err)})`);
      return base;
    }
    base.tx = tx;
    if (t.walletSigner !== env.wallet || t.feePayer !== env.wallet) problems.push("it names a different wallet than the envelope");
    if (!tx.message.staticAccountKeys[0]?.equals(wallet)) problems.push("the fee payer isn't the envelope's wallet");
    if (tx.message.recentBlockhash !== t.recentBlockhash) problems.push("its blockhash differs from the one the envelope reports");

    // Signatures: the wallet's slot must be empty; every other required signer must be presigned.
    const required = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58());
    required.forEach((s, i) => {
      const signed = tx.signatures[i]?.some((b) => b !== 0) ?? false;
      if (s === env.wallet) {
        if (signed) problems.push("it already carries a signature for your wallet");
      } else if (!t.presigned.includes(s) || !signed) problems.push(`it needs a signature from ${s}, which isn't yours or presigned`);
    });

    let decoded: DecodedTransaction;
    try {
      decoded = describeTransaction(tx, cluster, ctx.lookupTables ?? []);
    } catch (err) {
      problems.push(`it can't be decoded (${err instanceof Error ? err.message : String(err)}); its lookup tables may be missing`);
      return base;
    }
    base.decoded = decoded;
    base.label = titleOf(decoded);
    base.summary = summaryLines(decoded);
    base.summaryMatches = base.summary.length === t.summary.length && base.summary.every((l, i) => l === t.summary[i]);
    decoded.instructions.forEach((ix, i) => {
      if (!ix.known) problems.push(`instruction ${i + 1} isn't one Highwire builds`);
    });

    try {
      assertSafe(tx, cluster, expectationsOf(tx, cluster, wallet, t.presigned, ctx, createdPools, problems), ctx.lookupTables ?? []);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
    if (decoded.launches.some((l) => l.creator !== env.wallet)) problems.push("it creates a coin for someone else");
    if (decoded.locks.some((l) => l.beneficiary !== env.wallet)) problems.push("it assigns a lock to someone else");
    createdPools.push(...decoded.launches.map((l) => l.pool));

    base.effects = effectsOf(decoded, ctx.launchFeeWallet);
    base.networkFeeLamports = 5_000n * BigInt(tx.message.header.numRequiredSignatures);
    const limit = decoded.computeUnitLimit !== undefined ? BigInt(decoded.computeUnitLimit) : DEFAULT_CU_PER_IX * BigInt(decoded.instructions.length);
    base.priorityFeeLamports = ((decoded.microLamportsPerCu ?? 0n) * limit + 999_999n) / 1_000_000n;
    return base;
  });

  const problems = transactions.flatMap((t) => t.problems.map((p) => `Transaction ${t.index + 1}: ${p}`));
  const kind = kindOf(transactions);
  if (kind && kind !== env.kind) problems.push(`The link calls itself a ${env.kind}, but its transactions are a ${kind}`);
  if (ctx.attestation === "invalid") problems.push("The link carries highwire.fun's signature, but something in it was changed after it was built");
  if (env.builtAt !== undefined && ctx.now !== undefined && env.builtAt > ctx.now + MAX_CLOCK_SKEW_SECONDS) {
    problems.push("The link says it was built in the future, so its age can't be trusted");
  }
  return {
    cluster,
    wallet: env.wallet,
    kind: kind ?? env.kind,
    transactions,
    problems,
    launches: transactions.flatMap((t) => t.decoded?.launches.map((l) => l.mint) ?? []),
    coins: [
      ...new Set(
        transactions.flatMap(
          (t) => t.decoded?.trades.map((tr) => tr.mint ?? (tr.inputMint === NATIVE_MINT_ADDRESS ? tr.outputMint : tr.inputMint) ?? "") ?? [],
        ),
      ),
    ].filter(Boolean),
  };
}

/** Every lookup table the envelope's transactions use, so the page can fetch them before reviewing. */
export function lookupTableAddresses(env: Envelope): string[] {
  const out = new Set<string>();
  for (const t of env.transactions) {
    try {
      for (const l of decodeBytes(t.base64).message.addressTableLookups) out.add(l.accountKey.toBase58());
    } catch {
      /* reported by the review */
    }
  }
  return [...out];
}
