import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { seriesAddress, seriesHistory, wagerConfigAddress, wagerInstruction, WAGER_PROGRAM_IDS, type Chain } from "../src/index.ts";

// The practice pages' reader (tx/wager-history.ts) against a fake RPC: wager instructions are read wherever they run,
// including called from another program; a history that can't be read whole throws rather than returning part of it;
// and a close whose log was cut short still reads as a close.

const PROGRAM = new PublicKey(WAGER_PROGRAM_IDS.devnet!);
const ID = "5a".repeat(32);
const SERIES = seriesAddress(PROGRAM, ID);
const A = Keypair.generate().publicKey;
const B = Keypair.generate().publicKey;
const PROXY = Keypair.generate().publicKey;
const config = Buffer.from(JSON.parse(readFileSync(new URL("./fixtures/wager-codec.json", import.meta.url), "utf8")).config, "hex");

interface FakeTx {
  sig: string;
  top: TransactionInstruction[];
  /** Instructions the first top-level one called (a proxy program's CPI). */
  inner?: TransactionInstruction[];
  logs?: string[];
}

/** A transaction response with just what the reader uses: keys, compiled instructions, inner instructions, logs. */
function response(t: FakeTx, at: number) {
  const keys: PublicKey[] = [];
  const index = (k: PublicKey) => {
    const i = keys.findIndex((x) => x.equals(k));
    return i >= 0 ? i : keys.push(k) - 1;
  };
  const compile = (ix: TransactionInstruction) => ({ programIdIndex: index(ix.programId), accountKeyIndexes: ix.keys.map((k) => index(k.pubkey)), data: Uint8Array.from(ix.data) });
  const top = t.top.map(compile);
  const inner = (t.inner ?? []).map((ix) => {
    const c = compile(ix);
    return { programIdIndex: c.programIdIndex, accounts: c.accountKeyIndexes, data: bs58.encode(c.data) };
  });
  return {
    blockTime: at,
    slot: at,
    meta: { err: null, logMessages: t.logs ?? [], innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [], loadedAddresses: { writable: [], readonly: [] } },
    transaction: { signatures: [t.sig], message: { compiledInstructions: top, getAccountKeys: () => ({ get: (i: number) => keys[i] }) } },
  };
}

function fakeChain(txs: FakeTx[], { missing }: { missing?: string } = {}): Chain {
  const bySig = new Map(txs.map((t, i) => [t.sig, response(t, 1_000 + i)]));
  const connection = {
    getAccountInfo: async (k: PublicKey) => (k.equals(wagerConfigAddress(PROGRAM)) ? { data: config, owner: PROGRAM } : null),
    getSignaturesForAddress: async (k: PublicKey, o: { before?: string }) => (k.equals(SERIES) && !o.before ? [...txs].reverse().map((t) => ({ signature: t.sig, err: null })) : []),
    getTransactions: async (sigs: string[]) => sigs.map((s) => (s === missing ? null : bySig.get(s) ?? null)),
    getTransaction: async (s: string) => (s === missing ? null : bySig.get(s) ?? null),
  };
  return { cluster: "devnet", connection } as unknown as Chain;
}

const ix = (wallet: PublicKey, args: Parameters<typeof wagerInstruction>[3], parties?: Parameters<typeof wagerInstruction>[4]) => wagerInstruction(PROGRAM, wallet, ID, args, parties);
const open = ix(A, {
  kind: "open",
  ticket: { seriesId: ID, playerA: A.toBase58(), playerB: B.toBase58(), stake: 10_000_000n, acceptDeadline: 2_000, expiry: 2_000, keyId: 1 },
  fallbackHash: "aa".repeat(32),
});
const accept = ix(B, { kind: "accept", fallbackHash: "bb".repeat(32) });
const viaProxy = (inner: TransactionInstruction): TransactionInstruction => ({ programId: PROXY, keys: inner.keys, data: Buffer.alloc(0) }) as TransactionInstruction;

test("a move made through another program is read, in execution order", async () => {
  const commit = ix(A, { kind: "commit", match: 0, round: 1, hash: "cc".repeat(32) });
  const h = await seriesHistory(fakeChain([{ sig: "s1", top: [open] }, { sig: "s2", top: [accept] }, { sig: "s3", top: [viaProxy(commit)], inner: [commit] }]), ID);
  assert.deepEqual(
    h.events.map((e) => e.kind),
    ["open", "accept", "commit"],
  );
  const c = h.events[2]!;
  assert.ok(c.kind === "commit" && c.player === A.toBase58() && c.match === 0 && c.round === 1);
});

test("a commit from before commits named their match still reads, with no match", async () => {
  // Devnet's history before the program was redeployed: the tag, the round, the hash (34 bytes), taken in whichever
  // match was in play. A replay plays it there, as the program did.
  const now = ix(B, { kind: "commit", match: 0, round: 1, hash: "dd".repeat(32) });
  const before = { programId: PROGRAM, keys: now.keys.map((k, i) => (i === 0 ? { ...k, pubkey: A } : k)), data: Buffer.concat([Buffer.from([5, 1]), Buffer.alloc(32, 0xcc)]) } as TransactionInstruction;
  const h = await seriesHistory(fakeChain([{ sig: "s1", top: [open] }, { sig: "s2", top: [accept] }, { sig: "s3", top: [before] }, { sig: "s4", top: [now] }]), ID);
  assert.deepEqual(
    h.events.slice(2).map((e) => e.kind === "commit" && [e.player, e.match, e.round, e.hash]),
    [[A.toBase58(), null, 1, "cc".repeat(32)], [B.toBase58(), 0, 1, "dd".repeat(32)]],
  );
});

test("a history that can't be read whole throws instead of returning part of it", async () => {
  await assert.rejects(seriesHistory(fakeChain([{ sig: "s1", top: [open] }, { sig: "s2", top: [accept] }], { missing: "s2" }), ID), /no transaction/);
  await assert.rejects(seriesHistory(fakeChain([{ sig: "s2", top: [accept] }]), ID), /no opening transaction/);
});

test("a close whose log was cut short still reads as a close", async () => {
  const settle = ix(A, { kind: "settle" }, { playerA: A, playerB: B, feeAccount: A });
  const h = await seriesHistory(fakeChain([{ sig: "s1", top: [open] }, { sig: "s2", top: [accept] }, { sig: "s3", top: [settle], logs: ["Log truncated"] }]), ID);
  const closed = h.events.at(-1)!;
  assert.ok(closed.kind === "closed");
  assert.deepEqual(closed.outcome, { state: "closed", how: "unread" });
});

test("transactions in one block are read in the block's order, not the RPC's listing", async () => {
  const commit = ix(A, { kind: "commit", match: 0, round: 1, hash: "cc".repeat(32) });
  const chain = fakeChain([{ sig: "s1", top: [open] }, { sig: "s2", top: [accept] }, { sig: "s3", top: [commit] }]);
  const c = (chain as unknown as { connection: Record<string, unknown> }).connection;
  // The RPC lists the slot's three transactions in an order of its own (here: the open as the newest)...
  c.getSignaturesForAddress = async (k: PublicKey, o: { before?: string }) =>
    k.equals(SERIES) && !o.before ? ["s1", "s3", "s2"].map((signature) => ({ signature, slot: 7, err: null })) : [];
  // ...and the block holds them in the order they ran.
  c.getBlock = async (slot: number) => (slot === 7 ? { signatures: ["s1", "s2", "s3"] } : null);
  const h = await seriesHistory(chain, ID);
  assert.deepEqual(
    h.events.map((e) => e.kind),
    ["open", "accept", "commit"],
  );
});
