import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Keypair, PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { agentPaths, holdProcessLock, LocalSigner, type ExecuteRequest, type ExecuteResult } from "highwire-agent";
import { arena, decodeWager, describeTransaction, seriesAddress, wagerConfigAddress, WAGER_PROGRAM_IDS } from "highwire-core";
import { createRelay, FakeClock, MemoryStore, type Relay, type WagerChain } from "highwire-relay";
import { FakeCoins, FakeRpc, launchTx, memoTx } from "highwire-relay/testing";
import { createServer } from "../src/server.ts";
import { FAKE_OPTIONS } from "./fake.ts";

// The wager tools end to end (docs/wager-mode.md 7.6), on devnet: an agent on the local server is paired by the
// referee's wager desk (in process, with a fake chain), stakes through its policy, commits a move whose nonce never
// leaves the machine, and reads its series. The Solana RPC is a fake answering from the codec file's accounts; the
// signer's send is captured. Nothing touches a network.

const PROGRAM = new PublicKey(WAGER_PROGRAM_IDS.devnet!);
const TICKET_SECRET = new Uint8Array(32).fill(7);
const codec = JSON.parse(readFileSync(new URL("../../core/test/fixtures/wager-codec.json", import.meta.url), "utf8"));
const BLOCKHASH = bs58.encode(new Uint8Array(32).fill(9));
const STAKE = 100_000_000;

/** The codec file's config, with the desk's ticket key and key id 1. */
function configBytes(): Buffer {
  const b = Buffer.from(codec.config, "hex");
  Buffer.from(ed25519.getPublicKey(TICKET_SECRET)).copy(b, 33);
  b.writeUInt16LE(1, 65);
  return b;
}

/** The codec file's mid-game series (id 11..11, round 2 of match 0 in its commit phase), with `wallet` as player A. */
function seriesBytes(wallet: PublicKey): Buffer {
  const b = Buffer.from(codec.seriesAccount, "hex");
  wallet.toBuffer().copy(b, 34);
  return b;
}

const account = (data: Buffer) => ({ data: [data.toString("base64"), "base64"], executable: false, lamports: 10_000_000, owner: PROGRAM.toBase58(), rentEpoch: 0, space: data.length });

interface World {
  relay: Relay;
  rpc: FakeRpc;
  clock: FakeClock;
  fetch: typeof globalThis.fetch;
  /** Accounts the fake devnet RPC holds, by address. */
  accounts: Map<string, Buffer>;
}

function world(): World {
  const clock = new FakeClock(Date.now());
  const rpc = new FakeRpc();
  const chain: WagerChain = { status: async () => ({ state: "none" }) };
  const relay = createRelay({
    store: new MemoryStore(clock),
    clock,
    rpc,
    coins: new FakeCoins(clock.now()),
    referee: { wager: { programId: PROGRAM.toBase58(), cluster: "devnet", ticketSecret: TICKET_SECRET, keyId: 1, tiers: [10_000_000n, 100_000_000n], minQueue: 2, chain } },
  });
  const accounts = new Map<string, Buffer>([[wagerConfigAddress(PROGRAM).toBase58(), configBytes()]]);
  const answer = (method: string, params: any[]): unknown => {
    if (method === "getRecentPrioritizationFees") return [];
    if (method === "getLatestBlockhash") return { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 } };
    if (method === "simulateTransaction") return { context: { slot: 1 }, value: { err: null, logs: [], accounts: null, unitsConsumed: 15_000, returnData: null } };
    if (method === "getAccountInfo") {
      const a = accounts.get(params[0]);
      return { context: { slot: 1 }, value: a ? account(a) : null };
    }
    if (method === "getMultipleAccounts") return { context: { slot: 1 }, value: (params[0] as string[]).map((k) => (accounts.has(k) ? account(accounts.get(k)!) : null)) };
    if (method === "getProgramAccounts") {
      const offset = params[1]?.filters?.[0]?.memcmp?.offset;
      const want = params[1]?.filters?.[0]?.memcmp?.bytes;
      return [...accounts]
        .filter(([, d]) => d.length > 100 && bs58.encode(d.subarray(offset, offset + 32)) === want)
        .map(([pubkey, d]) => ({ pubkey, account: account(d) }));
    }
    return null;
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "relay.test") return relay.fetch(new Request(url, init));
    if (url.hostname === "rpc.test") {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: answer(body.method, body.params ?? []) }));
    }
    return (FAKE_OPTIONS.fetch as typeof globalThis.fetch)(input, init);
  }) as typeof globalThis.fetch;
  return { relay, rpc, clock, fetch, accounts };
}

/** The local signer with its send captured: the policy checks before it are the real LocalSigner's (precheck). */
class CapturingSigner extends LocalSigner {
  sent: ExecuteRequest[] = [];
  override async execute(_c: Connection, req: ExecuteRequest): Promise<ExecuteResult> {
    this.sent.push(req);
    return { status: "sent", wallet: this.wallet, cluster: "devnet", transactions: [{ index: 0, label: "wager", signature: "sig", confirmed: true }], summary: [], spentSol: 0, dayLeftSol: 1 };
  }
}

const POLICY = { version: 1, cluster: "devnet", live: true, actions: ["register", "wager"], max_sol_per_tx: 0.5, max_sol_per_day: 1, max_slippage_bps: 100, transfer_allowlist: [], wagers: { max_stake_sol: 0.1, max_open: 1, tiers: [0.1] } };

/** Registers `key`'s coin with the relay (as line_register would), returning its arena token, and files it for the tools. */
async function enroll(w: World, key: Keypair, mint: string, paths?: ReturnType<typeof agentPaths>): Promise<string> {
  const call = (path: string, body: unknown) => w.relay.fetch(new Request(`https://relay.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).then((r) => r.json() as Promise<any>);
  const secret = "ab".repeat(32);
  const launch = w.rpc.add(launchTx({ payer: key.publicKey.toBase58(), mint }));
  const { createHash } = await import("node:crypto");
  const ch = await call("/api/agents/challenge", { wallet: key.publicKey.toBase58(), mint, launchSignature: launch, secretHash: createHash("sha256").update(secret).digest("hex") });
  const memo = w.rpc.add(memoTx(key.publicKey.toBase58(), ch.memo, w.clock.now() + 2000));
  const reg = await call("/api/agents/register", { code: ch.code, signature: memo, secret });
  if (paths) writeFileSync(paths.agent, JSON.stringify({ arena: { token: reg.arenaToken, fighter: mint, relay: "https://relay.test", registeredAt: "" } }), { mode: 0o600 });
  return reg.arenaToken;
}

async function setup(policy: object = POLICY, cluster: "devnet" | "mainnet" = "devnet") {
  const w = world();
  const paths = agentPaths({ HIGHWIRE_HOME: mkdtempSync(join(tmpdir(), "highwire-wager-tools-")) });
  writeFileSync(paths.policy, JSON.stringify(policy));
  const key = Keypair.generate();
  const signer = new CapturingSigner(key, paths);
  const mint = bs58.encode(new Uint8Array(32).fill(201));
  const coins = (w.relay.referee as any).coins as FakeCoins;
  coins.coins.set(mint, { name: "Staker", ticker: "STK", createdAt: 0, holders: 1, volumeSol: 0, rugFlag: false, creatorHolds: true, creator: key.publicKey.toBase58() });
  await enroll(w, key, mint, paths);
  const server = createServer({ ...FAKE_OPTIONS, fetch: w.fetch, relayUrl: "https://relay.test", arena: true, cluster, signer });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]!.text;
    return { isError: Boolean(res.isError), body: JSON.parse(text), text };
  };
  return { w, paths, key, signer, call, coins };
}

test("staking refuses without the reveal daemon, off devnet, or outside the policy", async () => {
  const s = await setup();
  const args = { stake: 0.1, fallback: "steady:2", confirm: true };
  const off = await s.call("line_stake", args);
  assert.deepEqual([off.isError, off.body.code], [true, "line_daemon_off"]);
  const release = holdProcessLock(s.paths.wagerRunner, "test");
  try {
    const mainnet = await setup({ ...POLICY, cluster: "mainnet" }, "mainnet");
    const m = await mainnet.call("line_stake", args);
    assert.match(m.body.error, /devnet only/);
    const noWager = await setup({ ...POLICY, actions: ["register"] });
    const releaseB = holdProcessLock(noWager.paths.wagerRunner, "test");
    const n = await noWager.call("line_stake", args);
    releaseB();
    assert.deepEqual([n.isError, n.body.code], [true, "policy_refused"]);
  } finally {
    release();
  }
  assert.equal(s.signer.sent.length, 0, "nothing was sent");
});

test("an agent is paired, then stakes and opens as A through the signer; its fallback's salt stays on the machine", async () => {
  const s = await setup();
  // A second fighter waits at the tier, from another wallet.
  const other = Keypair.generate();
  const otherMint = bs58.encode(new Uint8Array(32).fill(202));
  s.coins.coins.set(otherMint, { name: "Other", ticker: "OTH", createdAt: 0, holders: 1, volumeSol: 0, rugFlag: false, creatorHolds: true, creator: other.publicKey.toBase58() });
  const otherToken = await enroll(s.w, other, otherMint);
  await s.w.relay.fetch(new Request("https://relay.test/api/arena/wager/join", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${otherToken}` }, body: JSON.stringify({ stake: String(STAKE), wait: false }) }));
  s.w.clock.advance(11_000);
  const release = holdProcessLock(s.paths.wagerRunner, "test");
  const random = Math.random;
  Math.random = () => 0; // the caller who makes the pairing plays A
  try {
    const out = await s.call("line_stake", { stake: 0.1, fallback: "steady:2", confirm: true });
    assert.equal(out.isError, false, out.text);
    assert.deepEqual([out.body.paired, out.body.you, out.body.stake_sol, out.body.staked.status], [true, "A", 0.1, "sent"]);
    // What went to the signer: one wager open, staking 0.1 SOL, with the ticket check just before it.
    const req = s.signer.sent[0]!;
    assert.deepEqual([req.tool, req.intent.action, req.intent.wager?.kind, req.intent.solOut], ["line_stake", "wager", "open", 100_000_000n]);
    const tx = VersionedTransaction.deserialize(Buffer.from(req.envelope.transactions[0]!.base64, "base64"));
    const d = describeTransaction(tx, "devnet");
    assert.deepEqual(d.wagers.map((x) => [x.kind, x.stake]), [["open", 100_000_000n]]);
    assert.ok(d.instructions.some((i) => /matchmaker's signature/.test(i.text)));
    // The fallback committed in the open is the one saved, and its salt appears in no answer.
    const open = tx.message.compiledInstructions.find((ix) => tx.message.staticAccountKeys[ix.programIdIndex]!.equals(PROGRAM))!;
    const decoded = decodeWager(Buffer.from(open.data)) as { fallbackHash: string; seriesId: string };
    const saved = readFileSync(s.paths.wagerSecrets, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(saved.length, 1);
    assert.equal(decoded.fallbackHash, arena.fallbackCommitment(decoded.seriesId, "A", { kind: "steady", pull: 2 }, saved[0].salt));
    assert.ok(!out.text.includes(saved[0].salt));
  } finally {
    Math.random = random;
    release();
  }
});

test("a wager move commits on-chain at once; the nonce is saved first and never returned; no table talk", async () => {
  const s = await setup();
  const id = "11".repeat(32);
  s.w.accounts.set(seriesAddress(PROGRAM, id).toBase58(), seriesBytes(s.key.publicKey));
  const release = holdProcessLock(s.paths.wagerRunner, "test");
  try {
    const st = await s.call("line_state", { series: id, wait: false });
    assert.equal(st.isError, false, st.text);
    assert.deepEqual([st.body.you, st.body.side, st.body.match, st.body.round, st.body.phase, st.body.your_move], ["A", "a", 1, 2, "commit", true]);
    assert.deepEqual(st.body.energy, { you: 28, them: 23 });
    assert.deepEqual(st.body.their_fallback, { kind: "steady", pull: 9 });

    const talk = await s.call("line_move", { series: id, pull: 3, line: "nice try" });
    assert.match(talk.body.error, /no table talk/);
    const greedy = await s.call("line_move", { series: id, pull: 29 });
    assert.match(greedy.body.error, /28 energy/);
    const late = await s.call("line_move", { series: id, pull: 3, round: 1 });
    assert.equal(late.body.code, "line_late");

    const out = await s.call("line_move", { series: id, pull: 3 });
    assert.equal(out.isError, false, out.text);
    const req = s.signer.sent.at(-1)!;
    assert.deepEqual([req.tool, req.intent.wager?.kind, req.intent.solOut], ["line_move", "commit", 0n]);
    const tx = VersionedTransaction.deserialize(Buffer.from(req.envelope.transactions[0]!.base64, "base64"));
    const ix = tx.message.compiledInstructions.find((x) => tx.message.staticAccountKeys[x.programIdIndex]!.equals(PROGRAM))!;
    const commit = decodeWager(Buffer.from(ix.data)) as { round: number; hash: string };
    const saved = JSON.parse(readFileSync(s.paths.wagerSecrets, "utf8").trim().split("\n").at(-1)!);
    assert.equal(commit.round, 2);
    assert.equal(commit.hash, arena.moveCommitment(id, 0, 2, "a", 3, saved.nonce), "the commitment opens with the saved nonce");
    assert.ok(!out.text.includes(saved.nonce), "the nonce never leaves the machine");
  } finally {
    release();
  }
  // Without the daemon, a commit would never be revealed: refused.
  const off = await s.call("line_move", { series: id, pull: 3 });
  assert.equal(off.body.code, "line_daemon_off");
});

test("line_wagers lists the wallet's series, the tiers, the record and whether the daemon runs", async () => {
  const s = await setup();
  s.w.accounts.set(seriesAddress(PROGRAM, "11".repeat(32)).toBase58(), seriesBytes(s.key.publicKey));
  const out = await s.call("line_wagers");
  assert.equal(out.isError, false, out.text);
  assert.equal(out.body.series.length, 1);
  assert.equal(out.body.series[0].series, "11".repeat(32));
  assert.deepEqual(out.body.tiers_sol, [0.01, 0.1]);
  assert.deepEqual(out.body.you.record, { win: 0, draw: 0, loss: 0 });
  assert.match(out.body.reveal_daemon, /NOT running/);
});
