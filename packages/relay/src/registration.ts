import { sha256 } from "@noble/hashes/sha2";
import bs58 from "bs58";
import { HIGHWIRE_MEMO, MAINNET, MEMO_PROGRAM_ID } from "highwire-core/arena";
import { fail } from "./errors.ts";
import type { Store } from "./store.ts";

// The shared agent registration (docs/x-posting.md 5): a wallet shows it launched a coin with Highwire's tools, then
// proves it holds that wallet by sending a memo with a code only it asked for, and gets tokens. Everything is read
// from the launch and memo transactions' signatures alone, on a mainnet RPC whose genesis hash is checked first.

export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** How long a code lasts, and how long after its challenge the memo may land. */
export const CODE_SECONDS = 600;
/** Tokens last 90 days and renew on use. */
export const TOKEN_SECONDS = 90 * 24 * 3600;

/** A transaction as `getTransaction` returns it with `encoding: "json"` and `maxSupportedTransactionVersion: 0`. */
export interface RpcTransaction {
  slot: number;
  blockTime: number | null;
  meta: { err: unknown; loadedAddresses?: { writable: string[]; readonly: string[] } } | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      instructions: { programIdIndex: number; accounts: number[]; data: string }[];
    };
  };
}

export interface RegistrationRpc {
  genesisHash(): Promise<string>;
  /** A confirmed transaction, or null when the RPC doesn't have it (yet). */
  getTransaction(signature: string): Promise<RpcTransaction | null>;
}

const LAUNCH_DISCRIMINATOR = "4399af27da102620"; // LaunchLab's initialize_v2 (packages/core/src/tx/decode.ts)
const PLATFORMS = new Set<string>([MAINNET.classicPlatform, MAINNET.rewardsPlatform]);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CODE = /^[a-z2-7]{16}$/;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const sha256Hex = (s: string) => hex(sha256(new TextEncoder().encode(s)));

/** 32 random bytes as hex: tokens and secrets. */
export function randomHex(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return hex(b);
}

function randomCode(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => alphabet[x & 31]).join("");
}

/** Constant-time comparison of two hex strings of the same length. */
export function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function keys(tx: RpcTransaction): string[] {
  const loaded = tx.meta?.loadedAddresses;
  return [...tx.transaction.message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

function memos(tx: RpcTransaction): string[] {
  const k = keys(tx);
  return tx.transaction.message.instructions
    .filter((ix) => k[ix.programIdIndex] === MEMO_PROGRAM_ID)
    .map((ix) => {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bs58.decode(ix.data));
      } catch {
        return "";
      }
    });
}

const feePayer = (tx: RpcTransaction) => tx.transaction.message.accountKeys[0];

/** Why this isn't a Highwire launch of `mint` on higher.fun paid for by `wallet`, or null when it is. */
export function launchProblem(tx: RpcTransaction | null, wallet: string, mint: string): string | null {
  if (!tx) return "the RPC doesn't know that launch signature (is it on mainnet, and confirmed?)";
  if (!tx.meta || tx.meta.err !== null) return "that transaction failed";
  if (feePayer(tx) !== wallet) return "that launch was paid for by another wallet";
  const k = keys(tx);
  const created = tx.transaction.message.instructions.some((ix) => {
    if (k[ix.programIdIndex] !== MAINNET.launchLabProgram) return false;
    let data: Uint8Array;
    try {
      data = bs58.decode(ix.data);
    } catch {
      return false;
    }
    return hex(data.subarray(0, 8)) === LAUNCH_DISCRIMINATOR && PLATFORMS.has(k[ix.accounts[3]!] ?? "") && k[ix.accounts[6]!] === mint;
  });
  if (!created) return "that transaction doesn't create this coin on higher.fun";
  if (!memos(tx).includes(HIGHWIRE_MEMO)) return "that launch wasn't built with Highwire's tools (no highwire memo)";
  return null;
}

/** The memo the wallet sends to prove it holds the wallet. */
export const registrationMemo = (code: string) => `highwire agent ${code}`;

interface Pending {
  wallet: string;
  mint: string;
  secretHash: string;
  createdAt: number;
}

export interface Challenge {
  code: string;
  memo: string;
  expiresAt: number;
}

export interface Verified {
  wallet: string;
  mint: string;
}

/** Registration's two steps over the store and an RPC. What a registration grants is up to the caller (the arena). */
export class Registration {
  private genesisChecked = false;

  constructor(
    private store: Store,
    private rpc: RegistrationRpc,
    private now: () => number,
  ) {}

  private async mainnet(): Promise<void> {
    if (this.genesisChecked) return;
    let genesis: string;
    try {
      genesis = await this.rpc.genesisHash();
    } catch {
      return fail("paused", "The Solana RPC isn't answering; try again shortly.");
    }
    if (genesis !== MAINNET_GENESIS) fail("refused", "The relay's RPC isn't mainnet, so it can't check registrations.");
    this.genesisChecked = true;
  }

  private async tx(signature: string): Promise<RpcTransaction | null> {
    try {
      return await this.rpc.getTransaction(signature);
    } catch {
      return fail("paused", "The Solana RPC isn't answering; try again shortly.");
    }
  }

  /** Step 1: the launch checks out; a code for the wallet to send, tied to a secret only the signer holds. */
  async challenge(input: { wallet?: unknown; mint?: unknown; launchSignature?: unknown; secretHash?: unknown }): Promise<Challenge> {
    const { wallet, mint, launchSignature, secretHash } = input;
    if (typeof wallet !== "string" || !BASE58.test(wallet)) fail("bad_request", "wallet is a Solana address.");
    if (typeof mint !== "string" || !BASE58.test(mint)) fail("bad_request", "mint is a Solana address.");
    if (typeof launchSignature !== "string" || !SIGNATURE.test(launchSignature)) fail("bad_request", "launchSignature is a transaction signature.");
    if (typeof secretHash !== "string" || !HEX64.test(secretHash)) fail("bad_request", "secretHash is SHA-256 of the signer's secret, as 64 lowercase hex characters.");
    await this.mainnet();
    const problem = launchProblem(await this.tx(launchSignature as string), wallet as string, mint as string);
    if (problem) fail("refused", `Can't register: ${problem}.`);

    // One pending code per wallet and coin, so nobody can overwrite another's challenge.
    const code = randomCode();
    const now = this.now();
    const pair = `reg:pair:${wallet}:${mint}`;
    if ((await this.store.cas(pair, 0, code, CODE_SECONDS)) === null) {
      fail("conflict", "A registration for this wallet and coin is already waiting; finish it or wait 10 minutes for it to expire.");
    }
    const pending: Pending = { wallet: wallet as string, mint: mint as string, secretHash: secretHash as string, createdAt: now };
    await this.store.cas(`reg:code:${code}`, 0, pending, CODE_SECONDS);
    return { code, memo: registrationMemo(code), expiresAt: now + CODE_SECONDS * 1000 };
  }

  /** Step 2: the memo landed from the same wallet, and the caller holds the secret. The code is used up either way it succeeds. */
  async verify(input: { code?: unknown; signature?: unknown; secret?: unknown }): Promise<Verified> {
    const { code, signature, secret } = input;
    if (typeof code !== "string" || !CODE.test(code)) fail("bad_request", "code is the 16-character code from the challenge.");
    if (typeof signature !== "string" || !SIGNATURE.test(signature)) fail("bad_request", "signature is the memo transaction's signature.");
    if (typeof secret !== "string" || !HEX64.test(secret)) fail("bad_request", "secret is the signer's 32-byte secret, as 64 lowercase hex characters.");
    const stored = await this.store.get<Pending>(`reg:code:${code}`);
    if (!stored) fail("expired", "That code has expired or was already used; start again.");
    const p = stored!.value;
    if (!sameHex(sha256Hex(secret as string), p.secretHash)) fail("unauthorized", "That secret doesn't match the challenge.");
    await this.mainnet();
    const tx = await this.tx(signature as string);
    if (!tx) fail("not_found", "The RPC doesn't have that memo transaction yet; wait for it to confirm and try again.");
    if (!tx!.meta || tx!.meta.err !== null) fail("refused", "That memo transaction failed.");
    if (feePayer(tx!) !== p.wallet) fail("refused", "That memo was sent by another wallet.");
    if (!memos(tx!).includes(registrationMemo(code as string))) fail("refused", "That transaction doesn't carry this code's memo.");
    const at = (tx!.blockTime ?? 0) * 1000;
    if (at < p.createdAt - 60_000 || at > p.createdAt + CODE_SECONDS * 1000) fail("refused", "That memo didn't land within 10 minutes of the challenge.");
    await this.store.del(`reg:code:${code}`);
    await this.store.del(`reg:pair:${p.wallet}:${p.mint}`);
    return { wallet: p.wallet, mint: p.mint };
  }
}
