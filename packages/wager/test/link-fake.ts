import { Buffer } from "node:buffer";
import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { Chain } from "highwire-core";
import { LINK_BATTLE_LEN, LINK_CONFIG_LEN, linkBattleAddress, linkConfigAddress, linkResultMessage, linkTicketMessage, type LinkBattleAccount, type LinkResult, type LinkTicket, type LinkWagerConfig } from "../src/link-codec.ts";

// A fake devnet for link battles' stakes: the program's two accounts written as the Rust lays them out (state.rs, and
// pinned to it by the codec file), and an RPC that answers from them. Nothing here touches a network.

export const LINK_PROGRAM = new PublicKey(new Uint8Array(32).fill(0x50));
export const DESK_SECRET = new Uint8Array(32).fill(7);
export const REFEREE_SECRET = new Uint8Array(32).fill(9);
export const DESK_KEY = new PublicKey(ed25519.getPublicKey(DESK_SECRET));
export const REFEREE_KEY = new PublicKey(ed25519.getPublicKey(REFEREE_SECRET));
export const BLOCKHASH = bs58.encode(new Uint8Array(32).fill(9));

export const LINK_CONFIG: LinkWagerConfig = {
  authority: new PublicKey(new Uint8Array(32).fill(3)).toBase58(),
  ticketKey: DESK_KEY.toBase58(),
  ticketKeyId: 1,
  resultKey: REFEREE_KEY.toBase58(),
  resultKeyId: 1,
  paused: false,
  tiers: [100_000_000n, 250_000_000n],
  maxStake: 250_000_000n,
  openStakeCap: 10_000_000_000n,
  openStake: 0n,
  refundAfterSeconds: 3600,
};

export function linkConfigBytes(c: Partial<LinkWagerConfig> = {}): Buffer {
  const v = { ...LINK_CONFIG, ...c };
  const b = Buffer.alloc(LINK_CONFIG_LEN);
  let o = b.writeUInt8(1, 0);
  o += new PublicKey(v.authority).toBuffer().copy(b, o);
  o += new PublicKey(v.ticketKey).toBuffer().copy(b, o);
  o = b.writeUInt16LE(v.ticketKeyId, o);
  o += new PublicKey(v.resultKey).toBuffer().copy(b, o);
  o = b.writeUInt16LE(v.resultKeyId, o);
  o = b.writeUInt8(v.paused ? 1 : 0, o);
  for (let i = 0; i < 4; i++) o = b.writeBigUInt64LE(v.tiers[i] ?? 0n, o);
  o = b.writeBigUInt64LE(v.maxStake, o);
  o = b.writeBigUInt64LE(v.openStakeCap, o);
  o = b.writeBigUInt64LE(v.openStake, o);
  b.writeUInt32LE(v.refundAfterSeconds, o);
  return b;
}

export function linkBattleBytes(v: LinkBattleAccount): Buffer {
  const b = Buffer.alloc(LINK_BATTLE_LEN);
  let o = b.writeUInt8(1, 0);
  o = b.writeUInt8(v.status === "open" ? 1 : 2, o);
  o += Buffer.from(v.battleId, "hex").copy(b, o);
  o += new PublicKey(v.playerA).toBuffer().copy(b, o);
  o += new PublicKey(v.playerB).toBuffer().copy(b, o);
  o = b.writeBigUInt64LE(v.stake, o);
  o = b.writeUInt16LE(v.ticketKeyId, o);
  for (const t of [v.acceptDeadline, v.ticketExpiry, v.openedAt, v.liveAt]) o = b.writeBigInt64LE(BigInt(t), o);
  return b;
}

/** The battle a ticket opens, as the program would hold it once A (and, when `live`, B) has staked. */
export const battleOf = (t: LinkTicket, status: "open" | "live", at = Math.floor(Date.now() / 1000)): LinkBattleAccount => ({
  status,
  battleId: t.battleId,
  playerA: t.playerA,
  playerB: t.playerB,
  stake: t.stake,
  ticketKeyId: t.keyId,
  acceptDeadline: t.acceptDeadline,
  ticketExpiry: t.expiry,
  openedAt: at,
  liveAt: status === "live" ? at : 0,
});

export const signTicket = (t: LinkTicket, secret = DESK_SECRET, program = LINK_PROGRAM) => ({ ticket: t, signature: Buffer.from(ed25519.sign(linkTicketMessage(program, t), secret)).toString("hex") });
export const signResult = (r: LinkResult, secret = REFEREE_SECRET, program = LINK_PROGRAM) => ({ result: r, signature: Buffer.from(ed25519.sign(linkResultMessage(program, r), secret)).toString("hex") });

export interface FakeDevnet {
  /** Accounts by address: the data and, when it isn't the link program's, the owner. */
  accounts: Map<string, { data: Buffer; owner?: string; executable?: boolean }>;
  /** Each address's transactions, newest first, as their log lines. */
  history: Map<string, string[][]>;
  /** Every JSON-RPC method asked for, in order. */
  calls: string[];
  fetch: typeof globalThis.fetch;
  chain: Chain;
  setConfig(c?: Partial<LinkWagerConfig>): void;
  setBattle(b: LinkBattleAccount | null, battleId?: string): void;
}

/** A devnet that holds the link-wager program's config (and whatever a test adds), answering over JSON-RPC. */
export function fakeDevnet(program = LINK_PROGRAM): FakeDevnet {
  const accounts: FakeDevnet["accounts"] = new Map();
  const history: FakeDevnet["history"] = new Map();
  const calls: string[] = [];
  const account = (a: { data: Buffer; owner?: string; executable?: boolean }) => ({ data: [a.data.toString("base64"), "base64"], executable: a.executable ?? false, lamports: 10_000_000, owner: a.owner ?? program.toBase58(), rentEpoch: 0, space: a.data.length });
  const answer = (method: string, params: any[]): unknown => {
    calls.push(method);
    if (method === "getRecentPrioritizationFees") return [];
    if (method === "getLatestBlockhash") return { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 } };
    if (method === "simulateTransaction") return { context: { slot: 1 }, value: { err: null, logs: [], accounts: null, unitsConsumed: 15_000, returnData: null } };
    if (method === "getAccountInfo") {
      const a = accounts.get(params[0]);
      return { context: { slot: 1 }, value: a ? account(a) : null };
    }
    if (method === "getMultipleAccounts") return { context: { slot: 1 }, value: (params[0] as string[]).map((k) => (accounts.has(k) ? account(accounts.get(k)!) : null)) };
    if (method === "getSignaturesForAddress") return (history.get(params[0]) ?? []).map((_, i) => ({ signature: `${params[0]}:${i}`, slot: 1, err: null, memo: null, blockTime: 1 }));
    if (method === "getTransaction") {
      const [addr, i] = String(params[0]).split(":");
      const logs = history.get(addr!)?.[Number(i)];
      return logs ? { slot: 1, blockTime: 1, meta: { err: null, fee: 5000, preBalances: [], postBalances: [], logMessages: logs }, transaction: { signatures: [], message: { accountKeys: [], instructions: [], recentBlockhash: BLOCKHASH, header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 } } } } : null;
    }
    return null;
  };
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: answer(body.method, body.params ?? []) }));
  }) as typeof globalThis.fetch;
  const net: FakeDevnet = {
    accounts,
    history,
    calls,
    fetch,
    chain: new Chain({ cluster: "devnet", rpcUrl: "https://rpc.test", fetch }),
    setConfig: (c = {}) => void accounts.set(linkConfigAddress(program).toBase58(), { data: linkConfigBytes(c) }),
    setBattle: (b, battleId) => {
      const at = linkBattleAddress(program, b?.battleId ?? battleId!).toBase58();
      if (b) accounts.set(at, { data: linkBattleBytes(b) });
      else accounts.delete(at);
    },
  };
  net.setConfig();
  return net;
}
