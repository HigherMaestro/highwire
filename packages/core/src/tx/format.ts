import type { Cluster } from "../higher/constants.ts";

// The unsigned-transaction envelope every build tool returns, as plain types.
// Kept apart from envelope.ts (which builds and simulates) so the signing page
// can import it without any Node-only code. docs/unsigned-transactions.md
// describes the format for wallets and for the signing page.

/** v2 added `builtAt`. v1 links still decode, and are treated as strict: no blockhash refresh. */
export const ENVELOPE_FORMAT = "highwire.unsigned-tx/v2";
export const ENVELOPE_FORMATS = ["highwire.unsigned-tx/v1", ENVELOPE_FORMAT] as const;
export type EnvelopeFormat = (typeof ENVELOPE_FORMATS)[number];

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

/** A transfer is signed only by the local signer: the sign page refuses transfers to other wallets. */
export type EnvelopeKind = "trade" | "launch" | "claim" | "transfer";

export interface Envelope {
  format: EnvelopeFormat;
  cluster: Cluster;
  wallet: string;
  kind: EnvelopeKind;
  /** Sign and send in this order, each after the one before has confirmed. */
  transactions: UnsignedTransaction[];
  /** The block height after which the first transaction's blockhash expires; rebuild after it. */
  expiresAfterBlockHeight: number;
  /** When it was built, in unix seconds. Missing on v1 envelopes. */
  builtAt?: number;
  howToSign: string;
}

export const HOW_TO_SIGN =
  "Each transaction is unsigned (except for any presigned new mint). Have the wallet in `walletSigner` sign it, " +
  "without changing it, and send the transactions in order, each after the one before has confirmed. " +
  "Blockhashes expire after about a minute: rebuild if sending fails with an expired blockhash. Never share a private key.";
