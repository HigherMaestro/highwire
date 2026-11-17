import { test } from "node:test";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import { ENVELOPE_FORMAT, HOW_TO_SIGN, signInMessage, solToLamports, type Envelope } from "highwire-core";
import { agentPaths, checkPolicy, GENESIS_HASHES, loadKeypair, loadPolicy, LocalSigner, POLICY_TEMPLATE, PolicySchema, policyWarnings, type Intent, type Policy } from "../src/index.ts";

// Unit tests only: a throwaway in-memory keypair and a fake RPC. Nothing here touches a real cluster.

const home = () => mkdtempSync(join(tmpdir(), "highwire-agent-"));
const COIN = "EE3p42u2rACc3PEDcgVdqfg8JRxSYdvbn53rFoc3i1ix";
const FRIEND = "3nG8WsVqotPWH74NRUpLwfQ1NMabdorWQ52YvbrVHA2E";

const policy = (over: Partial<Policy> = {}): Policy =>
  PolicySchema.parse({ ...POLICY_TEMPLATE, cluster: "devnet", actions: ["trade", "transfer"], transfer_allowlist: [FRIEND], ...over });

const buy = (sol: number, over: Partial<Intent> = {}): Intent => ({ action: "trade", cluster: "devnet", solOut: solToLamports(sol), slippageBps: 200, mint: COIN, ...over });

test("the policy refuses anything outside it, rule by rule", () => {
  const p = policy({ max_sol_per_tx: 0.1, max_sol_per_day: 0.5, max_slippage_bps: 300 });
  assert.equal(checkPolicy(p, buy(0.1), 0n), null);
  assert.equal(checkPolicy(p, buy(0.1, { cluster: "mainnet" }), 0n)?.rule, "cluster");
  assert.equal(checkPolicy(p, { action: "launch", cluster: "devnet", solOut: 0n }, 0n)?.rule, "actions");
  assert.equal(checkPolicy(p, buy(0.1, { slippageBps: 301 }), 0n)?.rule, "max_slippage_bps");
  assert.equal(checkPolicy(p, buy(0.11), 0n)?.rule, "max_sol_per_tx");
  assert.equal(checkPolicy(p, buy(0.1), solToLamports(0.45))?.rule, "max_sol_per_day");
  assert.equal(checkPolicy(policy({ coins: { deny: [COIN] } }), buy(0.01), 0n)?.rule, "coins.deny");
  assert.equal(checkPolicy(policy({ coins: { allow: [FRIEND] } }), buy(0.01), 0n)?.rule, "coins.allow");
  assert.equal(checkPolicy(policy({ creators: { allow: [FRIEND] } }), buy(0.01, { creator: null }), 0n)?.rule, "creators.allow");
  assert.equal(checkPolicy(policy({ creators: { allow: [FRIEND] } }), buy(0.01, { creator: FRIEND }), 0n), null);
  const send = (to: string): Intent => ({ action: "transfer", cluster: "devnet", solOut: solToLamports(0.01), recipient: to });
  assert.equal(checkPolicy(p, send(FRIEND), 0n), null);
  assert.equal(checkPolicy(p, send(COIN), 0n)?.rule, "transfer_allowlist");
});

test("without a usable policy nothing executes, and a policy can't carry unknown keys", () => {
  const dir = home();
  assert.throws(() => loadPolicy(join(dir, "nope.json")), (e: { code?: string }) => e.code === "no_policy");
  writeFileSync(join(dir, "bad.json"), "{");
  assert.throws(() => loadPolicy(join(dir, "bad.json")), (e: { code?: string }) => e.code === "policy_invalid");
  writeFileSync(join(dir, "extra.json"), JSON.stringify({ ...POLICY_TEMPLATE, max_sol_per_week: 5 }));
  assert.throws(() => loadPolicy(join(dir, "extra.json")), /max_sol_per_week|Unrecognized/);
  writeFileSync(join(dir, "ok.json"), JSON.stringify(POLICY_TEMPLATE));
  const p = loadPolicy(join(dir, "ok.json"));
  assert.equal(p.live, false, "the template is a dry run");
  assert.equal(p.cluster, "devnet");
});

test("the keypair loads from a Solana CLI file, warns when others can read it, and never echoes it", () => {
  const dir = home();
  const kp = Keypair.generate();
  const path = join(dir, "signer.json");
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  const loaded = loadKeypair(path);
  assert.equal(loaded.keypair.publicKey.toBase58(), kp.publicKey.toBase58());
  assert.equal(loaded.warning, undefined);
  if (process.platform !== "win32") {
    chmodSync(path, 0o644);
    assert.match(loadKeypair(path).warning ?? "", /chmod 600/);
  }
  const secret = "[" + Array.from(kp.secretKey.slice(0, 32)).join(",") + "]";
  writeFileSync(join(dir, "short.json"), secret);
  assert.throws(
    () => loadKeypair(join(dir, "short.json")),
    (e: Error) => (e as { code?: string }).code === "bad_keypair" && !e.message.includes(secret.slice(1, 20)),
  );
});

// ---------------------------------------------------------------- the signer, against a fake RPC

function envelopeFor(wallet: PublicKey, lamports: bigint): Envelope {
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: wallet,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [SystemProgram.transfer({ fromPubkey: wallet, toPubkey: new PublicKey(FRIEND), lamports })],
    }).compileToV0Message(),
  );
  return {
    format: ENVELOPE_FORMAT,
    cluster: "devnet",
    wallet: wallet.toBase58(),
    kind: "transfer",
    transactions: [
      {
        index: 0,
        label: "send SOL",
        base64: Buffer.from(tx.serialize()).toString("base64"),
        encoding: "base64",
        version: 0,
        feePayer: wallet.toBase58(),
        signers: [wallet.toBase58()],
        presigned: [],
        walletSigner: wallet.toBase58(),
        recentBlockhash: PublicKey.default.toBase58(),
        lastValidBlockHeight: 100,
        dependsOn: [],
        summary: ["1. Send"],
        fullyDecoded: true,
        simulation: { ok: true, unitsConsumed: 450 },
      },
    ],
    expiresAfterBlockHeight: 100,
    builtAt: Math.floor(Date.now() / 1000),
    howToSign: HOW_TO_SIGN,
  };
}

const BALANCE = 2_000_000_000;

/** A Solana connection for tests. `spend` is what the simulation shows leaving the wallet; `genesis` the RPC's cluster. */
function fakeConnection(opts: { simulateErr?: unknown; confirmErr?: unknown; sendErr?: Error; spend?: number; genesis?: string } = {}) {
  const sent: VersionedTransaction[] = [];
  const connection = {
    getGenesisHash: async () => opts.genesis ?? GENESIS_HASHES.devnet,
    getBalance: async () => BALANCE,
    simulateTransaction: async () => ({
      value: { err: opts.simulateErr ?? null, logs: ["Program log: test"], accounts: [{ lamports: BALANCE - (opts.spend ?? 0) }] },
    }),
    sendRawTransaction: async (bytes: Uint8Array) => {
      sent.push(VersionedTransaction.deserialize(bytes));
      if (opts.sendErr) throw opts.sendErr;
      return `sig-${sent.length}`;
    },
    getSignatureStatuses: async () => ({ value: [{ err: opts.confirmErr ?? null, confirmationStatus: "confirmed" }] }),
    getBlockHeight: async () => 1,
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 200 }),
    getTransaction: async () => ({ meta: { preBalances: [2_000_000_000], postBalances: [1_899_995_000], preTokenBalances: [], postTokenBalances: [] } }),
  };
  return { connection: connection as unknown as Connection, sent };
}

function signerWith(p: Policy) {
  const paths = agentPaths({ HIGHWIRE_HOME: home() });
  writeFileSync(paths.policy, JSON.stringify(p));
  const kp = Keypair.generate();
  return { signer: new LocalSigner(kp, paths), kp, paths };
}

const send = (sol: number): Intent => ({ action: "transfer", cluster: "devnet", solOut: solToLamports(sol), recipient: FRIEND });

test("a dry run checks everything and signs nothing", async () => {
  const { signer } = signerWith(policy());
  const { connection, sent } = fakeConnection();
  const r = await signer.execute(connection, { tool: "execute_transfer", intent: send(0.05), envelope: envelopeFor(signer.publicKey, solToLamports(0.05)) });
  assert.equal(r.status, "dry_run");
  assert.equal(sent.length, 0);
  assert.deepEqual(signer.audit.entries().map((e) => e.outcome), ["dry_run"]);
  assert.equal(signer.audit.spentSince("devnet"), 0n, "dry runs don't count against the day");
});

test("live, it signs with the wallet's key only, sends, confirms, and logs the spend before confirming", async () => {
  const { signer, paths } = signerWith(policy({ live: true, max_sol_per_tx: 0.3, max_sol_per_day: 0.5 }));
  const { connection, sent } = fakeConnection();
  const env = envelopeFor(signer.publicKey, solToLamports(0.3));
  const r = await signer.execute(connection, { tool: "execute_transfer", intent: send(0.3), envelope: env });
  assert.equal(r.status, "sent");
  // The signature is read from the signed bytes, not the RPC's answer, so it's known before the send.
  assert.equal(r.transactions[0]?.signature, bs58.encode(sent[0]!.signatures[0]!));
  assert.equal(r.transactions[0]?.confirmed, true);
  assert.equal(r.transactions[0]?.solChange, -0.100005);
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.signatures[0]!.some((b) => b !== 0), "signed");
  const original = VersionedTransaction.deserialize(Buffer.from(env.transactions[0]!.base64, "base64"));
  assert.deepEqual(Buffer.from(sent[0]!.message.serialize()), Buffer.from(original.message.serialize()), "the message is unchanged");
  assert.deepEqual(signer.audit.entries().map((e) => e.outcome), ["sent", "confirmed"]);
  assert.equal(signer.audit.spentSince("devnet"), solToLamports(0.3));
  const log = readFileSync(paths.audit, "utf8");
  assert.ok(log.includes(`"signature":"${r.transactions[0]!.signature}"`));

  // The day's limit now has 0.2 SOL left.
  await assert.rejects(
    signer.execute(connection, { tool: "execute_transfer", intent: send(0.3), envelope: env }),
    (e: { code?: string; message: string }) => e.code === "policy_refused" && /24 hours/.test(e.message),
  );
  assert.equal(sent.length, 1);
  assert.equal(signer.audit.entries().at(-1)?.outcome, "refused");
});

test("a transaction that also claims says so in every audit line", async () => {
  const { signer } = signerWith(policy({ actions: ["trade", "transfer", "claim"] }));
  const { connection } = fakeConnection();
  const intent: Intent = { ...send(0.05), also: ["claim"] };
  await signer.execute(connection, { tool: "order fee_claim", intent, envelope: envelopeFor(signer.publicKey, solToLamports(0.05)) });
  const [e] = signer.audit.entries();
  assert.equal(e?.outcome, "dry_run");
  assert.equal(e?.action, "transfer");
  assert.deepEqual(e?.also, ["claim"]);

  // One that takes a single action carries no `also`.
  await signer.execute(connection, { tool: "execute_transfer", intent: send(0.05), envelope: envelopeFor(signer.publicKey, solToLamports(0.05)) });
  assert.equal("also" in signer.audit.entries().at(-1)!, false);
});

test("two executes at once can't both fit under the daily limit", async () => {
  const { signer } = signerWith(policy({ live: true, max_sol_per_tx: 0.3, max_sol_per_day: 0.5 }));
  const { connection, sent } = fakeConnection();
  const env = envelopeFor(signer.publicKey, solToLamports(0.3));
  const results = await Promise.allSettled([0, 1].map(() => signer.execute(connection, { tool: "execute_transfer", intent: send(0.3), envelope: env })));
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(sent.length, 1);
});

test("the STOP file, a failed re-simulation, and someone else's transaction each stop it before signing", async () => {
  const { signer, paths } = signerWith(policy({ live: true }));
  const env = envelopeFor(signer.publicKey, solToLamports(0.01));

  const failing = fakeConnection({ simulateErr: { InstructionError: [0, "Custom"] } });
  await assert.rejects(signer.execute(failing.connection, { tool: "t", intent: send(0.01), envelope: env }), (e: { code?: string }) => e.code === "simulation_failed");
  assert.equal(failing.sent.length, 0);

  const ok = fakeConnection();
  const stranger = envelopeFor(Keypair.generate().publicKey, solToLamports(0.01));
  await assert.rejects(signer.execute(ok.connection, { tool: "t", intent: send(0.01), envelope: stranger }), /this signer's wallet/);

  writeFileSync(paths.stop, "");
  await assert.rejects(signer.execute(ok.connection, { tool: "t", intent: send(0.01), envelope: env }), (e: { code?: string }) => e.code === "signer_stopped");
  assert.throws(() => signer.precheck("transfer", "devnet"), (e: { code?: string }) => e.code === "signer_stopped");
  assert.equal(ok.sent.length, 0);
  assert.equal(signer.status().stopped, true);
});

test("a transaction that doesn't confirm is reported with its signature, and still counts", async () => {
  const { signer } = signerWith(policy({ live: true }));
  const { connection } = fakeConnection({ confirmErr: { InstructionError: [0, "Custom"] } });
  const r = await signer.execute(connection, { tool: "t", intent: send(0.05), envelope: envelopeFor(signer.publicKey, solToLamports(0.05)) });
  assert.equal(r.status, "partly_sent");
  assert.equal(r.transactions[0]?.confirmed, false);
  assert.match(r.transactions[0]?.error ?? "", /InstructionError/);
  assert.equal(signer.audit.spentSince("devnet"), solToLamports(0.05));
});

test("a send whose answer is lost is still logged and counted, so a retry can't spend the limit again", async () => {
  const { signer } = signerWith(policy({ live: true, max_sol_per_day: 0.1 }));
  const { connection, sent } = fakeConnection({ sendErr: new Error("socket hang up") });
  const r = await signer.execute(connection, { tool: "execute_transfer", intent: send(0.1), envelope: envelopeFor(signer.publicKey, solToLamports(0.1)) });
  assert.equal(r.status, "partly_sent");
  assert.match(r.transactions[0]!.error ?? "", /may still land/);
  assert.equal(signer.audit.spentSince("devnet"), solToLamports(0.1));
  await assert.rejects(
    signer.execute(connection, { tool: "execute_transfer", intent: send(0.1), envelope: envelopeFor(signer.publicKey, solToLamports(0.1)) }),
    (e: { code?: string }) => e.code === "policy_refused",
  );
  assert.equal(sent.length, 1);
});

test("what the wallet really spends counts, rent included, and an RPC on another cluster is refused", async () => {
  const { signer } = signerWith(policy({ live: true, max_sol_per_tx: 0.05, max_sol_per_day: 0.04 }));
  // An intent that says nothing leaves the wallet, but the simulation shows 0.03 SOL going, twice: the second is refused.
  const zero: Intent = { ...send(0), solOut: 0n };
  const { connection } = fakeConnection({ spend: 30_000_000 });
  await signer.execute(connection, { tool: "execute_transfer", intent: zero, envelope: envelopeFor(signer.publicKey, 0n) });
  assert.equal(signer.audit.spentSince("devnet"), 30_000_000n);
  await assert.rejects(signer.execute(connection, { tool: "execute_transfer", intent: zero, envelope: envelopeFor(signer.publicKey, 0n) }), /past the policy's 0.04 SOL/);

  const other = signerWith(policy({ live: true })).signer;
  const mainnet = fakeConnection({ genesis: GENESIS_HASHES.mainnet });
  await assert.rejects(other.execute(mainnet.connection, { tool: "execute_transfer", intent: send(0.01), envelope: envelopeFor(other.publicKey, solToLamports(0.01)) }), /different cluster/);
  assert.equal(mainnet.sent.length, 0);
});

test("two signers sharing a home (two Highwire processes) take turns, so both can't fit under the daily limit", async () => {
  const a = signerWith(policy({ live: true, max_sol_per_day: 0.1 }));
  const b = new LocalSigner(a.kp, a.paths);
  const ca = fakeConnection();
  const cb = fakeConnection();
  const results = await Promise.allSettled([
    a.signer.execute(ca.connection, { tool: "execute_transfer", intent: send(0.1), envelope: envelopeFor(a.signer.publicKey, solToLamports(0.1)) }),
    b.execute(cb.connection, { tool: "execute_transfer", intent: send(0.1), envelope: envelopeFor(b.publicKey, solToLamports(0.1)) }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(ca.sent.length + cb.sent.length, 1);
});

test("a torn last line in the audit log doesn't swallow the next spend", async () => {
  const { signer, paths } = signerWith(policy({ live: true, max_sol_per_day: 0.1 }));
  appendFileSync(paths.audit, '{"time":"2026-01-01T00:00:00.000Z","outcome":"sen');
  const { connection } = fakeConnection();
  await signer.execute(connection, { tool: "execute_transfer", intent: send(0.1), envelope: envelopeFor(signer.publicKey, solToLamports(0.1)) });
  assert.equal(signer.audit.spentSince("devnet"), solToLamports(0.1));
});

test("a live policy with no coin or creator allow-list is flagged", () => {
  assert.equal(policyWarnings(policy({ live: true, actions: ["trade"] })).length, 1);
  assert.deepEqual(policyWarnings(policy({ live: true, actions: ["trade"], coins: { allow: [COIN] } })), []);
  assert.deepEqual(policyWarnings(policy({ live: false, actions: ["trade"] })), []);
});

test("the signer signs higher.fun's sign-in message and nothing else, and logs it", () => {
  const { signer } = signerWith(policy({ actions: ["launch"] }));
  const ok = signInMessage(signer.wallet, "3173c33f4db122bf328e5cee03592751", new Date().toISOString());
  const sig = signer.signInMessage(new TextEncoder().encode(ok), "execute_launch");
  assert.ok(ed25519.verify(sig, new TextEncoder().encode(ok), signer.publicKey.toBytes()));
  assert.equal(signer.audit.entries().at(-1)?.outcome, "signed_in");
  assert.throws(() => signer.signInMessage(new TextEncoder().encode(ok.replace("higher.fun wants", "evil.example wants")), "execute_launch"), /isn't higher.fun's/);
  // A transaction's bytes are never accepted as a "message".
  const tx = envelopeFor(signer.publicKey, solToLamports(0.1)).transactions[0]!.base64;
  assert.throws(() => signer.signInMessage(Buffer.from(tx, "base64"), "execute_launch"), /isn't higher.fun's/);
});

test("posts go up only inside the policy's posts section, plain text, under the daily cap, and are logged first", async () => {
  const mainnet = (posts?: Policy["posts"], live = true) => policy({ cluster: "mainnet", actions: ["launch"], live, ...(posts ? { posts } : {}) });
  const nonce = "3173c33f4db122bf328e5cee03592751";
  let published = 0;
  // Stands in for higher.fun: signs in through the signer (which checks the message), then "posts".
  const publish = async (text: string, signIn: (m: Uint8Array) => Promise<Uint8Array> | Uint8Array) => {
    await signIn(new TextEncoder().encode(signInMessage(wallet, nonce, new Date().toISOString())));
    published++;
    return { id: `p${published}`, wallet, displayName: null, body: text, createdAt: new Date().toISOString() };
  };
  let wallet = "";
  const comment = (over: object = {}) => ({ tool: "post_comment", cluster: "mainnet" as const, where: "comment" as const, mint: COIN, creator: wallet, text: "Claimed and bought back half.", ...over });
  const refusedBy = (rule: string) => (e: { code?: string; body?: { rule?: string } }) => e.code === "policy_refused" && e.body?.rule === rule;

  const none = signerWith(mainnet());
  wallet = none.signer.wallet;
  await assert.rejects(none.signer.post(comment(), publish), refusedBy("posts"));
  assert.equal(published, 0);

  const { signer } = signerWith(mainnet({ comments: "own", chat: false, max_per_day: 2 }));
  wallet = signer.wallet;
  await assert.rejects(signer.post(comment({ creator: FRIEND }), publish), refusedBy("posts.comments"));
  await assert.rejects(signer.post(comment({ creator: null }), publish), /can't be read on-chain/);
  await assert.rejects(signer.post({ ...comment(), where: "chat", mint: undefined }, publish), refusedBy("posts.chat"));
  await assert.rejects(signer.post(comment({ text: "claim at claim-sol.com" }), publish), (e: { code?: string }) => e.code === "bad_post");
  await assert.rejects(signer.post(comment({ text: `send to ${FRIEND}` }), publish), (e: { code?: string }) => e.code === "bad_post");
  await assert.rejects(signer.post(comment({ cluster: "devnet" }), publish), refusedBy("cluster"));
  assert.equal(published, 0, "nothing refused reaches higher.fun");
  assert.equal(signer.audit.entries().filter((e) => e.outcome === "refused").length, 6);

  const r = await signer.post(comment({ text: "  Claimed and bought back half.  " }), publish);
  assert.equal(r.status, "posted");
  assert.equal(r.status === "posted" && r.post.body, "Claimed and bought back half.");
  assert.equal(r.postsLeftToday, 1);
  const log = signer.audit.entries().filter((e) => e.action === "post").map((e) => e.outcome);
  assert.deepEqual(log.slice(-3), ["sent", "signed_in", "posted"], "logged as sent before it signs in and goes up");
  assert.ok(signer.audit.entries().some((e) => e.outcome === "signed_in" && e.action === "post"));

  // A post whose answer is lost still counts: the cap is 2, so after it nothing more goes up.
  await assert.rejects(signer.post(comment(), async () => { throw new Error("socket hang up"); }), /socket hang up/);
  await assert.rejects(signer.post(comment(), publish), refusedBy("posts.max_per_day"));
  assert.equal(published, 1);

  // Dry run: checked, logged, not posted; "any" allows other people's coins; chat when allowed.
  const dry = signerWith(mainnet({ comments: "any", chat: true, max_per_day: 10 }, false));
  wallet = dry.signer.wallet;
  const d = await dry.signer.post(comment({ creator: FRIEND }), publish);
  assert.equal(d.status, "dry_run");
  const c = await dry.signer.post({ ...comment(), where: "chat", mint: undefined, text: "gm higher" }, publish);
  assert.equal(c.status, "dry_run");
  assert.equal(published, 1, "a dry run posts nothing");

  // The kill switch stops posts too.
  writeFileSync(dry.paths.stop, "");
  await assert.rejects(dry.signer.post(comment(), publish), (e: { code?: string }) => e.code === "signer_stopped");
});

// ---------------------------------------------------------------- protected sends: Jito's route, against a fake block engine

import { JITO_TIP_ACCOUNTS, jitoTipInstruction } from "highwire-core";
import { JitoRejected, routeOf, tipFor, type JitoClient } from "../src/index.ts";

function fakeJito(mode: "ok" | "reject" | "lost" = "ok", accounts: string[] = [...JITO_TIP_ACCOUNTS]) {
  const sends: string[] = [];
  const jito: JitoClient = {
    tipAccounts: async () => accounts,
    tipFloorLamports: async () => 10_000n,
    send: async (b64) => {
      sends.push(b64);
      if (mode === "reject") throw new JitoRejected("Jito's block engine refused it: rate limited");
      if (mode === "lost") throw new Error("socket hang up");
      return { bundleId: "bundle-1" };
    },
  };
  return { jito, sends };
}

/** A mainnet trade's envelope (a tip and a token-free stand-in for the trade), optionally without its tip. */
function tradeEnvelope(wallet: PublicKey, tip: bigint | null): Envelope {
  const env = envelopeFor(wallet, 1_000n);
  const ixs = [SystemProgram.transfer({ fromPubkey: wallet, toPubkey: new PublicKey(FRIEND), lamports: 1_000n })];
  if (tip !== null) ixs.push(jitoTipInstruction(wallet, { tipLamports: tip, tipAccount: JITO_TIP_ACCOUNTS[3] }));
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message());
  return { ...env, cluster: "mainnet", kind: "trade", transactions: [{ ...env.transactions[0]!, base64: Buffer.from(tx.serialize()).toString("base64") }] };
}

const mainnetPolicy = (send: Record<string, unknown>, over: Partial<Policy> = {}) =>
  PolicySchema.parse({ ...POLICY_TEMPLATE, cluster: "mainnet", live: true, actions: ["trade", "claim", "transfer"], max_sol_per_tx: 0.3, max_sol_per_day: 0.5, transfer_allowlist: [FRIEND], send, ...over });

function jitoSigner(p: Policy, mode: Parameters<typeof fakeJito>[0] = "ok", accounts?: string[]) {
  const paths = agentPaths({ HIGHWIRE_HOME: home() });
  writeFileSync(paths.policy, JSON.stringify(p));
  const fj = fakeJito(mode, accounts);
  return { signer: new LocalSigner(Keypair.generate(), paths, undefined, () => new Date(), fj.jito), ...fj };
}

/** A mainnet RPC that may never see the transaction: confirm fails, the block height has passed, and the status is null. */
function mainnetConnection(opts: { lands?: boolean } = {}) {
  const base = fakeConnection({ genesis: GENESIS_HASHES.mainnet, spend: 1_000 + 12_000 + 5_000, ...(opts.lands === false ? { confirmErr: "block height exceeded" } : {}) });
  Object.assign(base.connection, {
    getBlockHeight: async () => 1_000,
    getSignatureStatuses: async () => ({ value: [opts.lands === false ? null : { confirmationStatus: "confirmed" }] }),
  });
  return base;
}

const trade = (): Intent => ({ action: "trade", cluster: "mainnet", solOut: 1_000n, slippageBps: 100, mint: COIN });

test("the policy's send section: Jito's route is mainnet only, tips are capped, and only trades and claims take it", () => {
  assert.equal(PolicySchema.safeParse({ ...POLICY_TEMPLATE, send: { route: "jito" } }).success, false, "devnet can't route through Jito");
  assert.equal(PolicySchema.safeParse({ ...POLICY_TEMPLATE, cluster: "mainnet", send: { route: "jito", max_tip_sol: 0.02 } }).success, false, "over the cap");
  const p = mainnetPolicy({ route: "jito" });
  assert.deepEqual(p.send, { route: "jito", max_tip_sol: 0.0005, fallback: "none" });
  assert.deepEqual(["trade", "claim", "launch", "transfer"].map((a) => routeOf(p, a as never)), ["jito", "jito", "rpc", "rpc"]);
  assert.equal(routeOf(mainnetPolicy({ route: "rpc" }), "trade"), "rpc");
  // 1.2 times the median, within Jito's minimum and the cap; a quarter of the cap without a median.
  assert.equal(tipFor(10_000n, 500_000n), 12_000n);
  assert.equal(tipFor(100n, 500_000n), 1_000n);
  assert.equal(tipFor(9_000_000n, 500_000n), 500_000n);
  assert.equal(tipFor(null, 500_000n), 125_000n);
});

test("a protected send tips within the policy, goes to Jito's block engine only, and is logged with its route", async () => {
  const { signer, sends } = jitoSigner(mainnetPolicy({ route: "jito" }));
  const tip = await signer.jitoTip("mainnet", "trade");
  assert.equal(tip?.tipLamports, 12_000n);
  assert.ok(JITO_TIP_ACCOUNTS.includes(tip!.tipAccount as never));
  assert.equal(await signer.jitoTip("mainnet", "launch"), undefined, "launches go the ordinary way");
  const { connection, sent } = mainnetConnection();
  const r = await signer.execute(connection, { tool: "execute_trade", intent: trade(), envelope: tradeEnvelope(signer.publicKey, 12_000n) });
  assert.equal(r.status, "sent");
  assert.equal(sends.length, 1, "through the block engine");
  assert.equal(sent.length, 0, "never through the public RPC");
  assert.equal(r.transactions[0]?.route, "jito");
  assert.equal(r.transactions[0]?.tipSol, 0.000012);
  const [s, c] = signer.audit.entries();
  assert.deepEqual([s?.outcome, s?.route, s?.tip, c?.outcome, c?.bundle], ["sent", "jito", "12000", "confirmed", "bundle-1"]);
});

test("Jito's tip accounts must match Highwire's list before anything is tipped", async () => {
  const { signer } = jitoSigner(mainnetPolicy({ route: "jito" }), "ok", [...JITO_TIP_ACCOUNTS.slice(1), FRIEND]);
  await assert.rejects(signer.jitoTip("mainnet", "trade"), (e: { code?: string }) => e.code === "unavailable");
});

test("a refused protected send spends nothing; with fallback rpc it goes the ordinary way instead", async () => {
  const none = jitoSigner(mainnetPolicy({ route: "jito" }), "reject");
  const a = mainnetConnection();
  const r = await none.signer.execute(a.connection, { tool: "execute_trade", intent: trade(), envelope: tradeEnvelope(none.signer.publicKey, 12_000n) });
  assert.equal(r.status, "not_landed");
  assert.equal(r.transactions[0]?.landed, false);
  assert.equal(a.sent.length, 0, "nothing goes the ordinary way without the fallback");
  assert.deepEqual(none.signer.audit.entries().map((e) => e.outcome), ["sent", "not_landed"]);
  assert.equal(none.signer.audit.spentSince("mainnet"), 0n, "the spend is given back");

  const rpc = jitoSigner(mainnetPolicy({ route: "jito", fallback: "rpc" }), "reject");
  const b = mainnetConnection();
  const r2 = await rpc.signer.execute(b.connection, { tool: "execute_trade", intent: trade(), envelope: tradeEnvelope(rpc.signer.publicKey, 12_000n) });
  assert.equal(r2.status, "sent");
  assert.equal(b.sent.length, 1);
  assert.equal(r2.transactions[0]?.route, "rpc");
  assert.ok(rpc.signer.audit.entries().some((e) => e.outcome === "failed" && /fallback/.test(e.reason ?? "")));
});

test("a protected send whose answer is lost and whose blockhash expires unseen never landed, so nothing was spent", async () => {
  const { signer } = jitoSigner(mainnetPolicy({ route: "jito" }), "lost");
  const { connection, sent } = mainnetConnection({ lands: false });
  const r = await signer.execute(connection, { tool: "execute_trade", intent: trade(), envelope: tradeEnvelope(signer.publicKey, 12_000n) });
  assert.equal(r.status, "not_landed");
  assert.equal(sent.length, 0);
  assert.equal(signer.audit.spentSince("mainnet"), 0n);
});

test("the tips in the bytes must match the policy's route", async () => {
  const jito = jitoSigner(mainnetPolicy({ route: "jito" }));
  const { connection } = mainnetConnection();
  await assert.rejects(
    jito.signer.execute(connection, { tool: "execute_trade", intent: trade(), envelope: tradeEnvelope(jito.signer.publicKey, null) }),
    (e: { code?: string; message: string }) => e.code === "policy_refused" && /one tip/.test(e.message),
  );
  await assert.rejects(
    jito.signer.execute(connection, { tool: "execute_trade", intent: trade(), envelope: tradeEnvelope(jito.signer.publicKey, 600_000n) }),
    (e: { code?: string; message: string }) => e.code === "policy_refused" && /at most 0.0005 SOL/.test(e.message),
  );
  const plain = jitoSigner(mainnetPolicy({ route: "rpc" }));
  await assert.rejects(
    plain.signer.execute(connection, { tool: "execute_trade", intent: trade(), envelope: tradeEnvelope(plain.signer.publicKey, 12_000n) }),
    (e: { code?: string; message: string }) => e.code === "policy_refused" && /ordinary way/.test(e.message),
  );
  // A transfer on a Jito policy goes the ordinary way, so it must carry no tip.
  await assert.rejects(
    jito.signer.execute(connection, { tool: "execute_transfer", intent: { action: "transfer", cluster: "mainnet", solOut: 1_000n, recipient: FRIEND }, envelope: tradeEnvelope(jito.signer.publicKey, 12_000n) }),
    (e: { code?: string; message: string }) => e.code === "policy_refused" && /ordinary way/.test(e.message),
  );
});

test("a claim and buyback needs both actions in the policy", () => {
  const p = mainnetPolicy({ route: "rpc" }, { actions: ["claim"] });
  assert.equal(checkPolicy(p, { ...trade(), also: ["claim"] }, 0n)?.rule, "actions");
  assert.equal(checkPolicy(mainnetPolicy({ route: "rpc" }, { actions: ["trade"] }), { ...trade(), also: ["claim"] }, 0n)?.rule, "actions");
  assert.equal(checkPolicy(mainnetPolicy({ route: "rpc" }), { ...trade(), also: ["claim"] }, 0n), null);
});

test("confirmation polls the signature's status, never a websocket, and survives refused calls", async () => {
  const { confirmByPolling } = await import("../src/index.ts");
  let polls = 0;
  const flaky = {
    getSignatureStatuses: async () => {
      polls++;
      if (polls < 3) throw new Error("429 Too Many Requests");
      return { value: [polls < 4 ? { err: null, confirmationStatus: "processed" } : { err: null, confirmationStatus: "confirmed" }] };
    },
    getBlockHeight: async () => 10,
    onSignature: () => {
      throw new Error("no websockets");
    },
  } as unknown as Connection;
  await confirmByPolling(flaky, "sig", 100, { intervalMs: 1 });
  assert.equal(polls, 4);
  const failed = { getSignatureStatuses: async () => ({ value: [{ err: { InstructionError: [0, { Custom: 104 }] }, confirmationStatus: "confirmed" }] }), getBlockHeight: async () => 10 } as unknown as Connection;
  await assert.rejects(confirmByPolling(failed, "sig", 100, { intervalMs: 1 }), /Custom/);
  const expired = { getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 101 } as unknown as Connection;
  await assert.rejects(confirmByPolling(expired, "sig", 100, { intervalMs: 1 }), /blockhash expired/);
});
