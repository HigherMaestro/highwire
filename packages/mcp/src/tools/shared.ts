import { z } from "zod";
import type { Chain, HigherApi, HigherSession, LiveFeed, MintSource, SolanaRpc } from "highwire-core";
import type { LocalSigner } from "highwire-agent";

export interface Deps {
  api: HigherApi;
  /** higher.fun's live feed (wss://api.higher.fun/ws), for watch_market. */
  live: LiveFeed;
  rpc: SolanaRpc;
  /** Solana and Raydium access for quotes and transaction builds, on the configured cluster. */
  chain: Chain;
  /** Mint keypairs for build_launch, by idempotency key: kept in memory, or derived from a secret. */
  launchKeys: MintSource;
  /** The most SOL one built transaction may move. */
  maxSolPerTx: number;
  /** The site sign links point at. */
  siteUrl: string;
  /** Signs each envelope so the sign page can tell it's unedited (attest.ts): set from HIGHWIRE_LAUNCH_SECRET. */
  attestationSeed?: Uint8Array;
  /** The opt-in local signer (HIGHWIRE_KEYPAIR_PATH). Never set on the hosted endpoint. */
  signer?: ExecutionSigner;
  /** A fresh higher.fun session to sign in to, for posting (the local signer only). */
  newSession: () => HigherSession;
}

/** What the execute tools use of the local signer. */
export type ExecutionSigner = Pick<LocalSigner, "wallet" | "publicKey" | "status" | "precheck" | "execute" | "signInMessage" | "logOrder" | "post" | "paths">;

export const address = (what: string) =>
  z
    .string()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a base58 Solana address")
    .describe(what);

export const mint = address("The coin's mint address (base58). higher.fun mints usually end in 'high'.");
export const wallet = address("A Solana wallet address (base58).");
export const cursor = z.string().max(512).optional().describe("Pass nextCursor from the previous page to get the next one.");

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Build tools return unsigned transactions: not read-only (they prepare a change), but not destructive either, since
 * nothing happens until the user signs.
 */
export const BUILD = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** Execute tools sign and send with the local signer: what they do can't be undone. */
export const EXECUTE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** SOL/USD is nice to have, never worth failing a call over. */
export async function solUsd(api: HigherApi): Promise<number | undefined> {
  try {
    return (await api.solPrice()).usd;
  } catch {
    return undefined;
  }
}
