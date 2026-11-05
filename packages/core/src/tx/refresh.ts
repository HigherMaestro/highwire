import { Buffer } from "buffer";
import { VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { UnsafeTransactionError } from "./decode.ts";
import type { Envelope, UnsignedTransaction } from "./format.ts";

// Blockhash refresh for the sign page. A blockhash lasts about a minute, too
// short for someone reading a summary in a chat app. A transaction that only
// the user's wallet signs can take a fresh blockhash without changing anything
// else, so the page swaps it in (on load and again right before the wallet
// sees it) while the link is at most REFRESH_MAX_AGE_SECONDS old. Anything
// already signed by another key (a launch's new mint) can't: a new blockhash
// would void that signature, so it keeps its original expiry.
//
// Browser-safe: web3.js and plain modules only.

/** A link refreshes for this long after it was built. Past it, the page refuses: quotes move. */
export const REFRESH_MAX_AGE_SECONDS = 10 * 60;
/** Past this age the page warns that the quote is old (its minimum out still holds). */
export const STALE_WARNING_SECONDS = 5 * 60;

export interface LatestBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
}

const empty = (sig: Uint8Array | undefined) => !sig || sig.every((b) => b === 0);

/**
 * Whether a transaction may take a fresh blockhash: every required signature other than `wallet`'s is empty. With the
 * review requiring every non-wallet signer to be presigned, that means the wallet is its only signer.
 */
export function isRefreshable(tx: VersionedTransaction, wallet: string): boolean {
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
  return signers.every((k, i) => k.toBase58() === wallet || empty(tx.signatures[i]));
}

/** The link's age in seconds, or null for a link with no `builtAt` (v1), which never refreshes. */
export function linkAgeSeconds(env: Pick<Envelope, "builtAt">, nowSeconds: number): number | null {
  return env.builtAt === undefined ? null : Math.max(0, nowSeconds - env.builtAt);
}

/** Whether the link is young enough to refresh. */
export function canRefresh(env: Pick<Envelope, "builtAt">, nowSeconds: number): boolean {
  const age = linkAgeSeconds(env, nowSeconds);
  return age !== null && age <= REFRESH_MAX_AGE_SECONDS;
}

const messageBytes = (m: VersionedMessage) => Buffer.from(m.serialize());

/**
 * Whether two transactions are byte-identical except for the message's recent blockhash: same version, header,
 * accounts, lookups, instructions and data, and the same number of signature slots.
 */
export function sameExceptBlockhash(a: VersionedTransaction, b: VersionedTransaction): boolean {
  if (a.version !== b.version || a.signatures.length !== b.signatures.length) return false;
  const copy = VersionedMessage.deserialize(a.message.serialize());
  copy.recentBlockhash = b.message.recentBlockhash;
  return messageBytes(copy).equals(messageBytes(b.message));
}

/**
 * The transaction with only its blockhash replaced, and every signature slot empty. Throws UnsafeTransactionError if
 * the transaction isn't refreshable, or if the result differs from the original in anything but the blockhash.
 */
export function withBlockhash(tx: VersionedTransaction, wallet: string, blockhash: string): VersionedTransaction {
  if (!isRefreshable(tx, wallet)) throw new UnsafeTransactionError("this transaction carries another signer's signature, so its blockhash can't change");
  const message = VersionedMessage.deserialize(tx.message.serialize());
  message.recentBlockhash = blockhash;
  const out = new VersionedTransaction(message);
  assertSameExceptBlockhash(tx, out);
  return out;
}

/** Refuses unless `next` is `original` with at most a different blockhash. */
export function assertSameExceptBlockhash(original: VersionedTransaction, next: VersionedTransaction): void {
  if (!sameExceptBlockhash(original, next)) {
    throw new UnsafeTransactionError("the refreshed transaction differs from the one in the link in more than its blockhash");
  }
}

/** One envelope transaction with a fresh blockhash: the bytes, the blockhash and its expiry change, nothing else. */
export function refreshTransaction(t: UnsignedTransaction, wallet: string, latest: LatestBlockhash): UnsignedTransaction {
  const original = VersionedTransaction.deserialize(Buffer.from(t.base64, "base64"));
  const next = withBlockhash(original, wallet, latest.blockhash);
  return {
    ...t,
    base64: Buffer.from(next.serialize()).toString("base64"),
    recentBlockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  };
}

export interface Refreshed {
  env: Envelope;
  /** Indexes of the transactions that took the new blockhash. */
  refreshed: number[];
}

/**
 * Gives every refreshable transaction in `only` (default: all) the new blockhash, when the link is young enough.
 * Strict transactions, and every transaction of a link with no `builtAt` or older than REFRESH_MAX_AGE_SECONDS, are
 * left as they are. Run reviewEnvelope on the result before offering it for signing.
 */
export function refreshEnvelope(env: Envelope, latest: LatestBlockhash, nowSeconds: number, only?: number[]): Refreshed {
  if (!canRefresh(env, nowSeconds)) return { env, refreshed: [] };
  const refreshed: number[] = [];
  const transactions = env.transactions.map((t, i) => {
    if (only && !only.includes(i)) return t;
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(t.base64, "base64"));
    } catch {
      return t; // the review reports it
    }
    if (!isRefreshable(tx, env.wallet)) return t;
    refreshed.push(i);
    return refreshTransaction(t, env.wallet, latest);
  });
  return { env: { ...env, transactions }, refreshed };
}

/** Which transactions of an envelope can refresh (ignoring the link's age). */
export function refreshableIndexes(env: Envelope): number[] {
  return env.transactions.flatMap((t, i) => {
    try {
      return isRefreshable(VersionedTransaction.deserialize(Buffer.from(t.base64, "base64")), env.wallet) ? [i] : [];
    } catch {
      return [];
    }
  });
}
