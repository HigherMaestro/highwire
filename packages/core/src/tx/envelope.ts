import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Keypair,
} from "@solana/web3.js";
import { HIGHWIRE_MEMO, MEMO_PROGRAM_ID, PRIORITY_FEE_MICRO_LAMPORTS } from "../higher/constants.ts";
import { HigherError } from "../lib/errors.ts";
import type { Chain } from "./chain.ts";
import { assertSafe, describeTransaction, summaryLines, type DecodedTransaction, type Expectations } from "./decode.ts";
import { ENVELOPE_FORMAT, HOW_TO_SIGN, type Envelope, type Simulation, type UnsignedTransaction } from "./format.ts";

// Every built transaction ends here: the Highwire memo is added, then the
// allow-list check, plain-language decoding and simulation, and the result is
// wrapped in the envelope (format.ts, docs/unsigned-transactions.md).

export * from "./format.ts";

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

/** The largest serialized transaction Solana accepts. */
export const MAX_TX_BYTES = 1232;
/** What the memo adds to a transaction at most: its program's address and the instruction. */
export const MEMO_RESERVE_BYTES = 48;

/** The attribution memo: SPL Memo v2 with the text "highwire", and no accounts (so no extra signer). */
export function highwireMemo(): TransactionInstruction {
  return new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from(HIGHWIRE_MEMO, "utf8") });
}

/**
 * Recompiles a transaction with the Highwire memo as its last instruction. Lookup tables are dropped when the
 * transaction still fits without them, so every account is visible in the bytes; otherwise they are kept.
 */
export function withHighwireMemo(tx: VersionedTransaction, tables: AddressLookupTableAccount[]): VersionedTransaction {
  const msg = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables });
  msg.instructions.push(highwireMemo());
  const fits = (t: VersionedTransaction) => {
    try {
      return t.serialize().length <= MAX_TX_BYTES;
    } catch {
      return false;
    }
  };
  try {
    const flat = new VersionedTransaction(msg.compileToV0Message());
    if (fits(flat)) return flat;
  } catch {
    /* too many accounts without the tables */
  }
  const used = tables.filter((t) => tx.message.addressTableLookups.some((l) => l.accountKey.equals(t.key)));
  const packed = new VersionedTransaction(msg.compileToV0Message(used));
  if (!fits(packed)) throw new HigherError("the transaction is too large for Solana once the Highwire memo is added", { code: "too_large" });
  return packed;
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
    const rebuilt = withHighwireMemo(b.tx, tables);
    rebuilt.message.recentBlockhash = blockhash;
    const tx = new VersionedTransaction(rebuilt.message);
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
      builtAt: Math.floor(Date.now() / 1000),
      howToSign: HOW_TO_SIGN,
    },
    decoded,
  };
}

/** The first failed simulation, if any. */
export function failedSimulation(env: Envelope): UnsignedTransaction | undefined {
  return env.transactions.find((t) => !t.simulation.ok && !t.simulation.skipped);
}
