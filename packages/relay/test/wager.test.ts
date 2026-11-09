import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { ticketMessage, WAGER_PROGRAM_IDS } from "highwire-core";
import { wagerTicketMessage, type WagerChain, type WagerConfig, type WagerTicketRecord } from "../src/arena/wager.ts";
import { RelayError } from "../src/errors.ts";
import { MINT, rig, WALLET } from "./fakes.ts";

// The wager desk (docs/wager-mode.md 7.4): pairing at a tier, the signed ticket, the thin-queue and weekly rules, and
// outcomes read from the chain into a wager rating of its own. The chain is a fake: nothing here touches a cluster.

const PROGRAM = WAGER_PROGRAM_IDS.devnet!;
const SECRET = new Uint8Array(32).fill(7);
const TIER = "100000000";

class FakeChain implements WagerChain {
  states = new Map<string, Awaited<ReturnType<WagerChain["status"]>>>();
  async status(id: string) {
    return this.states.get(id) ?? { state: "none" as const };
  }
}

const wallet = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const mint = (n: number) => bs58.encode(new Uint8Array(32).fill(100 + n));

async function setup(over: Partial<WagerConfig> = {}, fighters = 2) {
  const chain = new FakeChain();
  const r = rig({ wager: { programId: PROGRAM, cluster: "devnet", ticketSecret: SECRET, keyId: 1, tiers: [10_000_000n, 100_000_000n], minQueue: 2, chain, ...over } });
  const tokens: string[] = [];
  for (let i = 0; i < fighters; i++) {
    const m = mint(i);
    r.coins.coins.set(m, { name: `Fighter ${i}`, ticker: `F${i}`, createdAt: r.clock.now(), holders: 1, volumeSol: 0, rugFlag: false, creatorHolds: true, creator: wallet(i + 1) });
    tokens.push(await r.register(m, wallet(i + 1)));
  }
  const join = (token: string, stake = TIER, wait = true) => r.call("POST", "/api/arena/wager/join", { stake, wait }, token);
  /** The first two fighters join at once. */
  const pair = async () => {
    const [x, y] = await Promise.all(tokens.slice(0, 2).map((t) => join(t)));
    return [x!, y!] as const;
  };
  return { r, chain, tokens, join, pair };
}

test("two fighters at a tier are paired with one ticket, signed as the program checks it", async () => {
  const { r, tokens, join, pair } = await setup();
  const info = await r.call("GET", "/api/arena/wager");
  assert.deepEqual([info.body.programId, info.body.cluster, info.body.tiers], [PROGRAM, "devnet", ["10000000", "100000000"]]);
  assert.equal(info.body.ticketKey, bs58.encode(ed25519.getPublicKey(SECRET)));
  const [x, y] = await pair();
  assert.equal(x.status, 200, x.text);
  const a = x.body.series;
  const b = y.body.series;
  assert.ok(a && b, `${x.text} ${y.text}`);
  assert.equal(a.id, b.id);
  assert.deepEqual(a.ticket, b.ticket);
  assert.deepEqual([a.role, b.role].sort(), ["A", "B"]);
  assert.equal(a.ticket.stake, TIER);
  // The program refuses an accept deadline later than the expiry (processor.rs open): one time for both.
  assert.equal(a.ticket.acceptDeadline, a.ticket.expiry);
  const left = a.ticket.expiry - Math.floor(r.clock.now() / 1000);
  assert.ok(left > 250 && left <= 300, `the ticket lives about 5 minutes (${left}s left)`);
  // The bytes are the program's (highwire-core's codec), and the signature is the ticket key's.
  const t = a.ticket as WagerTicketRecord;
  const core = ticketMessage(new PublicKey(PROGRAM), { ...t, stake: BigInt(t.stake) });
  assert.deepEqual(Buffer.from(wagerTicketMessage(PROGRAM, t)), core);
  assert.ok(ed25519.verify(Buffer.from(a.signature, "hex"), core, ed25519.getPublicKey(SECRET)));
  // Each fighter's wallet is its side: the one that registered it.
  const wallets = [a.role === "A" ? t.playerA : t.playerB, b.role === "A" ? t.playerA : t.playerB];
  assert.deepEqual(wallets.sort(), [wallet(1), wallet(2)].sort());
  // Joining again while in a series gives the same series back.
  assert.equal((await join(tokens[0]!)).body.series.id, a.id);
  assert.equal((await r.call("GET", "/api/arena/wager/state", undefined, tokens[0])).body.id, a.id);
});

test("a tier pairs only with enough owners waiting; never one owner with itself, nor across tiers", async () => {
  const thin = await setup({ minQueue: 4 });
  const waits = await Promise.all(thin.tokens.map((t) => thin.join(t)));
  for (const w of waits) assert.deepEqual([w.body.waiting, w.body.needed, w.body.waitingAtTier >= 1], [true, 4, true], w.text);
  const tiers = await setup();
  const [p, q] = await Promise.all([tiers.join(tiers.tokens[0]!, "10000000"), tiers.join(tiers.tokens[1]!, TIER)]);
  assert.ok(p.body.waiting && q.body.waiting, "different tiers");
  // Two fighters of one owner.
  const same = await setup({}, 0);
  for (const n of [1, 2]) same.r.coins.coins.set(mint(n), { name: `Twin ${n}`, ticker: `T${n}`, createdAt: 0, holders: 1, volumeSol: 0, rugFlag: false, creatorHolds: true, creator: WALLET });
  const twins = [await same.r.register(mint(1), wallet(9)), await same.r.register(mint(2), wallet(9))];
  const tw = await Promise.all(twins.map((t) => same.join(t)));
  for (const w of tw) assert.equal(w.body.waiting, true, w.text);
});

test("bad tiers and operator fighters are refused; leaving takes the fighter out of the queue", async () => {
  const { r, tokens, join } = await setup();
  assert.equal((await join(tokens[0]!, "5")).status, 400);
  const off = rig();
  const t = await off.register();
  assert.equal((await off.call("POST", "/api/arena/wager/join", { stake: TIER }, t)).status, 404, "off without a wager config");
  const opRig = rig({ operatorWallets: [WALLET], wager: { programId: PROGRAM, cluster: "devnet", ticketSecret: SECRET, keyId: 1, tiers: [100_000_000n], minQueue: 2, chain: new FakeChain() } });
  const opToken = await opRig.register(MINT, WALLET);
  const refused = await opRig.call("POST", "/api/arena/wager/join", { stake: TIER }, opToken);
  assert.deepEqual([refused.status, refused.body.code], [403, "refused"]);
  const waiting = await r.call("POST", "/api/arena/wager/join", { stake: TIER, wait: false }, tokens[0]);
  assert.equal(waiting.body.waiting, true);
  assert.deepEqual((await r.call("POST", "/api/arena/wager/leave", undefined, tokens[0])).body, { left: true });
  assert.deepEqual((await r.call("POST", "/api/arena/wager/leave", undefined, tokens[0])).body, { left: false });
});

test("outcomes come from the chain: a decided series rates both, an expired ticket frees them unrated", async () => {
  const { r, chain, tokens, join, pair } = await setup();
  const [x] = await pair();
  const s = x.body.series;
  const fighterOf = (role: "A" | "B") => (x.body.series.role === role ? mint(0) : mint(1));
  // Live on-chain: nothing changes.
  chain.states.set(s.id, { state: "live" });
  await r.advance(60_000);
  assert.equal((await r.call("GET", "/api/arena/wager/state", undefined, tokens[0])).body.status, "ticketed");
  // Settled to A.
  chain.states.set(s.id, { state: "closed", how: "settled", winner: "A" });
  await r.advance(60_000);
  const after = (await r.call("GET", "/api/arena/wager/state", undefined, tokens[0])).body;
  assert.deepEqual(after, { none: true }, "freed");
  const stored = (id: string) => (r.store.dump()[`arena:fighter:${id}`] as any).wager;
  const winner = stored(fighterOf("A"));
  const loser = stored(fighterOf("B"));
  assert.deepEqual([winner.record, loser.record], [{ win: 1, draw: 0, loss: 0 }, { win: 0, draw: 0, loss: 1 }]);
  assert.ok(winner.rating.r > 1500 && loser.rating.r < 1500);
  // The free-play rating is untouched.
  assert.equal((r.store.dump()[`arena:fighter:${fighterOf("A")}`] as any).rating.r, 1500);
  // A pairing whose ticket expires unopened frees both, unrated (past its time by a margin, for a lagging chain clock).
  // Their ratings are now apart, so the pairing waits for the allowed gap to widen: keep joining, as a client does.
  let [y] = await pair();
  for (let i = 0; i < 4 && !y.body.series; i++) [y] = await pair();
  assert.ok(y.body.series, y.text);
  assert.notEqual(y.body.series.id, s.id);
  await r.advance(5 * 60_000);
  assert.equal((await r.call("GET", "/api/arena/wager/state", undefined, tokens[0])).body.status, "ticketed", "not yet: the margin");
  await r.advance(11 * 60_000);
  assert.deepEqual((await r.call("GET", "/api/arena/wager/state", undefined, tokens[0])).body, { none: true });
  assert.deepEqual(stored(fighterOf("A")).record, winner.record);
  assert.equal((r.store.dump()[`arena:wager:${y.body.series.id}`] as any).result.how, "expired");
});

test("at most two series a week between the same two owners", async () => {
  const { r, chain, tokens, join, pair } = await setup();
  for (let i = 0; i < 2; i++) {
    const [x] = await pair();
    assert.ok(x.body.series, x.text);
    chain.states.set(x.body.series.id, { state: "closed", how: "cancelled" });
    await r.advance(60_000);
  }
  const third = await Promise.all(tokens.map((t) => join(t)));
  for (const w of third) assert.equal(w.body.waiting, true, w.text);
});

// ---------------------------------------------------------------- every way a series can stall ends (the audit, 2026-11-09)

/** Makes the store fail once, as an outage or a killed function would, on the first write to a key matching `re`. */
function failOnce(store: { cas: (...a: any[]) => Promise<number | null> }, re: RegExp) {
  const real = store.cas.bind(store);
  let armed = true;
  store.cas = async (key: string, ...rest: any[]) => {
    if (armed && re.test(key)) {
      armed = false;
      throw new RelayError("paused", "injected outage");
    }
    return real(key, ...rest);
  };
}

test("a series seen live whose closing can't be found closes unrated after an hour; one A opened and B never accepted frees both", async () => {
  const live = await setup();
  const [x] = await live.pair();
  live.chain.states.set(x.body.series.id, { state: "live" });
  await live.r.advance(60_000);
  live.chain.states.delete(x.body.series.id); // gone, and no closing event found
  await live.r.advance(30 * 60_000);
  assert.equal((await live.r.call("GET", "/api/arena/wager/state", undefined, live.tokens[0])).body.status, "ticketed");
  await live.r.advance(31 * 60_000);
  for (const t of live.tokens) assert.deepEqual((await live.r.call("GET", "/api/arena/wager/state", undefined, t)).body, { none: true });
  assert.equal((live.r.store.dump()[`arena:wager:${x.body.series.id}`] as any).result.how, "unread");
  assert.deepEqual((live.r.store.dump()[`arena:fighter:${mint(0)}`] as any).wager.record, { win: 0, draw: 0, loss: 0 }, "unrated");

  const open = await setup();
  const [y] = await open.pair();
  open.chain.states.set(y.body.series.id, { state: "open" });
  await open.r.advance(16 * 60_000);
  for (const t of open.tokens) assert.deepEqual((await open.r.call("GET", "/api/arena/wager/state", undefined, t)).body, { none: true });
  assert.equal((open.r.store.dump()[`arena:wager:${y.body.series.id}`] as any).result.how, "unaccepted");
});

test("a failure half way through closing or ticketing leaves nothing the next sweep can't finish, and rates once", async () => {
  const { r, chain, tokens, pair } = await setup();
  const [x] = await pair();
  chain.states.set(x.body.series.id, { state: "closed", how: "settled", winner: "A" });
  failOnce(r.store as never, /^arena:fighter:/);
  await r.advance(60_000); // this sweep dies half way
  await r.advance(5 * 60_000);
  for (const t of tokens) assert.deepEqual((await r.call("GET", "/api/arena/wager/state", undefined, t)).body, { none: true });
  const recs = [0, 1].map((i) => (r.store.dump()[`arena:fighter:${mint(i)}`] as any).wager.record);
  assert.deepEqual(recs.map((t) => t.win + t.loss).sort(), [1, 1], "rated exactly once each");

  const t2 = await setup();
  failOnce(t2.r.store as never, /^arena:wager:[0-9a-f]{64}$/);
  await t2.pair(); // the first series record never gets written; the two pair again, cleanly
  await t2.r.advance(60_000);
  const open = (t2.r.store.dump() as any)["arena:wagers-open"] as string[];
  const states = await Promise.all(t2.tokens.map(async (t) => (await t2.r.call("GET", "/api/arena/wager/state", undefined, t)).body));
  for (const st of states) assert.ok("none" in st || open.includes(st.id), "every fighter is free or in a series the sweep visits");
  const counts = Object.values((t2.r.store.dump() as any)["arena:wager-queue"].pairs.counts) as number[];
  assert.equal(counts.reduce((n, c) => n + c, 0), open.length, "the failed pairing gave its weekly count back");
});

test("a stale pairing note never hands back a finished series, and two joins at once can't requeue a paired fighter", async () => {
  const { r, chain, tokens, join } = await setup({}, 3);
  const nowait = (t: string) => join(t, TIER, false);
  assert.equal((await nowait(tokens[0]!)).body.waiting, true);
  r.clock.advance(11_000);
  const made = await join(tokens[1]!);
  assert.ok(made.body.series, made.text);
  chain.states.set(made.body.series.id, { state: "closed", how: "cancelled" });
  await r.advance(60_000);
  assert.equal((await nowait(tokens[0]!)).body.waiting, true, "queues again, not the cancelled series");

  const both = await Promise.all([nowait(tokens[1]!), nowait(tokens[1]!)]);
  assert.ok(both.some((b) => b.status === 429), "one join at a time");
});

test("the desk refuses settings it can't sign with, when it's made", () => {
  const base = { programId: PROGRAM, cluster: "devnet" as const, ticketSecret: SECRET, keyId: 1, tiers: [100_000_000n], chain: new FakeChain() };
  assert.throws(() => rig({ wager: { ...base, keyId: Number("x") } }), /key id/);
  assert.throws(() => rig({ wager: { ...base, tiers: [] } }), /tier/);
  assert.throws(() => rig({ wager: { ...base, programId: "nope" } }), /./);
  assert.throws(() => rig({ wager: { ...base, ticketSecret: new Uint8Array(31) } }), /32-byte/);
});
