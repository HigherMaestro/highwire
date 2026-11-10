import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { arena, decodeSeriesAccount, ENVELOPE_FORMAT, HOW_TO_SIGN, solToLamports, ticketCheck, ticketMessage, WAGER_PROGRAM_IDS, wagerInstruction, type Envelope, type SeriesAccountData } from "highwire-core";
import {
  agentPaths,
  CANCEL_MARGIN_SECONDS,
  checkPolicy,
  DEADLINE_MARGIN_SECONDS,
  GENESIS_HASHES,
  LocalSigner,
  nextWagerAction,
  POLICY_TEMPLATE,
  PolicySchema,
  WagerRunner,
  daemonStatus,
  holdProcessLock,
  WagerSecrets,
  withFileLock,
  writeBeat,
  type Intent,
  type Policy,
} from "../src/index.ts";

// The wager side of the local signer (docs/wager-mode.md 7.3): the policy's wagers section, STOP-WAGERS, the secrets
// file and the reveal daemon's decisions. A fake RPC and series states only: nothing here touches a cluster.

const home = () => mkdtempSync(join(tmpdir(), "highwire-wager-"));
const policy = (over: Partial<Policy> = {}): Policy =>
  PolicySchema.parse({ ...POLICY_TEMPLATE, cluster: "devnet", actions: ["wager"], max_sol_per_tx: 0.5, wagers: { max_stake_sol: 0.1, max_open: 1, tiers: [0.01, 0.1] }, ...over });
const stake = (sol: number, openSeries = 0, kind = "open"): Intent => ({
  action: "wager",
  cluster: "devnet",
  solOut: solToLamports(sol),
  wager: { kind, stake: solToLamports(sol), openSeries },
});

test("the policy allows a wager only inside its wagers section", () => {
  const p = policy();
  assert.equal(checkPolicy(p, stake(0.1), 0n), null);
  assert.equal(checkPolicy(p, stake(0.1, 0, "accept"), 0n), null);
  assert.equal(checkPolicy(policy({ wagers: undefined }), stake(0.1), 0n)?.rule, "wagers");
  assert.equal(checkPolicy(policy({ actions: ["trade"] }), stake(0.1), 0n)?.rule, "actions");
  assert.equal(checkPolicy(p, stake(0.05), 0n)?.rule, "wagers.tiers", "not a tier");
  assert.equal(checkPolicy(p, stake(0.1, 1), 0n)?.rule, "wagers.max_open");
  const uncounted: Intent = { ...stake(0.1), wager: { kind: "open", stake: solToLamports(0.1) } };
  assert.equal(checkPolicy(p, uncounted, 0n)?.rule, "wagers.max_open", "uncounted open series are refused");
  // Gross, against the daily limit like any spend.
  assert.equal(checkPolicy(policy({ max_sol_per_day: 0.15 }), stake(0.1), solToLamports(0.1))?.rule, "max_sol_per_day");
  // Moves spend nothing and need no tier; retiring needs allow_retire.
  const move = (kind: string): Intent => ({ action: "wager", cluster: "devnet", solOut: 0n, wager: { kind } });
  assert.equal(checkPolicy(p, move("reveal"), 0n), null);
  assert.equal(checkPolicy(p, move("retire"), 0n)?.rule, "wagers.allow_retire");
  assert.equal(checkPolicy(policy({ wagers: { max_stake_sol: 0.1, max_open: 1, tiers: [0.1], allow_retire: true } }), move("retire"), 0n), null);
  // A tier over the section's own cap doesn't parse.
  assert.throws(() => policy({ wagers: { max_stake_sol: 0.1, max_open: 1, tiers: [0.5], allow_retire: false } }), /at most max_stake_sol/);
  // A template never wagers.
  assert.ok(!(POLICY_TEMPLATE.actions as string[]).includes("wager"));
});

// Real wager transactions: the signer reads the kind and the stake from the bytes, not from the caller.
const codec = JSON.parse(readFileSync(new URL("../../core/test/fixtures/wager-codec.json", import.meta.url), "utf8"));
const program = new PublicKey(WAGER_PROGRAM_IDS.devnet!);
const ticketSecret = new Uint8Array(32).fill(7);
const other = Keypair.generate().publicKey;

function wagerEnvelope(wallet: PublicKey, kind: "open" | "accept" | "reveal" | "timeout", seriesId = "55".repeat(32), stakeSol = 0.1): Envelope {
  let ixs: TransactionInstruction[];
  if (kind === "open" || kind === "accept") {
    const [a, b] = kind === "open" ? [wallet, other] : [other, wallet];
    const t = { seriesId, playerA: a.toBase58(), playerB: b.toBase58(), stake: solToLamports(stakeSol), acceptDeadline: 1, expiry: 2, keyId: 1 };
    const check = ticketCheck(program, t, new PublicKey(ed25519.getPublicKey(ticketSecret)), ed25519.sign(ticketMessage(program, t), ticketSecret));
    ixs = [check, wagerInstruction(program, wallet, seriesId, kind === "open" ? { kind, ticket: t, fallbackHash: "44".repeat(32) } : { kind, fallbackHash: "44".repeat(32) })];
  } else ixs = [wagerInstruction(program, wallet, seriesId, kind === "reveal" ? { kind, pull: 1, nonce: "22".repeat(32) } : { kind })];
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message());
  return {
    format: ENVELOPE_FORMAT,
    cluster: "devnet",
    wallet: wallet.toBase58(),
    kind: "wager",
    transactions: [
      {
        index: 0,
        label: `a wager ${kind}`,
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
        summary: ["1. A wager"],
        fullyDecoded: true,
        simulation: { ok: true, unitsConsumed: 1 },
      },
    ],
    expiresAfterBlockHeight: 100,
    builtAt: Math.floor(Date.now() / 1000),
    howToSign: HOW_TO_SIGN,
  };
}

/** A fake RPC: `spend` is what the simulation shows leaving the wallet; the series to accept is the codec file's (0.1 SOL a side). */
const fakeConnection = (o: { spend?: number; onChain?: Set<string> } = {}) =>
  ({
    getGenesisHash: async () => GENESIS_HASHES.devnet,
    getBalance: async () => 2e9,
    simulateTransaction: async () => ({ value: { err: null, logs: [], accounts: [{ lamports: 2e9 - (o.spend ?? 5_000) }] } }),
    sendRawTransaction: async () => "sig",
    confirmTransaction: async () => ({ value: { err: null } }),
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 200 }),
    getTransaction: async () => null,
    getProgramAccounts: async () => {
      throw new Error("the signer never scans the program");
    },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => (o.onChain?.has(k.toBase58()) ? { owner: program, data: Buffer.alloc(0), executable: false, lamports: 1 } : null)),
    getAccountInfo: async () => ({ data: Buffer.from(codec.seriesAccount, "hex"), owner: program, executable: false, lamports: 1 }),
  }) as unknown as Connection;

const live = (over: Partial<Policy> = {}) => {
  const paths = agentPaths({ HIGHWIRE_HOME: home() });
  writeFileSync(paths.policy, JSON.stringify(policy({ live: true, ...over })));
  return { paths, signer: new LocalSigner(Keypair.generate(), paths) };
};
const ask = (kind?: string, sol = 0): Intent => ({ action: "wager", cluster: "devnet", solOut: solToLamports(sol), ...(kind ? { wager: { kind } } : {}) });

test("STOP-WAGERS refuses new stakes and lets open series play out; STOP refuses everything", async () => {
  const { paths, signer } = live();
  writeFileSync(paths.stopWagers, "");
  await assert.rejects(signer.execute(fakeConnection(), { tool: "t", intent: ask("open"), envelope: wagerEnvelope(signer.publicKey, "open") }), /No new wagers/);
  await assert.rejects(signer.execute(fakeConnection(), { tool: "t", intent: ask("accept"), envelope: wagerEnvelope(signer.publicKey, "accept") }), /No new wagers/);
  assert.equal((await signer.execute(fakeConnection(), { tool: "t", intent: ask("reveal"), envelope: wagerEnvelope(signer.publicKey, "reveal") })).status, "sent");
  writeFileSync(paths.stop, "");
  await assert.rejects(signer.execute(fakeConnection(), { tool: "t", intent: ask("reveal"), envelope: wagerEnvelope(signer.publicKey, "reveal") }), (e: { code?: string }) => e.code === "signer_stopped");
  const log = readFileSync(paths.audit, "utf8");
  assert.match(log, /"action":"wager"/);
  assert.match(log, /No new wagers/);
});

test("the signer takes a wager's kind and stake from its bytes and the chain, never the caller's word", async () => {
  const { signer } = live();
  // An open that calls itself a reveal (which would skip STOP-WAGERS, the tiers and max_open) is refused.
  await assert.rejects(signer.execute(fakeConnection(), { tool: "t", intent: ask("reveal"), envelope: wagerEnvelope(signer.publicKey, "open") }), /a wager open, not the reveal it says/);
  // With no kind or stake said at all, the open's own stake is checked: 0.05 SOL isn't a tier.
  await assert.rejects(signer.execute(fakeConnection(), { tool: "t", intent: ask(), envelope: wagerEnvelope(signer.publicKey, "open", "66".repeat(32), 0.05) }), /isn't one of the policy's tiers/);
  // An accept's stake is the series account's (0.1 SOL here), so a policy of 0.01-SOL wagers refuses it.
  const small = live({ wagers: { max_stake_sol: 0.01, max_open: 1, tiers: [0.01], allow_retire: false } });
  await assert.rejects(small.signer.execute(fakeConnection(), { tool: "t", intent: ask("accept"), envelope: wagerEnvelope(small.signer.publicKey, "accept") }), /isn't one of the policy's tiers/);
  // A move that says it stakes is refused too.
  await assert.rejects(signer.execute(fakeConnection(), { tool: "t", intent: ask("reveal", 0.1), envelope: wagerEnvelope(signer.publicKey, "reveal") }), /stakes nothing/);
  // Something that isn't one wager instruction isn't a wager.
  const plain = wagerEnvelope(signer.publicKey, "reveal");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: other, lamports: 1 })] }).compileToV0Message());
  plain.transactions[0]!.base64 = Buffer.from(tx.serialize()).toString("base64");
  await assert.rejects(signer.execute(fakeConnection(), { tool: "t", intent: ask("reveal"), envelope: plain }), /exactly one wager instruction/);
});

test("two stakes at once can't both fit under max_open: each counts the other once it's sent", async () => {
  const { paths, signer } = live();
  const results = await Promise.allSettled(["77", "88"].map((id) => signer.execute(fakeConnection({ spend: 104_000_000 }), { tool: "t", intent: ask("open"), envelope: wagerEnvelope(signer.publicKey, "open", id.repeat(32)) })));
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.match(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /1 series already open/);
  assert.match(readFileSync(paths.audit, "utf8"), /"wager":"open".*"series":"/);
});

test("moves are never refused by the daily limit, only by their own fee cap, and never wait for the lock", async () => {
  const { paths, signer } = live({ max_sol_per_day: 0.105 });
  // The stake uses the whole day (0.1 SOL and the rent).
  assert.equal((await signer.execute(fakeConnection({ spend: 104_000_000 }), { tool: "t", intent: ask("open"), envelope: wagerEnvelope(signer.publicKey, "open") })).status, "sent");
  // The reveal still goes: refusing it would forfeit the match.
  assert.equal((await signer.execute(fakeConnection({ spend: 10_000 }), { tool: "t", intent: ask("reveal"), envelope: wagerEnvelope(signer.publicKey, "reveal") })).status, "sent");
  // But a "move" that spends more than a fee is refused.
  await assert.rejects(signer.execute(fakeConnection({ spend: 2_000_000 }), { tool: "t", intent: ask("timeout"), envelope: wagerEnvelope(signer.publicKey, "timeout") }), /over its 0.001 SOL fee cap/);
  // Another process holding the execute lock for a while doesn't hold up a reveal.
  const held = withFileLock(paths.lock, () => new Promise((r) => setTimeout(r, 1_500)));
  const t0 = Date.now();
  assert.equal((await signer.execute(fakeConnection(), { tool: "t", intent: ask("reveal"), envelope: wagerEnvelope(signer.publicKey, "reveal") })).status, "sent");
  assert.ok(Date.now() - t0 < 1_000, "the reveal didn't wait");
  await held;
});

test("the secrets file keeps every nonce and salt, owner-only, and finds them only by their commitment", () => {
  const paths = agentPaths({ HIGHWIRE_HOME: home() });
  const secrets = new WagerSecrets(paths.wagerSecrets);
  const id = "11".repeat(32);
  const m = secrets.newMove(id, 2, 7, "b", 13);
  assert.equal(m.hash, arena.moveCommitment(id, 2, 7, "b", 13, m.nonce));
  const f = secrets.newFallback(id, "B", { kind: "steady", pull: 9 });
  assert.equal(f.hash, arena.fallbackCommitment(id, "B", { kind: "steady", pull: 9 }, f.salt));
  if (process.platform !== "win32") assert.equal(statSync(paths.wagerSecrets).mode & 0o777, 0o600);
  assert.deepEqual(secrets.move(id, m.hash), m);
  assert.deepEqual(secrets.fallback(id, "B", f.hash), f);
  assert.equal(secrets.move(id, "00".repeat(32)), undefined);
  assert.equal(secrets.fallback(id, "A", f.hash), undefined, "another player's commitment");
  assert.equal(secrets.move("22".repeat(32), m.hash), undefined, "another series");
  // A torn last line (a crash mid-write) doesn't lose what came before.
  writeFileSync(paths.wagerSecrets, readFileSync(paths.wagerSecrets, "utf8") + '{"type":"mo');
  assert.deepEqual(new WagerSecrets(paths.wagerSecrets).move(id, m.hash), m);
});

// ---------------------------------------------------------------- the reveal daemon's decisions

// A live series from the shared codec file: A is key 5, B key 6; match 0 (A on side a), round 2's commit phase opened at
// 1140, nobody committed yet; B's fallback is public (steady 9).
const base = (): SeriesAccountData => decodeSeriesAccount(Buffer.from(codec.seriesAccount, "hex"));
const A = new PublicKey(new Uint8Array(32).fill(5)).toBase58();
const B = new PublicKey(new Uint8Array(32).fill(6)).toBase58();
const none = { move: () => undefined, fallback: () => undefined };
const M = DEADLINE_MARGIN_SECONDS;

test("the daemon reveals what this wallet committed, from the secrets file", () => {
  const dir = home();
  const secrets = new WagerSecrets(join(dir, "s.jsonl"));
  const s = base();
  const mine = secrets.newMove(s.header.seriesId, 0, 2, "a", 3);
  s.series!.phase = "reveal";
  s.series!.round[0] = { hash: mine.hash, owesFallback: false, pull: null };
  s.series!.round[1] = { hash: "77".repeat(32), owesFallback: false, pull: null };
  assert.deepEqual(nextWagerAction(s, A, 1_141, secrets).action, { kind: "reveal", pull: 3, nonce: mine.nonce });
  // B's daemon has nothing to reveal for A, and no secret of its own: it warns, and acts once the window is past.
  const b = nextWagerAction(s, B, 1_141, secrets);
  assert.equal(b.action, null);
  assert.match(b.warning ?? "", /no saved nonce/);
  // Once A has revealed, A waits for B until the window closes, then applies the timeout.
  s.series!.round[0].pull = 3;
  assert.equal(nextWagerAction(s, A, 1_140 + 120, none).action, null);
  assert.deepEqual(nextWagerAction(s, A, 1_140 + 121 + M, none).action, { kind: "timeout" });
});

test("the daemon reveals an owed fallback, and only the one committed", () => {
  const secrets = new WagerSecrets(join(home(), "s.jsonl"));
  const s = base();
  const id = s.header.seriesId;
  // A owes its fallback (it missed the commit); its commitment on-chain is 44..44, which no saved salt opens.
  s.series!.phase = "reveal";
  s.series!.round[0] = { hash: null, owesFallback: true, pull: null };
  assert.match(nextWagerAction(s, A, 1_141, secrets).warning ?? "", /no saved salt/);
  const f = secrets.newFallback(id, "A", { kind: "mirror", pull: 0 });
  s.series!.fallbackHash.A = f.hash;
  assert.deepEqual(nextWagerAction(s, A, 1_141, secrets).action, { kind: "revealFallback", fallback: { kind: "mirror", pull: 0 }, salt: f.salt });
});

test("the daemon applies a commit deadline only once every late side is past its own", () => {
  const s = base();
  const deadline = 1_140 + 120; // both banks are over the 120-second round limit
  assert.equal(nextWagerAction(s, A, deadline, none).action, null, "the margin");
  assert.deepEqual(nextWagerAction(s, A, deadline + M, none).action, { kind: "timeout" });
  // A committed and B is late: A's daemon times B out at B's deadline.
  s.series!.round[0].hash = "88".repeat(32);
  assert.equal(nextWagerAction(s, A, deadline - 1, none).action, null);
  assert.deepEqual(nextWagerAction(s, A, deadline + M, none).action, { kind: "timeout" });
  // B's bank is low, so B's own deadline comes first.
  s.series!.bank.B = 30;
  assert.deepEqual(nextWagerAction(s, A, 1_140 + 30 + M, none).action, { kind: "timeout" });
});

test("the daemon settles a finished series, cancels an unaccepted one after its deadline, and refunds a day-idle one", () => {
  const s = base();
  s.series!.ending = { winner: "B", reason: 1 };
  assert.deepEqual(nextWagerAction(s, A, 1_141, none).action, { kind: "settle" }, "the loser settles too: its rent comes back");
  const open: SeriesAccountData = { header: { ...base().header, status: "open" }, series: null };
  // The program lets A cancel any time, so the daemon waits well past the deadline: B may still accept on a lagging chain clock.
  assert.equal(nextWagerAction(open, A, open.header.acceptDeadline + CANCEL_MARGIN_SECONDS, none).action, null);
  assert.deepEqual(nextWagerAction(open, A, open.header.acceptDeadline + CANCEL_MARGIN_SECONDS + 1, none).action, { kind: "cancel" });
  assert.deepEqual(nextWagerAction(open, B, open.header.acceptDeadline + CANCEL_MARGIN_SECONDS + 1, none).action, { kind: "cancel" }, "B too, after the deadline: the program refunds A either way");
  // A series nobody can move (both committed, before any deadline) after a day without a change.
  const idle = base();
  idle.series!.round[0].hash = "88".repeat(32);
  idle.series!.round[1].hash = "99".repeat(32);
  idle.series!.phaseOpenedAt = 1_140 + 86_400;
  assert.deepEqual(nextWagerAction(idle, A, 1_140 + 86_400 + M, none).action, { kind: "emergencyRefund" });
  // Another wallet's series: nothing.
  assert.equal(nextWagerAction(s, Keypair.generate().publicKey.toBase58(), 1_141, none).action, null);
});

test("the runner acts once per state, retries after a failure, and stops at the kill switch", async () => {
  const s = base();
  s.series!.ending = { winner: "A", reason: 1 };
  const acted: string[] = [];
  let fail = true;
  let stopped = false;
  const logs: string[] = [];
  const runner = new WagerRunner({
    wallet: A,
    list: async () => [s],
    act: async (id, a) => {
      acted.push(`${id.slice(0, 2)}:${a.kind}`);
      if (fail) throw new Error("simulation failed");
      return "sent";
    },
    secrets: none,
    stopped: () => stopped,
    log: (l) => logs.push(l),
    now: () => 1_141,
  });
  await runner.tick();
  await runner.tick();
  assert.deepEqual(acted, ["11:settle"], "a failed action waits before it's tried again");
  assert.match(logs.join("\n"), /settle failed: simulation failed/);
  stopped = true;
  fail = false;
  assert.deepEqual(await runner.tick(), []);
  assert.equal(acted.length, 1);
});

test("past the reveal window the daemon stops revealing and applies the timeout, secret or not", () => {
  const secrets = new WagerSecrets(join(home(), "s.jsonl"));
  const s = base();
  const mine = secrets.newMove(s.header.seriesId, 0, 2, "a", 3);
  s.series!.phase = "reveal";
  s.series!.round[0] = { hash: mine.hash, owesFallback: false, pull: null };
  s.series!.round[1] = { hash: "77".repeat(32), owesFallback: false, pull: null };
  const end = 1_140 + 120;
  assert.equal(nextWagerAction(s, A, end + M, secrets).action?.kind, "reveal", "still worth trying at the window's edge");
  assert.deepEqual(nextWagerAction(s, A, end + 1 + M, secrets).action, { kind: "timeout" });
  // With no secret, it warns while the window is open, and still cranks the timeout once it's past.
  assert.match(nextWagerAction(s, A, end, none).warning ?? "", /no saved nonce/);
  assert.deepEqual(nextWagerAction(s, A, end + 1 + M, none).action, { kind: "timeout" });
});

test("a torn line or a stray value in the secrets file never loses the next secret or stops the reader", () => {
  const path = join(home(), "s.jsonl");
  const secrets = new WagerSecrets(path);
  const id = "11".repeat(32);
  const first = secrets.newMove(id, 0, 1, "a", 2);
  writeFileSync(path, readFileSync(path, "utf8") + '{"type":"move","ser');
  const next = secrets.newMove(id, 0, 2, "a", 3);
  assert.deepEqual(secrets.move(id, next.hash), next, "written on its own line");
  writeFileSync(path, readFileSync(path, "utf8") + 'null\n42\n{"type":"move","series":"zz"}\n');
  assert.deepEqual(secrets.move(id, first.hash), first);
  assert.deepEqual(secrets.seriesIds(), [id]);
});

test("the runner survives any failure, keeps other series going, backs off, and idles on a policy that can't wager", async () => {
  const done = base();
  done.series!.ending = { winner: "A", reason: 1 };
  const other = base();
  other.header = { ...other.header, seriesId: "99".repeat(32) };
  other.series!.ending = { winner: "B", reason: 1 };
  const acted: string[] = [];
  const logs: string[] = [];
  let idle: string | null = "the policy is a dry run";
  const runner = new WagerRunner({
    wallet: A,
    list: async () => [done, other],
    act: async (id, a) => {
      acted.push(`${id.slice(0, 2)}:${a.kind}`);
      if (id.startsWith("11")) throw new Error("simulation failed");
      return "sent";
    },
    secrets: {
      move: () => undefined,
      fallback: () => {
        throw new TypeError("a bad line");
      },
    },
    stopped: () => false,
    idle: () => idle,
    log: (l) => logs.push(l),
    now: () => 1_141,
  });
  assert.deepEqual(await runner.tick(), []);
  assert.deepEqual(acted, [], "idle: nothing sent");
  assert.match(logs.join("\n"), /not acting: the policy is a dry run/);
  idle = null;
  await runner.tick();
  await runner.tick();
  assert.deepEqual(acted.sort(), ["11:settle", "99:settle"], "one failing series doesn't block the other; it waits before a retry");
  // An exception inside a decision is logged, not thrown.
  const owes = base();
  owes.series!.phase = "reveal";
  owes.series!.round[0] = { hash: null, owesFallback: true, pull: null };
  const r2 = new WagerRunner({ wallet: A, list: async () => [owes], act: async () => "sent", secrets: { move: () => undefined, fallback: () => { throw new TypeError("a bad line"); } }, stopped: () => false, log: (l) => logs.push(l), now: () => 1_141 });
  assert.deepEqual(await r2.tick(), []);
  assert.match(logs.join("\n"), /a bad line/);
});

test("the daemon's heartbeat: fresh, from the lock's own process, for this wallet, cluster and program", () => {
  const paths = agentPaths({ HIGHWIRE_HOME: home() });
  const want = { wallet: A, cluster: "devnet", programId: "P" };
  assert.match((daemonStatus(paths, want) as { reason: string }).reason, /isn't running/);
  const release = holdProcessLock(paths.wagerRunner, "test");
  try {
    assert.match((daemonStatus(paths, want) as { reason: string }).reason, /hasn't read/);
    const beat = { pid: process.pid, wallet: A, cluster: "devnet", programId: "P", beat: Date.now() };
    writeBeat(paths.wagerBeat, beat);
    assert.deepEqual(daemonStatus(paths, want), { ok: true });
    writeBeat(paths.wagerBeat, { ...beat, beat: Date.now() - 21_000 });
    assert.match((daemonStatus(paths, want) as { reason: string }).reason, /last 20 seconds/);
    writeBeat(paths.wagerBeat, { ...beat, pid: process.pid + 1 });
    assert.match((daemonStatus(paths, want) as { reason: string }).reason, /another process/);
    writeBeat(paths.wagerBeat, { ...beat, cluster: "mainnet" });
    assert.match((daemonStatus(paths, want) as { reason: string }).reason, /on mainnet/);
  } finally {
    release();
  }
});

test("the runner beats only after it has read the wallet's series, never while idle or failing", async () => {
  let beats = 0;
  let fail = false;
  let idle: string | null = null;
  const runner = new WagerRunner({ wallet: A, list: async () => { if (fail) throw new Error("rpc"); return []; }, act: async () => "sent", secrets: none, stopped: () => false, idle: () => idle, log: () => undefined, beat: () => beats++ });
  await runner.tick();
  assert.equal(beats, 1);
  fail = true;
  await runner.tick();
  idle = "dry run";
  fail = false;
  await runner.tick();
  assert.equal(beats, 1);
});

test("the open-series count is this wallet's stakes still on-chain, read by address, never by scanning the program", async () => {
  const { paths, signer } = live({ wagers: { max_stake_sol: 0.1, max_open: 1, tiers: [0.1], allow_retire: false } });
  const { seriesAddress } = await import("highwire-core");
  const old = seriesAddress(program, "99".repeat(32)).toBase58();
  // A stake sent two hours ago (outside the ten-minute window): it counts only while its series is still on-chain.
  const { AuditLog } = await import("../src/index.ts");
  const log = new AuditLog(paths.audit, () => new Date(Date.now() - 2 * 3_600_000));
  log.append({ tool: "line_stake", action: "wager", cluster: "devnet", wallet: signer.wallet, outcome: "sent", sol: "0.1", lamports: "100000000", wager: "open", series: old });
  const open = () => signer.execute(fakeConnection({ spend: 104_000_000, onChain: new Set([old]) }), { tool: "t", intent: ask("open"), envelope: wagerEnvelope(signer.publicKey, "open", "aa".repeat(32)) });
  await assert.rejects(open(), /1 series already open/);
  // Once that series has closed, the slot is free.
  const ok = await signer.execute(fakeConnection({ spend: 104_000_000, onChain: new Set() }), { tool: "t", intent: ask("open"), envelope: wagerEnvelope(signer.publicKey, "open", "bb".repeat(32)) });
  assert.equal(ok.status, "sent");
});
