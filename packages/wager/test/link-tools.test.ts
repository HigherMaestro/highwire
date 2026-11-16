import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { agentPaths, LocalSigner } from "highwire-agent";
import { createServer } from "highwire-mcp";
import { createRelay, FakeClock, linkStakeResultMessage, linkStakeTicketMessage, MemoryStore, type LinkStakeChain, type Relay } from "highwire-relay";
import { FakeCoins, FakeLinkEngine, FakeRpc, launchTx, memoTx } from "highwire-relay/testing";
import { FAKE_OPTIONS } from "../../mcp/test/fake.ts";
import { linkResultMessage, linkTicketMessage } from "../src/link-codec.ts";
import { LINK_SETTLE_GRACE_SECONDS, LinkStakeRunner, nextLinkStakeAction, signedResultOf } from "../src/link-run.ts";
import { linkBattleOutcome, readLinkConfig } from "../src/link-tx.ts";
import { wagerSigningFor } from "../src/signing.ts";
import { registerWagerTools, wagerToolsFor } from "../src/tools.ts";
import { battleOf, DESK_SECRET, fakeDevnet, LINK_PROGRAM, REFEREE_SECRET, signResult, type FakeDevnet } from "./link-fake.ts";

// Practice stakes on link battles, end to end (docs/link-wager.md 3): two agents, each on its own local server with its
// own wallet, policy and audit log, are paired by the referee's desk, stake through the real local signer, play a whole
// link battle with the ordinary tools, and settle on the referee's signed result. The desk and the referee run in
// process; devnet is a fake ledger; the engine is a fake. Nothing touches a network or an emulator.

const POLICY = { version: 1, cluster: "devnet", live: true, actions: ["register", "wager"], max_sol_per_tx: 0.5, max_sol_per_day: 1, max_slippage_bps: 100, transfer_allowlist: [], wagers: { max_stake_sol: 0.25, max_open: 1, tiers: [0.1] } };
const STAKE = { stake: 0.1, fallback: "first", confirm: true };
const HIT = { kind: "move", slot: 0 };
const WAIT = { kind: "move", slot: 1 };

interface World {
  relay: Relay;
  net: FakeDevnet;
  engine: FakeLinkEngine;
  clock: FakeClock;
  rpc: FakeRpc;
  coins: FakeCoins;
  fetch: typeof globalThis.fetch;
  /** Runs what the host would after its responses (turn resolutions), until nothing's left. */
  flush(): Promise<void>;
  sweep(): Promise<void>;
}

function world(): World {
  const clock = new FakeClock(Date.now());
  const rpc = new FakeRpc();
  const coins = new FakeCoins(clock.now());
  const net = fakeDevnet();
  const engine = new FakeLinkEngine();
  const tasks: (() => Promise<unknown>)[] = [];
  const s = { chain: net.chain, program: LINK_PROGRAM };
  // The chain as the site's deployment reads it for the desk: the program's own accounts and closing events.
  const chain: LinkStakeChain = {
    status: (id) => linkBattleOutcome(s, id),
    config: async () => {
      const c = await readLinkConfig(s);
      return { paused: c.paused, ticketKeyId: c.ticketKeyId, resultKeyId: c.resultKeyId };
    },
  };
  const relay = createRelay({
    store: new MemoryStore(clock),
    clock,
    rpc,
    coins,
    link: { engine, rated: true, defer: (t) => tasks.push(t), stakes: { programId: LINK_PROGRAM.toBase58(), ticketSecret: DESK_SECRET, ticketKeyId: 1, resultSecret: REFEREE_SECRET, resultKeyId: 1, tiers: [100_000_000n, 250_000_000n], chain } },
  });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "relay.test") return relay.fetch(new Request(url, init));
    if (url.hostname === "rpc.test") return net.fetch(input, init);
    return (FAKE_OPTIONS.fetch as typeof globalThis.fetch)(input, init);
  }) as typeof globalThis.fetch;
  return {
    relay,
    net,
    engine,
    clock,
    rpc,
    coins,
    fetch,
    flush: async () => {
      while (tasks.length) await tasks.shift()!();
    },
    sweep: async () => void (await relay.fetch(new Request("https://relay.test/api/arena/sweep", { method: "POST" }))),
  };
}

let fighters = 0;

/** A fighter with its own wallet, home, policy and server: what one agent has. `linkProgram: null` is the published package's. */
async function agent(w: World, policy: object = POLICY, linkProgram: PublicKey | null = LINK_PROGRAM) {
  const n = ++fighters;
  const paths = agentPaths({ HIGHWIRE_HOME: mkdtempSync(join(tmpdir(), "highwire-link-tools-")) });
  writeFileSync(paths.policy, JSON.stringify(policy));
  const key = Keypair.generate();
  const mint = bs58.encode(new Uint8Array(32).fill(100 + n));
  w.coins.coins.set(mint, { name: `Fighter ${n}`, ticker: `F${n}`, createdAt: 0, holders: 1, volumeSol: 0, rugFlag: false, creatorHolds: true, creator: key.publicKey.toBase58() });
  const post = (path: string, body: unknown) => w.relay.fetch(new Request(`https://relay.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).then((r) => r.json() as Promise<any>);
  const secret = "ab".repeat(32);
  const launch = w.rpc.add(launchTx({ payer: key.publicKey.toBase58(), mint }));
  const ch = await post("/api/agents/challenge", { wallet: key.publicKey.toBase58(), mint, launchSignature: launch, secretHash: createHash("sha256").update(secret).digest("hex") });
  const memo = w.rpc.add(memoTx(key.publicKey.toBase58(), ch.memo, w.clock.now() + 2000));
  const reg = await post("/api/agents/register", { code: ch.code, signature: memo, secret });
  writeFileSync(paths.agent, JSON.stringify({ arena: { token: reg.arenaToken, fighter: mint, relay: "https://relay.test", registeredAt: "" } }), { mode: 0o600 });
  // The real local signer: the policy, the simulation and the audit log all apply to every stake and settle here.
  const signer = new LocalSigner(key, paths, undefined, undefined, undefined, [wagerSigningFor(linkProgram ? { linkProgram } : {})]);
  const server = createServer({ ...FAKE_OPTIONS, fetch: w.fetch, relayUrl: "https://relay.test", arena: true, link: true, wagers: linkProgram ? wagerToolsFor({ linkProgram }) : registerWagerTools, cluster: "devnet", signer });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]!.text;
    return { isError: Boolean(res.isError), body: JSON.parse(text), text };
  };
  const audit = () =>
    readFileSync(paths.audit, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { outcome: string; wager?: string; tool?: string; lamports?: string });
  return { paths, key, wallet: key.publicKey.toBase58(), call, client, audit, token: reg.arenaToken as string };
}

/** Pairs two agents and stakes both: the first to call waits, the second is paired as A and opens, the first accepts. */
async function staked(w: World, x: Awaited<ReturnType<typeof agent>>, y: Awaited<ReturnType<typeof agent>>) {
  const random = Math.random;
  Math.random = () => 0; // whoever makes the pairing is A, and A is the engine's side 0
  try {
    const waiting = await x.call("link_stake", STAKE);
    assert.equal(waiting.body.waiting, true, waiting.text);
    const opened = await y.call("link_stake", STAKE);
    assert.equal(opened.isError, false, opened.text);
    const accepted = await x.call("link_stake", STAKE);
    assert.equal(accepted.isError, false, accepted.text);
    const on = await x.call("link_stake", STAKE);
    return { opened, accepted, on, battle: opened.body.battle as string, match: on.body.match as string };
  } finally {
    Math.random = random;
  }
}

test("the link stake tools exist only where the program is known", async () => {
  const w = world();
  // The published package: the codec lists no address yet, so the tools aren't there (rather than there and refusing).
  const plain = await agent(w, POLICY, null);
  const names = (await plain.client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("line_stake") && names.includes("link_join"));
  assert.ok(!names.some((n) => n === "link_stake" || n === "link_settle" || n === "link_wagers"));
  const mine = (await (await agent(w)).client.listTools()).tools.map((t) => t.name);
  for (const n of ["link_stake", "link_settle", "link_wagers"]) assert.ok(mine.includes(n), n);
});

test("the desk signs exactly the bytes the program's codec builds", () => {
  const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
  const t = { battleId: "ab".repeat(32), playerA: key(1), playerB: key(2), acceptDeadline: 1_700_000_300, expiry: 1_700_000_600, keyId: 513 };
  assert.deepEqual(Buffer.from(linkStakeTicketMessage(LINK_PROGRAM.toBase58(), { ...t, stake: "250000000" })), linkTicketMessage(LINK_PROGRAM, { ...t, stake: 250_000_000n }));
  for (const outcome of ["a", "b", "draw", "void"] as const) {
    const r = { battleId: "cd".repeat(32), playerA: key(3), playerB: key(4), outcome, keyId: 770 };
    assert.deepEqual(Buffer.from(linkStakeResultMessage(LINK_PROGRAM.toBase58(), r)), linkResultMessage(LINK_PROGRAM, r));
  }
});

test("two agents are paired, stake, play a link battle and settle on the referee's result", async () => {
  const w = world();
  const [x, y] = [await agent(w), await agent(w)];
  const s = await staked(w, x, y);
  // y made the pairing: it is A, staked and opened at once. x accepted. Each stake went through its own signer.
  assert.deepEqual([s.opened.body.you, s.opened.body.stake_sol, s.opened.body.staked.status, s.opened.body.staked.confirmed], ["A", 0.1, "sent", true]);
  assert.deepEqual([s.accepted.body.you, s.accepted.body.staked.status], ["B", "sent"]);
  assert.match(s.accepted.body.next_step, /both stakes are in/);
  assert.deepEqual(w.net.landed, ["open", "accept"]);
  assert.deepEqual(y.audit().filter((e) => e.outcome === "confirmed").map((e) => [e.tool, e.wager]), [["link_stake", "link_open"]]);
  assert.deepEqual(x.audit().filter((e) => e.outcome === "sent").map((e) => [e.wager, e.lamports]), [["link_accept", "100005000"]], "the stake and its fee, as the simulation showed");
  // Both in: the referee started the battle, once, and it's an ordinary link battle marked as a practice stake.
  assert.deepEqual([s.on.body.both_staked, typeof s.match], [true, "string"]);
  assert.equal(w.engine.starts, 1);
  const lists = await y.call("link_wagers");
  assert.deepEqual([lists.body.paired.status, lists.body.paired.match, lists.body.on_chain[0].status, lists.body.on_chain[0].due], ["playing", s.match, "both staked", "the battle has no result yet"]);
  assert.deepEqual([lists.body.tiers_sol, lists.body.today.staked_sol, lists.body.cluster], [[0.1, 0.25], 0.100005, "devnet"]);
  // Nothing to settle while it plays.
  const early = await y.call("link_settle", { confirm: true });
  assert.equal(early.body.settled[0].did, "nothing yet");
  // y (A, the engine's side 0) hits three times; x waits.
  for (let turn = 0; turn < 3; turn++) {
    const view = await y.call("link_state", { wait: false });
    assert.deepEqual([view.body.staked, view.body.rated, view.body.status, view.body.turn], [true, false, "your_decision", turn], view.text);
    assert.equal((await y.call("link_move", { action: HIT, turn })).isError, false);
    assert.equal((await x.call("link_move", { action: WAIT, turn })).isError, false);
    await w.flush();
  }
  const end = await x.call("link_state", { wait: false });
  assert.deepEqual([end.body.status, end.body.ended.result], ["ended", "lost"]);
  assert.match(end.body.next_step, /practice stake: link_settle/);
  // The winner settles: the referee's signed result goes to the program, which pays.
  const due = await y.call("link_wagers");
  assert.equal(due.body.on_chain[0].due, "settle: call link_settle");
  const paid = await y.call("link_settle", { confirm: true });
  assert.equal(paid.isError, false, paid.text);
  assert.deepEqual([paid.body.settled[0].did, paid.body.settled[0].result, paid.body.settled[0].sent.confirmed], ["settle", "you won: both stakes to this wallet", true]);
  assert.deepEqual(w.net.landed, ["open", "accept", "settle:a"]);
  assert.deepEqual(y.audit().filter((e) => e.outcome === "confirmed").map((e) => e.wager), ["link_open", "link_settle"]);
  // The loser has nothing left on-chain, and the desk reads the program's own closing event.
  assert.deepEqual((await x.call("link_settle", { confirm: true })).body.settled, []);
  await w.sweep();
  const after = await x.call("link_wagers");
  assert.deepEqual([after.body.paired, after.body.on_chain, after.body.you.record], [null, [], { win: 0, draw: 0, loss: 1 }]);
  assert.ok(after.body.you.rating < 1500);
  // The wall: the free ladder never moved.
  const board = (await (await w.relay.fetch(new Request("https://relay.test/api/link/leaderboard"))).json()) as { fighters: { rating: number; record: { rated: unknown; unrated: unknown } }[] };
  for (const f of board.fighters) assert.deepEqual([f.rating, f.record.rated, f.record.unrated], [1500, { win: 0, draw: 0, loss: 0 }, { win: 0, draw: 0, loss: 0 }]);
  // No tool ever handed an agent a ticket, a signature or a key.
  const said = [s.opened, s.accepted, s.on, lists, early, end, due, paid, after].map((r) => r.text).join("\n");
  assert.ok(!/"signature":"[0-9a-f]{128}"/.test(said) && !said.includes("ticket"), "no ticket or desk signature in a tool's answer");
  for (const secret of [DESK_SECRET, REFEREE_SECRET]) assert.ok(!said.includes(Buffer.from(secret).toString("hex")));
});

test("a stake outside the policy is refused by the signer, and a dry run stakes nothing", async () => {
  const w = world();
  // The tier is the program's and the desk's, and not this policy's: paired, then refused before anything is sent.
  const small = await agent(w, { ...POLICY, wagers: { max_stake_sol: 0.05, max_open: 1, tiers: [0.05] } });
  const other = await agent(w);
  const random = Math.random;
  Math.random = () => 0;
  try {
    assert.equal((await other.call("link_stake", STAKE)).body.waiting, true);
    const refused = await small.call("link_stake", STAKE);
    assert.deepEqual([refused.isError, refused.body.code], [true, "policy_refused"], refused.text);
    assert.match(refused.body.error, /isn't one of the policy's tiers/);
    assert.deepEqual(w.net.landed, []);
    assert.equal(small.audit().at(-1)!.outcome, "refused");
  } finally {
    Math.random = random;
  }
  // No wager in the policy's actions: refused before the desk is even asked.
  const none = await agent(world(), { ...POLICY, actions: ["register"] });
  assert.equal((await none.call("link_stake", STAKE)).body.code, "policy_refused");
  // A dry-run policy is paired and builds, and sends nothing.
  const w2 = world();
  const dry = await agent(w2, { ...POLICY, live: false });
  const partner = await agent(w2);
  Math.random = () => 0;
  try {
    await partner.call("link_stake", STAKE);
    const out = await dry.call("link_stake", STAKE);
    assert.equal(out.body.staked.status, "dry_run", out.text);
    assert.match(out.body.next_step, /dry run/);
    assert.deepEqual(w2.net.landed, []);
  } finally {
    Math.random = random;
  }
});

test("a stake nobody accepted comes back, and a battle with no result is refunded after its deadline", async () => {
  const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
  const now = 1_800_000_000;
  const ticket = { battleId: "5a".repeat(32), playerA: key(1), playerB: key(2), stake: 100_000_000n, acceptDeadline: now + 300, expiry: now + 300, keyId: 1 };
  const open = battleOf(ticket, "open", now);
  const live = battleOf(ticket, "live", now);
  const result = signResult({ battleId: ticket.battleId, playerA: key(1), playerB: key(2), outcome: "b", keyId: 1 });
  const o = { refundAfterSeconds: 3600 };
  // An opening: cancelled only well past the accept deadline (an early cancel would lose a battle B could still accept).
  assert.equal(nextLinkStakeAction(open, key(1), now + 300, o), null);
  assert.equal(nextLinkStakeAction(open, key(1), now + 380, o), null);
  assert.deepEqual(nextLinkStakeAction(open, key(1), now + 391, o), { kind: "cancel" });
  assert.deepEqual(nextLinkStakeAction(open, key(2), now + 391, o), { kind: "cancel" }, "either side may, after the deadline");
  assert.equal(nextLinkStakeAction(open, key(9), now + 391, o), null, "a stranger's battle is none of this wallet's");
  // Live with a result: the winner sends at once, the other after a grace; a tool (no grace clock) sends at once.
  assert.deepEqual(nextLinkStakeAction(live, key(2), now + 10, { ...o, result, resultSeenAt: now + 10 }), { kind: "settle", signed: result });
  assert.equal(nextLinkStakeAction(live, key(1), now + 10, { ...o, result, resultSeenAt: now + 10 }), null);
  assert.deepEqual(nextLinkStakeAction(live, key(1), now + 10 + LINK_SETTLE_GRACE_SECONDS, { ...o, result, resultSeenAt: now + 10 })?.kind, "settle");
  assert.equal(nextLinkStakeAction(live, key(1), now + 10, { ...o, result })?.kind, "settle");
  // A draw or a void: A goes first.
  const draw = signResult({ ...result.result, outcome: "draw" });
  assert.equal(nextLinkStakeAction(live, key(1), now, { ...o, result: draw, resultSeenAt: now })?.kind, "settle");
  assert.equal(nextLinkStakeAction(live, key(2), now, { ...o, result: draw, resultSeenAt: now }), null);
  // A result for another battle or other wallets isn't this battle's.
  assert.equal(nextLinkStakeAction(live, key(2), now, { ...o, result: signResult({ ...result.result, battleId: "6b".repeat(32) }) }), null);
  assert.equal(nextLinkStakeAction(live, key(2), now, { ...o, result: signResult({ ...result.result, playerA: key(7) }) }), null);
  // No result: refunded only past the program's deadline.
  assert.equal(nextLinkStakeAction(live, key(1), now + 3600, o), null);
  assert.deepEqual(nextLinkStakeAction(live, key(1), now + 3611, o), { kind: "refund" });
  // What the referee serves is checked for shape before anything is built from it.
  assert.deepEqual(signedResultOf(result), result);
  for (const bad of [null, {}, { ...result, signature: "zz" }, { result: { ...result.result, outcome: "c" }, signature: result.signature }, { result: { ...result.result, playerA: "nope" }, signature: result.signature }]) assert.equal(signedResultOf(bad), null);

  // The daemon's pass: it acts once per thing due, asks the referee only when a battle is live, and stops at STOP.
  const acted: string[] = [];
  let battles = [open];
  let asked = 0;
  let stopped = false;
  let clock = now + 100;
  const runner = new LinkStakeRunner({
    wallet: key(1),
    battles: async () => battles,
    results: async () => {
      asked++;
      return new Map([[ticket.battleId, result]]);
    },
    refundAfterSeconds: async () => 3600,
    act: async (id, action) => {
      acted.push(`${id.slice(0, 2)}:${action.kind}`);
      return "sent";
    },
    stopped: () => stopped,
    log: () => undefined,
    now: () => clock,
  });
  assert.deepEqual(await runner.tick(), []);
  assert.equal(asked, 0, "an opening needs nothing from the referee");
  clock = now + 400;
  assert.deepEqual((await runner.tick()).map((r) => r.action), ["cancel"]);
  assert.deepEqual(await runner.tick(), [], "not again straight away");
  // Live, and this wallet (A) lost: it waits out the winner's grace, then settles.
  battles = [live];
  assert.deepEqual(await runner.tick(), []);
  assert.equal(asked, 1);
  clock += LINK_SETTLE_GRACE_SECONDS;
  assert.deepEqual((await runner.tick()).map((r) => r.action), ["settle"]);
  stopped = true;
  battles = [{ ...live, battleId: "7c".repeat(32) }];
  assert.deepEqual(await runner.tick(), [], "the kill switch halts it");
  assert.deepEqual(acted, ["5a:cancel", "5a:settle"]);
});

test("an agent that walks away loses nothing it's owed: its opening is cancelled by link_settle once the deadline has passed", async () => {
  const w = world();
  const [x, y] = [await agent(w), await agent(w)];
  const random = Math.random;
  Math.random = () => 0;
  try {
    await x.call("link_stake", STAKE);
    const opened = await y.call("link_stake", STAKE);
    assert.equal(opened.body.staked.confirmed, true, opened.text);
    // x never accepts. Before the deadline there's nothing to do.
    const early = await y.call("link_settle", { confirm: true });
    assert.deepEqual([early.body.settled[0].did, w.net.landed], ["nothing yet", ["open"]]);
    assert.equal((await y.call("link_stake", STAKE)).body.waiting_for_opponent, true);
  } finally {
    Math.random = random;
  }
  // Past the accept deadline (and its margin): the battle account says so, whatever this machine's desk thinks.
  const at = [...w.net.accounts.keys()].find((k) => w.net.accounts.get(k)!.data.length === 140)!;
  const data = w.net.accounts.get(at)!.data;
  data.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) - 200), 108); // accept_deadline
  const back = await y.call("link_settle", { confirm: true });
  assert.deepEqual([back.body.settled[0].did, back.body.settled[0].sent.confirmed], ["cancel", true], back.text);
  assert.deepEqual(w.net.landed, ["open", "cancel"]);
  assert.deepEqual(y.audit().filter((e) => e.outcome === "confirmed").map((e) => e.wager), ["link_open", "link_cancel"]);
});
