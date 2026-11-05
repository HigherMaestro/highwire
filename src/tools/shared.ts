import { z } from "zod";
import type { HigherApi } from "../higher/api.js";
import type { SolanaRpc } from "../solana/rpc.js";

export interface Deps {
  api: HigherApi;
  rpc: SolanaRpc;
}

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

/** SOL/USD is nice to have, never worth failing a call over. */
export async function solUsd(api: HigherApi): Promise<number | undefined> {
  try {
    return (await api.solPrice()).usd;
  } catch {
    return undefined;
  }
}
