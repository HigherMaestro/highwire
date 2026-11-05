import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Keypair,
} from "@solana/web3.js";
import { PRIORITY_FEE_MICRO_LAMPORTS, type Cluster } from "../higher/constants.ts";
import type { Chain } from "./chain.ts";
import { assertSafe, describeTransaction, summaryLines, type DecodedTransaction, type Expectations } from "./decode.ts";

// The unsigned-transaction contract every build tool returns, and the
// simulation that checks each transaction before it is handed over.
// docs/unsigned-transactions.md describes the format for wallets and for the
// signing page on highwire.fun.

export const ENVELOPE_FORMAT = "highwire.unsigned-tx/v1";

export interface Simulation {
  ok: boolean;
  /** Not simulated: why. */
  skipped?: string;
  unitsConsumed?: number | null;
  error?: string;
  /** The last program log lines, for debugging a failure. */
  logs?: string[];
}

export interface UnsignedTransaction {
  index: number;
  label: string;
  /** A serialized v0 VersionedTransaction, base64. Signature slots are zero except presigned ones. */
  base64: string;
  encoding: "base64";
  version: 0;
  feePayer: string;
  /** Every signer the message requires, in order. */
  signers: string[];
  /** Signers whose signatures are already in the transaction (the new mint on a launch). */
  presigned: string[];
  /** The signer the user's wallet must add. */
  walletSigner: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  /** Indexes of transactions that must land first. */
  dependsOn: number[];
  summary: string[];
  fullyDecoded: boolean;
  simulation: Simulation;
}

export interface Envelope {
  format: typeof ENVELOPE_FORMAT;
  cluster: Cluster;
  wallet: string;
  kind: "trade" | "launch" | "claim";
  /** Sign and send in this order, each after the one before has confirmed. */
  transactions: UnsignedTransaction[];
  /** The block height after which the first transaction's blockhash expires; rebuild after it. */
  expiresAfterBlockHeight: number;
  howToSign: string;
}

export const HOW_TO_SIGN =
  "Each transaction is unsigned (except for any presigned new mint). Have the wallet in `walletSigner` sign it, " +
  "without changing it, and send the transactions in order, each after the one before has confirmed. " +
  "Blockhashes expire after about a minute: rebuild if sending fails with an expired blockhash. Never share a private key.";

/** Priority fee in micro-lamports per CU: the 75th percentile on these accounts, clamped as higher.fun's site does. */
export async function priorityFee(chain: Chain, accounts: PublicKey[]): Promise<number> {
  let fee: number = PRIORITY_FEE_MICRO_LAMPORTS.min;
  try {
    const recent = (await chain.connection.getRecentPrioritizationFees({ lockedWritableAccounts: accounts.slice(0, 128) }))
      .map((f) => f.prioritizationFee)
      .filter((f) => f > 0)
      .sort((a, b) => a - b);
    const p75 = recent[Math.floor(recent.length * 0.75)];
    if (p75 !== undefined) fee = p75;
  } catch {
    /* use the floor */
  }
  return Math.min(PRIORITY_FEE_MICRO_LAMPORTS.max, Math.max(PRIORITY_FEE_MICRO_LAMPORTS.min, Math.round(fee)));
}

function lastLogLines(logs: string[] | null | undefined, n = 12): string[] {
  return (logs ?? []).slice(-n);
}

function simulationError(err: unknown, logs: string[]): string {
  const rev = [...logs].reverse();
  const line = rev.find((l) => /^Program log: (AnchorError|Error)/.test(l)) ?? rev.find((l) => /Error|failed|insufficient/i.test(l));
  return (line?.replace(/^Program log: /, "") ?? JSON.stringify(err)).slice(0, 300);
}

/** simulateTransaction with sigVerify off and a fresh blockhash: checks the program logic without any signature. */
export async function simulate(chain: Chain, tx: VersionedTransaction): Promise<Simulation> {
  const res = await chain.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  const logs = res.value.logs ?? [];
  if (res.value.err) return { ok: false, unitsConsumed: res.value.unitsConsumed ?? null, error: simulationError(res.value.err, logs), logs: lastLogLines(logs) };
  return { ok: true, unitsConsumed: res.value.unitsConsumed ?? null };
}

/** Rebuilds a transaction without lookup tables when it still fits, so every account is visible in the bytes. */
export function withoutLookupTables(tx: VersionedTransaction, tables: AddressLookupTableAccount[]): VersionedTransaction {
  if (tx.message.addressTableLookups.length === 0) return tx;
  const msg = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables });
  try {
    const flat = new VersionedTransaction(msg.compileToV0Message());
    if (flat.serialize().length <= 1232) return flat;
  } catch {
    /* too large without the tables */
  }
  return tx;
}

export interface BuiltTx {
  tx: VersionedTransaction;
  label: string;
  /** Keypairs Highwire generated for this transaction (a new mint) and signs with before handing over. */
  presign?: Keypair[];
  dependsOn?: number[];
  expect: Expectations;
}

export interface FinishOptions {
  chain: Chain;
  wallet: PublicKey;
  kind: Envelope["kind"];
  txs: BuiltTx[];
  /** Simulate transactions that don't depend on an earlier one. Default true. */
  simulate?: boolean;
}

export interface Finished {
  envelope: Envelope;
  decoded: DecodedTransaction[];
}

/**
 * Checks, decodes, presigns and simulates built transactions and wraps them in
 * the envelope. Throws UnsafeTransactionError if any check fails.
 */
export async function finish(opts: FinishOptions): Promise<Finished> {
  const { chain, wallet } = opts;
  const tables = await chain.lookupTables(opts.txs.map((t) => t.tx));
  const { blockhash, lastValidBlockHeight } = await chain.connection.getLatestBlockhash("confirmed");
  const decoded: DecodedTransaction[] = [];
  const out: UnsignedTransaction[] = [];
  for (const [index, b] of opts.txs.entries()) {
    const flat = withoutLookupTables(b.tx, tables);
    flat.message.recentBlockhash = blockhash;
    const tx = new VersionedTransaction(flat.message);
    assertSafe(tx, chain.cluster, b.expect, tables);
    if (b.presign?.length) tx.sign(b.presign);
    const d = describeTransaction(tx, chain.cluster, tables);
    decoded.push(d);
    const dependsOn = b.dependsOn ?? [];
    const sim: Simulation =
      opts.simulate === false
        ? { ok: false, skipped: "simulation turned off" }
        : dependsOn.length > 0
          ? { ok: false, skipped: `needs transaction ${dependsOn.map((i) => i + 1).join(", ")} to land first` }
          : await simulate(chain, tx);
    const signers = d.signers;
    const presigned = (b.presign ?? []).map((k) => k.publicKey.toBase58());
    out.push({
      index,
      label: b.label,
      base64: Buffer.from(tx.serialize()).toString("base64"),
      encoding: "base64",
      version: 0,
      feePayer: d.feePayer,
      signers,
      presigned,
      walletSigner: wallet.toBase58(),
      recentBlockhash: blockhash,
      lastValidBlockHeight,
      dependsOn,
      summary: summaryLines(d),
      fullyDecoded: d.instructions.every((i) => i.known),
      simulation: sim,
    });
  }
  return {
    envelope: {
      format: ENVELOPE_FORMAT,
      cluster: chain.cluster,
      wallet: wallet.toBase58(),
      kind: opts.kind,
      transactions: out,
      expiresAfterBlockHeight: lastValidBlockHeight,
      howToSign: HOW_TO_SIGN,
    },
    decoded,
  };
}

/** The first failed simulation, if any. */
export function failedSimulation(env: Envelope): UnsignedTransaction | undefined {
  return env.transactions.find((t) => !t.simulation.ok && !t.simulation.skipped);
}
