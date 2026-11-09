import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { ticketMessage, WAGER_PROGRAM_IDS } from "highwire-core";
import { wagerTicketMessage, type WagerChain, type WagerConfig, type WagerTicketRecord } from "../src/arena/wager.ts";
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
  const join = (token: string, stake = TIER) => r.call("POST", "/api/arena/wager/join", { stake }, token);
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
  assert.ok(a.ticket.acceptDeadline > a.ticket.expiry, "B has longer to accept than A to open");
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
  // A pairing whose ticket expires unopened frees both, unrated.
  // Their ratings are now apart, so the pairing waits for the allowed gap to widen: keep joining, as a client does.
  let [y] = await pair();
  for (let i = 0; i < 4 && !y.body.series; i++) [y] = await pair();
  assert.ok(y.body.series, y.text);
  assert.notEqual(y.body.series.id, s.id);
  await r.advance(5 * 60_000);
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
