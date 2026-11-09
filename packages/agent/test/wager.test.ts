import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import { arena, decodeSeriesAccount, ENVELOPE_FORMAT, HOW_TO_SIGN, solToLamports, type Envelope, type SeriesAccountData } from "highwire-core";
import {
  agentPaths,
  checkPolicy,
  DEADLINE_MARGIN_SECONDS,
  GENESIS_HASHES,
  LocalSigner,
  nextWagerAction,
  POLICY_TEMPLATE,
  PolicySchema,
  WagerRunner,
  WagerSecrets,
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

function envelopeFor(wallet: PublicKey): Envelope {
  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: wallet, recentBlockhash: PublicKey.default.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wallet, lamports: 0 })] }).compileToV0Message(),
  );
  return {
    format: ENVELOPE_FORMAT,
    cluster: "devnet",
    wallet: wallet.toBase58(),
    kind: "wager",
    transactions: [
      {
        index: 0,
        label: "a wager",
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

const fakeConnection = () =>
  ({
    getGenesisHash: async () => GENESIS_HASHES.devnet,
    getBalance: async () => 2e9,
    simulateTransaction: async () => ({ value: { err: null, logs: [], accounts: [{ lamports: 2e9 }] } }),
    sendRawTransaction: async () => "sig",
    confirmTransaction: async () => ({ value: { err: null } }),
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 200 }),
    getTransaction: async () => null,
  }) as unknown as Connection;

test("STOP-WAGERS refuses new stakes and lets open series play out; STOP refuses everything", async () => {
  const paths = agentPaths({ HIGHWIRE_HOME: home() });
  writeFileSync(paths.policy, JSON.stringify(policy({ live: true })));
  const signer = new LocalSigner(Keypair.generate(), paths);
  const env = envelopeFor(signer.publicKey);
  const reveal: Intent = { action: "wager", cluster: "devnet", solOut: 0n, wager: { kind: "reveal" } };
  writeFileSync(paths.stopWagers, "");
  await assert.rejects(signer.execute(fakeConnection(), { tool: "t", intent: stake(0.1), envelope: env }), /No new wagers/);
  await assert.rejects(signer.execute(fakeConnection(), { tool: "t", intent: stake(0.1, 0, "accept"), envelope: env }), /No new wagers/);
  assert.equal((await signer.execute(fakeConnection(), { tool: "t", intent: reveal, envelope: env })).status, "sent");
  writeFileSync(paths.stop, "");
  await assert.rejects(signer.execute(fakeConnection(), { tool: "t", intent: reveal, envelope: env }), (e: { code?: string }) => e.code === "signer_stopped");
  const log = readFileSync(paths.audit, "utf8");
  assert.match(log, /"action":"wager"/);
  assert.match(log, /No new wagers/);
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
const codec = JSON.parse(readFileSync(new URL("../../core/test/fixtures/wager-codec.json", import.meta.url), "utf8"));
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
  assert.equal(nextWagerAction(open, A, open.header.acceptDeadline, none).action, null);
  assert.deepEqual(nextWagerAction(open, A, open.header.acceptDeadline + 1 + M, none).action, { kind: "cancel" });
  assert.equal(nextWagerAction(open, B, open.header.acceptDeadline + 1 + M, none).action, null, "only the opener cancels");
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
