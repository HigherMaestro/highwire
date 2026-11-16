import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import { solToLamports, type Envelope } from "highwire-core";
import { agentPaths, GENESIS_HASHES, POLICY_TEMPLATE, PolicySchema, type Intent, type Policy } from "highwire-agent";
import { WAGER_PROGRAM_IDS, wagerInstruction } from "../src/codec.ts";
import { linkBattleAddress, linkWagerInstruction, type LinkResult, type LinkTicket } from "../src/link-codec.ts";
import { buildLinkAccept, buildLinkExit, buildLinkOpen, buildLinkSettle } from "../src/link-tx.ts";
import { wagerSigner } from "../src/signing.ts";
import { battleOf, fakeDevnet, LINK_PROGRAM, linkBattleBytes, signResult, signTicket } from "./link-fake.ts";

// Link battles' stakes through the local signer (docs/link-wager.md 4): what a stake is comes from its bytes and the
// chain, the policy's `wagers` section and STOP-WAGERS hold as they do for The Line, and `max_open` counts both games.
// The transactions are the real builders', on a fake devnet; the signer's RPC is a fake too. Nothing touches a cluster.

const LINE = new PublicKey(WAGER_PROGRAM_IDS.devnet!);
const home = () => mkdtempSync(join(tmpdir(), "highwire-link-wager-"));
const policy = (over: Partial<Policy> = {}): Policy =>
  PolicySchema.parse({ ...POLICY_TEMPLATE, cluster: "devnet", live: true, actions: ["wager"], max_sol_per_tx: 0.5, wagers: { max_stake_sol: 0.25, max_open: 1, tiers: [0.1] }, ...over });
const live = (over: Partial<Policy> = {}, linkProgram: PublicKey | null = LINK_PROGRAM) => {
  const paths = agentPaths({ HIGHWIRE_HOME: home() });
  writeFileSync(paths.policy, JSON.stringify(policy(over)));
  return { paths, signer: wagerSigner(Keypair.generate(), paths, undefined, undefined, linkProgram ? { linkProgram } : undefined) };
};
const ask = (kind?: string, sol = 0): Intent => ({ action: "wager", cluster: "devnet", solOut: solToLamports(sol), ...(kind ? { wager: { kind } } : {}) });
const log = (paths: { audit: string }) =>
  readFileSync(paths.audit, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { outcome: string; wager?: string; series?: string; lamports?: string; reason?: string });

const other = Keypair.generate().publicKey;
const now = () => Math.floor(Date.now() / 1000);
const ticketFor = (a: PublicKey, b: PublicKey, battleId: string, stake = 100_000_000n): LinkTicket => ({ battleId, playerA: a.toBase58(), playerB: b.toBase58(), stake, acceptDeadline: now() + 300, expiry: now() + 600, keyId: 1 });

/**
 * The signer's RPC: `accounts` are what the chain holds (address to owner and data), `spend` what the simulation shows
 * leaving the wallet.
 */
const fakeConnection = (o: { spend?: number; accounts?: Map<string, { owner: PublicKey; data: Buffer }> } = {}) =>
  ({
    getGenesisHash: async () => GENESIS_HASHES.devnet,
    getBalance: async () => 2e9,
    simulateTransaction: async () => ({ value: { err: null, logs: [], accounts: [{ lamports: 2e9 - (o.spend ?? 5_000) }] } }),
    sendRawTransaction: async () => "sig",
    getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
    getBlockHeight: async () => 1,
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 200 }),
    getTransaction: async () => null,
    getProgramAccounts: async () => {
      throw new Error("the signer never scans the program");
    },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => o.accounts?.get(k.toBase58()) ?? null).map((a) => (a ? { ...a, executable: false, lamports: 1 } : null)),
    getAccountInfo: async (k: PublicKey) => {
      const a = o.accounts?.get(k.toBase58());
      return a ? { ...a, executable: false, lamports: 1 } : null;
    },
  }) as unknown as Connection;

/** A staked battle's envelopes for `wallet`, built by the real builders against a fake devnet. */
async function built(wallet: PublicKey, battleId = "5a".repeat(32), stake = 100_000_000n) {
  const net = fakeDevnet();
  const s = { chain: net.chain, program: LINK_PROGRAM };
  const asA = ticketFor(wallet, other, battleId, stake);
  const asB = ticketFor(other, wallet, battleId, stake);
  const result: LinkResult = { battleId, playerA: asA.playerA, playerB: asA.playerB, outcome: "a", keyId: 1 };
  const open = (await buildLinkOpen(s, { wallet, ...signTicket(asA) })).envelope;
  net.setBattle(battleOf(asB, "open"));
  const accept = (await buildLinkAccept(s, { wallet, ...signTicket(asB) })).envelope;
  net.setBattle(battleOf(asA, "open"));
  const cancel = (await buildLinkExit(s, { wallet, battleId, kind: "cancel" })).envelope;
  net.setBattle(battleOf(asA, "live"));
  const settle = (await buildLinkSettle(s, { wallet, ...signResult(result) })).envelope;
  const refund = (await buildLinkExit(s, { wallet, battleId, kind: "refund" })).envelope;
  const address = linkBattleAddress(LINK_PROGRAM, battleId);
  /** The chain with the battle open at `stake` a side, as B would find it. */
  const onChain = (owner = LINK_PROGRAM, lamports = stake) => new Map([[address.toBase58(), { owner, data: linkBattleBytes({ ...battleOf(asB, "open"), stake: lamports }) }]]);
  return { open, accept, cancel, settle, refund, address: address.toBase58(), onChain };
}

test("a link battle's stake is signed inside the policy's wagers section, and logged as what it is", async () => {
  const { paths, signer } = live();
  const e = await built(signer.publicKey);
  const res = await signer.execute(fakeConnection({ spend: 100_005_000 }), { tool: "link_stake", intent: ask(), envelope: e.open });
  assert.equal(res.status, "sent");
  const sent = log(paths).find((l) => l.outcome === "sent")!;
  assert.equal(sent.wager, "link_open");
  assert.equal(sent.series, e.address, "the battle's account, from the bytes");
  assert.equal(sent.lamports, "100005000", "what the simulation shows leaving the wallet: the stake and the fee");
  // The same transaction for a signer that wasn't handed the program: devnet's table has none, so it isn't a wager at all.
  const plain = live({}, null);
  const mine = await built(plain.signer.publicKey);
  await assert.rejects(plain.signer.execute(fakeConnection(), { tool: "t", intent: ask(), envelope: mine.open }), /doesn't carry exactly one wager instruction/);
  // No wagers section, no stake; a dry-run policy signs nothing.
  const none = live({ wagers: undefined });
  await assert.rejects(none.signer.execute(fakeConnection(), { tool: "t", intent: ask(), envelope: (await built(none.signer.publicKey)).open }), /no wagers section/);
  const dry = live({ live: false });
  assert.equal((await dry.signer.execute(fakeConnection(), { tool: "t", intent: ask(), envelope: (await built(dry.signer.publicKey)).open })).status, "dry_run");
});

test("the signer takes a link stake's kind and amount from its bytes and the chain, never the caller's word", async () => {
  const { signer } = live();
  const e = await built(signer.publicKey);
  // An open that calls itself a settle (which would skip STOP-WAGERS, the tiers and max_open) is refused; so is one
  // that calls itself The Line's open.
  await assert.rejects(signer.execute(fakeConnection(), { tool: "t", intent: ask("link_settle"), envelope: e.open }), /a wager link_open, not the link_settle it says/);
  await assert.rejects(signer.execute(fakeConnection(), { tool: "t", intent: ask("open"), envelope: e.open }), /a wager link_open, not the open it says/);
  // 0.25 SOL is one of the program's tiers, and not one of this policy's.
  const big = await built(signer.publicKey, "5b".repeat(32), 250_000_000n);
  await assert.rejects(signer.execute(fakeConnection(), { tool: "t", intent: ask(), envelope: big.open }), /isn't one of the policy's tiers/);
  // An accept's stake is the battle account's, whatever anyone says: 0.1 SOL passes, the same battle at 0.25 doesn't.
  assert.equal((await signer.execute(fakeConnection({ accounts: e.onChain() }), { tool: "t", intent: ask("link_accept"), envelope: e.accept })).status, "sent");
  const again = live();
  const f = await built(again.signer.publicKey);
  await assert.rejects(again.signer.execute(fakeConnection({ accounts: f.onChain(LINK_PROGRAM, 250_000_000n) }), { tool: "t", intent: ask("link_accept", 0.1), envelope: f.accept }), /isn't one of the policy's tiers/);
  // A battle that isn't on-chain, or an account there that isn't the program's, is nothing to accept.
  await assert.rejects(again.signer.execute(fakeConnection(), { tool: "t", intent: ask(), envelope: f.accept }), /battle to accept isn't on-chain/);
  await assert.rejects(again.signer.execute(fakeConnection({ accounts: f.onChain(LINE) }), { tool: "t", intent: ask(), envelope: f.accept }), /isn't the staking program's account/);
  // A move that says it stakes is refused.
  await assert.rejects(again.signer.execute(fakeConnection(), { tool: "t", intent: ask("link_settle", 0.1), envelope: f.settle }), /stakes nothing/);
});

test("max_open counts staked battles and The Line's series together", async () => {
  const { paths, signer } = live();
  const first = await built(signer.publicKey, "01".repeat(32));
  const second = await built(signer.publicKey, "02".repeat(32));
  assert.equal((await signer.execute(fakeConnection(), { tool: "t", intent: ask(), envelope: first.open })).status, "sent");
  // The first battle is still open (its account is the program's): a second stake is over the policy's one.
  const open = new Map([[first.address, { owner: LINK_PROGRAM, data: Buffer.alloc(0) }]]);
  await assert.rejects(signer.execute(fakeConnection({ accounts: open }), { tool: "t", intent: ask(), envelope: second.open }), /1 series already open/);
  assert.match(log(paths).at(-1)!.reason!, /already open/);
  // With two allowed, it goes.
  const two = live({ wagers: { max_stake_sol: 0.25, max_open: 2, tiers: [0.1], allow_retire: false } });
  const a = await built(two.signer.publicKey, "03".repeat(32));
  const b = await built(two.signer.publicKey, "04".repeat(32));
  assert.equal((await two.signer.execute(fakeConnection(), { tool: "t", intent: ask(), envelope: a.open })).status, "sent");
  assert.equal((await two.signer.execute(fakeConnection({ accounts: new Map([[a.address, { owner: LINK_PROGRAM, data: Buffer.alloc(0) }]]) }), { tool: "t", intent: ask(), envelope: b.open })).status, "sent");
});

test("STOP-WAGERS refuses a new link stake and lets a staked battle be settled, cancelled or refunded", async () => {
  const { paths, signer } = live();
  const e = await built(signer.publicKey);
  writeFileSync(paths.stopWagers, "");
  await assert.rejects(signer.execute(fakeConnection(), { tool: "t", intent: ask(), envelope: e.open }), /No new wagers/);
  await assert.rejects(signer.execute(fakeConnection({ accounts: e.onChain() }), { tool: "t", intent: ask(), envelope: e.accept }), /No new wagers/);
  for (const [kind, env] of [["link_settle", e.settle], ["link_cancel", e.cancel], ["link_refund", e.refund]] as const) {
    assert.equal((await signer.execute(fakeConnection(), { tool: "t", intent: ask(kind), envelope: env })).status, "sent", kind);
  }
  assert.deepEqual(log(paths).filter((l) => l.outcome === "sent").map((l) => l.wager), ["link_settle", "link_cancel", "link_refund"]);
  // A move may spend its fee and no more: one whose simulation shows the wallet paying out is refused.
  await assert.rejects(signer.execute(fakeConnection({ spend: 50_000_000 }), { tool: "t", intent: ask(), envelope: e.settle }), /over its .* SOL fee cap/);
  // STOP stops everything.
  writeFileSync(paths.stop, "");
  await assert.rejects(signer.execute(fakeConnection(), { tool: "t", intent: ask(), envelope: e.settle }), (err: { code?: string }) => err.code === "signer_stopped");
});

test("a transaction that stakes on a battle and plays The Line at once is neither", async () => {
  const { signer } = live();
  const e = await built(signer.publicKey);
  const w = signer.publicKey;
  const both = new VersionedTransaction(
    new TransactionMessage({
      payerKey: w,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [linkWagerInstruction(LINK_PROGRAM, w, "5a".repeat(32), { kind: "cancel" }, { playerA: w, playerB: other }), wagerInstruction(LINE, w, "55".repeat(32), { kind: "timeout" })],
    }).compileToV0Message(),
  );
  const env: Envelope = { ...e.cancel, transactions: [{ ...e.cancel.transactions[0]!, base64: Buffer.from(both.serialize()).toString("base64") }] };
  await assert.rejects(signer.execute(fakeConnection(), { tool: "t", intent: ask(), envelope: env }), /stakes on a link battle and plays The Line at once/);
  // Two of the program's instructions in one transaction: refused before anything is counted.
  const twice = new VersionedTransaction(
    new TransactionMessage({
      payerKey: w,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [0, 1].map((n) => linkWagerInstruction(LINK_PROGRAM, w, `5${n}`.repeat(32), { kind: "cancel" }, { playerA: w, playerB: other })),
    }).compileToV0Message(),
  );
  const env2: Envelope = { ...e.cancel, transactions: [{ ...e.cancel.transactions[0]!, base64: Buffer.from(twice.serialize()).toString("base64") }] };
  await assert.rejects(signer.execute(fakeConnection(), { tool: "t", intent: ask(), envelope: env2 }), /more than one link-wager instruction/);
});
