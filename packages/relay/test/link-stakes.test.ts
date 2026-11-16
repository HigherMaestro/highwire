import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import type { LinkAction } from "../src/link/referee.ts";
import { linkStakeResultMessage, linkStakeTicketMessage, LinkStakeDesk, stakeOutcome, type LinkStakeChain, type LinkStakeConfig } from "../src/link/stakes.ts";
import { FakeLinkEngine, MINT, MINT2, OTHER, rig, WALLET } from "./fakes.ts";

// Link battles' practice stakes, the referee's side (docs/link-wager.md 2, 3): pairing at a tier and the signed
// ticket; the battle started once the chain shows both stakes; the result signed when it ends; every way a stake can
// stall; and the wall around practice (no free-ladder change). The chain and the engine are fakes: nothing here touches
// a cluster or an emulator. That the signed bytes are the ones the program checks is tested in highwire-wager, which
// has the program's codec (test/link-tools.test.ts).

const PROGRAM = bs58.encode(new Uint8Array(32).fill(0x50));
const TICKET_SECRET = new Uint8Array(32).fill(7);
const RESULT_SECRET = new Uint8Array(32).fill(9);
const TIER = "100000000";
const HIT: LinkAction = { kind: "move", slot: 0 };
const WAIT: LinkAction = { kind: "move", slot: 1 };
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

class FakeChain implements LinkStakeChain {
  states = new Map<string, Awaited<ReturnType<LinkStakeChain["status"]>>>();
  asked = 0;
  /** The RPC not answering. */
  down = false;
  async status(id: string) {
    this.asked++;
    if (this.down) throw new Error("the RPC is down");
    return this.states.get(id) ?? { state: "none" as const };
  }
}

async function setup(over: Partial<LinkStakeConfig> = {}) {
  const chain = new FakeChain();
  const engine = new FakeLinkEngine();
  const tasks: (() => Promise<unknown>)[] = [];
  const stakes: LinkStakeConfig = { programId: PROGRAM, ticketSecret: TICKET_SECRET, ticketKeyId: 1, resultSecret: RESULT_SECRET, resultKeyId: 2, tiers: [100_000_000n, 250_000_000n], chain, ...over };
  const r = rig(undefined, { engine, rated: true, defer: (t) => tasks.push(t), stakes });
  const flush = async () => {
    while (tasks.length) await tasks.shift()!();
  };
  const a = await r.register(MINT);
  const b = await r.register(MINT2, OTHER);
  const join = (token: string, body: Record<string, unknown> = {}) => r.call("POST", "/api/link/stake/join", { stake: TIER, fallback: "first", ...body }, token);
  const state = (token: string) => r.call("GET", "/api/link/stake/state", undefined, token);
  /** Both join at once and are paired: each one's view of the stake. */
  const pair = async () => {
    const [x, y] = await Promise.all([join(a), join(b)]);
    assert.equal(x.status, 200, x.text);
    assert.ok(x.body.stake && y.body.stake, `${x.text} ${y.text}`);
    return { a: x.body.stake, b: y.body.stake, id: x.body.stake.battle as string };
  };
  /** Pairs them, puts both stakes on the fake chain, and starts the battle: the match, and which token plays which side. */
  const playing = async () => {
    const p = await pair();
    chain.states.set(p.id, { state: "live" });
    const st = await state(a);
    assert.equal(st.body.status, "playing", st.text);
    const match = st.body.match as string;
    const sideOf = async (token: string) => ((await r.call("GET", `/api/link/state?match=${match}`, undefined, token)).body.view.only_for === "side 0" ? 0 : 1);
    const tokens: [string, string] = (await sideOf(a)) === 0 ? [a, b] : [b, a];
    /** Plays turns: each side's action by engine side, resolved after the answers. */
    const turn = async (n: number, zero: LinkAction, one: LinkAction) => {
      for (const [i, action] of [zero, one].entries()) {
        const res = await r.call("POST", "/api/link/move", { match, turn: n, action }, tokens[i]!);
        assert.equal(res.status, 200, res.text);
      }
      await flush();
    };
    return { ...p, match, tokens, turn };
  };
  return { r, chain, engine, flush, a, b, join, state, pair, playing };
}

test("staking is off without its settings, and the desk never takes one key for both jobs", async () => {
  const r = rig(undefined, { engine: new FakeLinkEngine(), rated: true });
  const t = await r.register();
  assert.equal((await r.call("GET", "/api/link/stake")).status, 404);
  assert.equal((await r.call("POST", "/api/link/stake/join", { stake: TIER, fallback: "first" }, t)).status, 404);
  // Staked battles are played as rated battles are: no desk without them.
  const chain = new FakeChain();
  const cfg: LinkStakeConfig = { programId: PROGRAM, ticketSecret: TICKET_SECRET, ticketKeyId: 1, resultSecret: RESULT_SECRET, resultKeyId: 2, tiers: [100_000_000n], chain };
  assert.equal(rig(undefined, { engine: new FakeLinkEngine(), stakes: cfg }).relay.linkStakes, null);
  const make = (over: Partial<LinkStakeConfig>) => () => rig(undefined, { engine: new FakeLinkEngine(), rated: true, stakes: { ...cfg, ...over } });
  assert.throws(make({ resultSecret: TICKET_SECRET }), /must be different keys/);
  assert.throws(make({ ticketSecret: new Uint8Array(31) }), /32-byte Ed25519 secret/);
  assert.throws(make({ tiers: [] }), /positive number of lamports/);
  assert.throws(make({ programId: "abc" }), /isn't an address/);
});

test("two fighters at a tier get one ticket, signed as the program checks it, and are held for it", async () => {
  const s = await setup();
  const info = await s.r.call("GET", "/api/link/stake");
  assert.deepEqual([info.body.programId, info.body.cluster, info.body.tiers], [PROGRAM, "devnet", ["100000000", "250000000"]]);
  assert.equal(info.body.ticketKey, bs58.encode(ed25519.getPublicKey(TICKET_SECRET)));
  assert.equal(info.body.resultKey, bs58.encode(ed25519.getPublicKey(RESULT_SECRET)));
  // A tier that isn't one, and no fallback, are refused before anything is queued.
  assert.equal((await s.join(s.a, { stake: "5" })).status, 400);
  assert.equal((await s.join(s.a, { fallback: undefined })).status, 400);
  const p = await s.pair();
  assert.equal(p.a.battle, p.b.battle);
  assert.match(p.id, /^[0-9a-f]{64}$/);
  assert.deepEqual(p.a.ticket, p.b.ticket);
  assert.deepEqual([p.a.role, p.b.role].sort(), ["A", "B"]);
  const t = p.a.ticket;
  assert.deepEqual([t.playerA, t.playerB].sort(), [WALLET, OTHER].sort());
  assert.equal(p.a.role === "A" ? t.playerA : t.playerB, WALLET, "each wallet under its own letter");
  assert.deepEqual([t.stake, t.keyId, t.acceptDeadline === t.expiry], [TIER, 1, true]);
  assert.ok(ed25519.verify(hex(p.a.signature), linkStakeTicketMessage(PROGRAM, t), ed25519.getPublicKey(TICKET_SECRET)));
  assert.equal(linkStakeTicketMessage(PROGRAM, t).length, 176);
  assert.match(p.a.role === "A" ? p.a.next : p.b.next, /Open the battle now/);
  // Joining again gives the same stake back; nothing else may be played while it's held.
  assert.equal((await s.join(s.a)).body.stake.battle, p.id);
  assert.equal((await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a)).status, 409);
  assert.equal((await s.r.call("POST", "/api/link/join", { fallback: "first", opponent: "house" }, s.b)).status, 409);
  // Neither secret is anywhere in what the desk serves.
  const all = JSON.stringify([info.body, p, (await s.state(s.a)).body]);
  for (const secret of [TICKET_SECRET, RESULT_SECRET]) assert.ok(!all.includes(Buffer.from(secret).toString("hex")) && !all.includes(bs58.encode(secret)));
});

test("the battle starts once both stakes are in, once, and its result is signed for the winner's wallet", async () => {
  const s = await setup();
  const p = await s.pair();
  // Nothing staked, then only A: no battle.
  assert.equal((await s.state(s.a)).body.status, "ticketed");
  s.chain.states.set(p.id, { state: "open" });
  assert.equal((await s.state(s.b)).body.status, "ticketed");
  assert.equal(s.engine.starts, 0);
  // Both in: whoever looks first starts it, and everyone after finds the same battle.
  s.chain.states.set(p.id, { state: "live" });
  const [x, y] = await Promise.all([s.state(s.a), s.state(s.b)]);
  await s.r.advance(60_000);
  const again = await s.state(s.b);
  assert.equal(s.engine.starts, 1, "one battle, however many look");
  const match = again.body.match as string;
  assert.match(match, /^[a-z2-9]{10}$/);
  assert.ok([x.body.match, y.body.match].every((m) => m === undefined || m === match));
  assert.match(again.body.next, /play it with link_state and link_move/);
  // It's an ordinary link battle, marked as a practice stake, never rated.
  const mine = await s.r.call("GET", `/api/link/state?match=${match}`, undefined, s.a);
  assert.deepEqual([mine.body.staked, mine.body.rated, mine.body.status], [true, false, "your_decision"]);
  const sideOf = async (token: string) => ((await s.r.call("GET", `/api/link/state?match=${match}`, undefined, token)).body.view.only_for === "side 0" ? 0 : 1);
  const winner = (await sideOf(s.a)) === 0 ? s.a : s.b;
  const loser = winner === s.a ? s.b : s.a;
  for (let turn = 0; turn < 3; turn++) {
    await s.r.call("POST", "/api/link/move", { match, turn, action: HIT }, winner);
    await s.r.call("POST", "/api/link/move", { match, turn, action: WAIT }, loser);
    await s.flush();
  }
  const won = await s.state(winner);
  const lost = await s.state(loser);
  assert.equal(won.body.status, "over", won.text);
  assert.deepEqual([won.body.result.you, lost.body.result.you], ["won", "lost"]);
  assert.deepEqual(won.body.result.result, lost.body.result.result, "one result, the same for both");
  const res = won.body.result.result;
  assert.deepEqual([res.battleId, res.playerA, res.playerB, res.keyId], [p.id, p.a.ticket.playerA, p.a.ticket.playerB, 2]);
  assert.equal(res.outcome, won.body.role === "A" ? "a" : "b", "the outcome names the winner by its ticket's letter");
  assert.ok(ed25519.verify(hex(won.body.result.signature), linkStakeResultMessage(PROGRAM, res), ed25519.getPublicKey(RESULT_SECRET)));
  assert.equal(linkStakeResultMessage(PROGRAM, res).length, 153);
  // The ticket key never signs a result, nor the result key a ticket.
  assert.ok(!ed25519.verify(hex(won.body.result.signature), linkStakeResultMessage(PROGRAM, res), ed25519.getPublicKey(TICKET_SECRET)));
  // The wall: nothing on the free ladder moved; the practice standing did.
  const board = (await s.r.call("GET", "/api/link/leaderboard")).body;
  for (const f of board.fighters) assert.deepEqual([f.rating, f.record.rated, f.record.unrated], [1500, { win: 0, draw: 0, loss: 0 }, { win: 0, draw: 0, loss: 0 }]);
  assert.ok(won.body.you.rating > 1500 && lost.body.you.rating < 1500);
  assert.deepEqual([won.body.you.record.win, lost.body.you.record.loss], [1, 1]);
  // Anyone may settle a finished battle, so anyone may have its signed result: the same one, with nothing else in it.
  const open = await s.r.call("GET", `/api/link/stake/result/${p.id}`);
  assert.deepEqual([open.status, open.body], [200, { result: res, signature: won.body.result.signature }]);
  assert.equal((await s.r.call("GET", `/api/link/stake/result/${"ab".repeat(32)}`)).status, 404);
  // The result stays to be settled with, whatever the fighter does next, until the chain closes the battle.
  const owed = await s.r.call("GET", "/api/link/stake/results", undefined, loser);
  assert.deepEqual([owed.body.results.length, owed.body.results[0].battle, owed.body.results[0].you, owed.body.results[0].signature], [1, p.id, "lost", won.body.result.signature]);
  // Looked at again (a poll, the sweep), it's counted once.
  await s.r.advance(120_000);
  assert.deepEqual((await s.state(winner)).body.you, won.body.you);
  // Both are free once the result is signed: the stake isn't held on a settle nobody has sent yet.
  assert.equal((await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, winner)).status, 200);
  await s.r.call("POST", "/api/link/leave", undefined, winner);
  // The practice page's list: the battle and who played, never an amount, a wallet or a signature.
  const played = await s.r.call("GET", "/api/link/stakes");
  assert.deepEqual([played.body.played.length, played.body.played[0].match, played.body.played[0].outcome], [1, match, res.outcome]);
  for (const secret of [TIER, WALLET, OTHER, won.body.result.signature, p.a.signature, p.id]) assert.ok(!played.text.includes(secret), secret);
  assert.equal((await s.r.call("GET", `/api/link/match/${match}`)).body.staked, true);
  // Settled on-chain: off the books, and the next stake is a new one.
  s.chain.states.set(p.id, { state: "closed", how: "settled" });
  await s.r.advance(60_000);
  assert.deepEqual((await s.r.call("GET", "/api/link/stake/results", undefined, winner)).body.results, [], "settled: nothing left to send");
  assert.equal((await s.r.call("GET", `/api/link/stake/result/${p.id}`)).status, 404, "closed: nothing left to settle");
  const closed = await s.state(winner);
  assert.deepEqual([closed.body.status, closed.body.closed], ["done", "settled"]);
  const next = await s.join(winner, { wait: false });
  assert.equal(next.body.waiting, true, "queued afresh, not handed the old stake");
});

test("a draw and a void refund both; leaving a staked battle loses it", async () => {
  // Both knocked out at once: a draw.
  let s = await setup();
  let g = await s.playing();
  for (let n = 0; n < 3; n++) await g.turn(n, HIT, HIT);
  let st = await s.state(s.a);
  assert.deepEqual([st.body.status, st.body.result.result.outcome, st.body.result.you], ["over", "draw", "draw"]);
  assert.match(st.body.next, /both stakes are refunded/);
  assert.deepEqual(st.body.you.record, { win: 0, draw: 1, loss: 0 });
  // Both silent: a void, which rates nothing.
  s = await setup();
  g = await s.playing();
  await s.r.advance(3 * 60_000);
  st = await s.state(s.a);
  assert.deepEqual([st.body.status, st.body.result.result.outcome, st.body.result.you], ["over", "void", "void"]);
  assert.deepEqual([st.body.you.rating, st.body.you.record], [1500, { win: 0, draw: 0, loss: 0 }]);
  // Leaving: a forfeit, and the stake goes to the side that stayed.
  s = await setup();
  g = await s.playing();
  await s.r.call("POST", "/api/link/leave", undefined, s.a);
  const [left, stayed] = [await s.state(s.a), await s.state(s.b)];
  assert.deepEqual([left.body.result.you, stayed.body.result.you], ["lost", "won"]);
  assert.equal(stayed.body.result.result.outcome, stayed.body.role === "A" ? "a" : "b");
  // A side that stopped answering waits out its cooldown before it may stake again, as it would to join a free battle.
  s = await setup();
  g = await s.playing();
  for (let i = 0; i < 3; i++) {
    s.r.clock.advance(50_000);
    await s.r.call("GET", `/api/link/state?match=${g.match}`, undefined, s.a);
  }
  assert.equal((await s.state(s.a)).body.result.you, "won", "b went silent and forfeited");
  const cooling = await s.join(s.b, { wait: false });
  assert.deepEqual([cooling.status, /stopped answering/.test(cooling.body.error)], [429, true], cooling.text);
  assert.equal((await s.join(s.a, { wait: false })).body.waiting, true);
  // The outcome is the ending's, whichever engine side each ticket letter got.
  assert.equal(stakeOutcome({ reason: "knockout", winner: 1 }, ["x", "y"], { A: "y", B: "x" }), "a");
  assert.equal(stakeOutcome({ reason: "forfeit", winner: 0 }, ["x", "y"], { A: "y", B: "x" }), "b");
  assert.equal(stakeOutcome({ reason: "draw", winner: null }, ["x", "y"], { A: "x", B: "y" }), "draw");
  assert.equal(stakeOutcome({ reason: "void", winner: null }, ["x", "y"], { A: "x", B: "y" }), "void");
});

test("a decision the game refuses is replaced by that side's fallback in a staked battle, never a void", async () => {
  const s = await setup();
  const g = await s.playing();
  // The game refuses side 0's hit this turn (as it would an illegal action that got past the view).
  s.engine.refuse = (d) => d[0]?.kind === "move" && d[0].slot === 0;
  await g.turn(0, HIT, HIT);
  const v = (await s.r.call("GET", `/api/link/match/${g.match}`)).body;
  assert.equal(v.ended, null, "not voided");
  assert.equal(v.turn, 1);
  // Side 0's fallback (wait) played, and side 1's own hit stood: only side 0 lost a hit point.
  assert.deepEqual(v.spectator.bars, [67, 100]);
  // Side 1's refused instead: its fallback, with side 0's own decision kept.
  s.engine.refuse = (d) => d[1]?.kind === "move" && d[1].slot === 0;
  await g.turn(1, HIT, HIT);
  assert.deepEqual((await s.r.call("GET", `/api/link/match/${g.match}`)).body.spectator.bars, [67, 67]);
  // Both refused: both fallbacks.
  s.engine.refuse = (d) => d.some((x) => x?.kind === "move" && x.slot === 0);
  await g.turn(2, HIT, HIT);
  const after = (await s.r.call("GET", `/api/link/match/${g.match}`)).body;
  assert.deepEqual([after.turn, after.ended, after.spectator.bars], [3, null, [67, 67]]);
  // A turn the game refuses whatever plays is a void: both stakes refunded.
  s.engine.refuse = () => true;
  await g.turn(3, WAIT, WAIT);
  await s.flush();
  assert.equal((await s.r.call("GET", `/api/link/match/${g.match}`)).body.ended.reason, "void");
  assert.equal((await s.state(s.a)).body.result.result.outcome, "void");
});

test("in a free battle the same refusal still voids: only a stake changes the rule", async () => {
  const engine = new FakeLinkEngine();
  const tasks: (() => Promise<unknown>)[] = [];
  const r = rig(undefined, { engine, rated: true, defer: (t) => tasks.push(t) });
  const [a, b] = [await r.register(MINT), await r.register(MINT2, OTHER)];
  await r.call("POST", "/api/link/join", { fallback: "first", wait: false }, a);
  const match = (await r.call("POST", "/api/link/join", { fallback: "first", wait: false }, b)).body.match as string;
  engine.refuse = () => true;
  for (const t of [a, b]) await r.call("POST", "/api/link/move", { match, turn: 0, action: HIT }, t);
  while (tasks.length) await tasks.shift()!();
  assert.equal((await r.call("GET", `/api/link/match/${match}`)).body.ended.reason, "void");
  assert.equal(engine.resolves, 1, "no second try");
});

test("every way a stake can stall ends, and frees both fighters", async () => {
  // A ticket nobody used: expired once its time (and a margin) has passed, and the pair's weekly count comes back.
  let s = await setup({ perPairPerWeek: 1 });
  let p = await s.pair();
  await s.r.advance(6 * 60_000);
  assert.equal((await s.state(s.a)).body.status, "ticketed", "inside the margin it's still believed");
  await s.r.advance(2 * 60_000);
  assert.deepEqual([(await s.state(s.a)).body.status, (await s.state(s.a)).body.closed], ["done", "expired"]);
  assert.equal((await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a)).status, 200, "free to play");
  await s.r.call("POST", "/api/link/leave", undefined, s.a);
  p = await s.pair();
  assert.ok(p.id, "the unused pairing didn't spend the pair's one a week");
  // A opened and B never accepted: both are freed; A's cancel on-chain is its own to send.
  s.chain.states.set(p.id, { state: "open" });
  await s.r.advance(8 * 60_000);
  assert.equal((await s.state(s.b)).body.closed, "unaccepted");
  // Played once this week: the same two aren't paired again.
  const again = await Promise.all([s.join(s.a, { wait: false }), s.join(s.b, { wait: false })]);
  await s.r.advance(20_000);
  assert.equal((await s.join(s.a, { wait: false })).body.waiting, true, again.map((x) => x.text).join(" "));

  // Both staked and the rig can't start a battle: after five minutes the stake is signed void, so both are refunded.
  s = await setup();
  p = await s.pair();
  s.engine.failStart = new Error("the rig is down");
  s.chain.states.set(p.id, { state: "live" });
  assert.equal((await s.state(s.a)).body.status, "ticketed");
  await s.r.advance(4 * 60_000);
  assert.equal((await s.state(s.a)).body.status, "ticketed");
  await s.r.advance(2 * 60_000);
  const st = await s.state(s.a);
  assert.deepEqual([st.body.status, st.body.result.result.outcome], ["over", "void"]);
  assert.equal(st.body.match, undefined);
  assert.equal((await s.r.call("GET", "/api/link/stakes")).body.played.length, 0, "never played: not on the practice page");
  // Nobody sends it and the program's own refund closes it: off the books.
  s.chain.states.set(p.id, { state: "closed", how: "refunded" });
  await s.r.advance(60_000);
  assert.equal((await s.state(s.a)).body.closed, "refunded");

  // The chain not answering stalls nothing for good: the next look carries on.
  s = await setup();
  p = await s.pair();
  s.chain.status = async () => {
    throw new Error("the RPC is down");
  };
  assert.equal((await s.state(s.a)).body.status, "ticketed");
  await s.r.advance(60_000);
  s.chain.status = async () => ({ state: "live" as const });
  assert.equal((await s.state(s.a)).body.status, "playing");
});

test("the desk doesn't pair while the program is paused or holds other keys, and never one owner's two fighters", async () => {
  const s = await setup({ chain: Object.assign(new FakeChain(), { config: async () => ({ paused: true, ticketKeyId: 1, resultKeyId: 2 }) }) });
  assert.match((await s.join(s.a)).body.error, /paused/);
  const rotated = await setup({ chain: Object.assign(new FakeChain(), { config: async () => ({ paused: false, ticketKeyId: 1, resultKeyId: 3 }) }) });
  assert.match((await rotated.join(rotated.a)).body.error, /stake settings are being changed/);
  // The program holds other keys than the desk's, or not this tier: a ticket would be refused or a result never pay.
  const quiet = console.error;
  console.error = () => undefined;
  try {
    const cfg = (extra: object) => Object.assign(new FakeChain(), { config: async () => ({ paused: false, ticketKeyId: 1, resultKeyId: 2, ...extra }) });
    const key = (secret: Uint8Array) => bs58.encode(ed25519.getPublicKey(secret));
    const otherResult = await setup({ chain: cfg({ ticketKey: key(TICKET_SECRET), resultKey: key(new Uint8Array(32).fill(3)), tiers: [100_000_000n] }) });
    assert.match((await otherResult.join(otherResult.a)).body.error, /stake settings are being changed/);
    const otherTier = await setup({ chain: cfg({ ticketKey: key(TICKET_SECRET), resultKey: key(RESULT_SECRET), tiers: [10_000_000n] }) });
    assert.match((await otherTier.join(otherTier.a)).body.error, /stake settings are being changed/);
    const right = await setup({ chain: cfg({ ticketKey: key(TICKET_SECRET), resultKey: key(RESULT_SECRET), tiers: [100_000_000n, 250_000_000n] }) });
    assert.equal((await right.join(right.a, { wait: false })).body.waiting, true);
  } finally {
    console.error = quiet;
  }
  // A desk that can't read the program's config signs nothing: a ticket it can't follow would only lock two stakes.
  const blind = await setup({
    chain: Object.assign(new FakeChain(), {
      config: async () => {
        throw new Error("the RPC is down");
      },
    }),
  });
  const refused = await blind.join(blind.a);
  assert.deepEqual([refused.status, /can't read the chain/.test(refused.body.error)], [503, true], refused.text);
  // One owner's two fighters wait at the same tier and are never paired with each other.
  const one = await setup();
  const third = bs58.encode(new Uint8Array(32).fill(103));
  one.r.coins.coins.set(third, { name: "Third", ticker: "THREE", createdAt: one.r.clock.now(), holders: 1, volumeSol: 0, rugFlag: false, creatorHolds: true, creator: WALLET });
  const mine = await one.r.register(third, WALLET);
  const [x, y] = await Promise.all([one.join(one.a), one.join(mine)]);
  assert.deepEqual([x.body.waiting, y.body.waiting], [true, true], `${x.text} ${y.text}`);
  assert.ok(new LinkStakeDesk(one.r.store, one.r.clock, { programId: PROGRAM, ticketSecret: TICKET_SECRET, ticketKeyId: 1, resultSecret: RESULT_SECRET, resultKeyId: 2, tiers: [1n], chain: new FakeChain() }, one.r.relay.linkArena!, async () => undefined));
});

// ---------------------------------------------------------------- the review of 2026-11-15: each of these failed before its fix

const counts = (s: Awaited<ReturnType<typeof setup>>) => Object.values(((s.r.store.dump()["link:stake-queue"] as { pairs?: { counts: Record<string, number> } } | undefined)?.pairs?.counts ?? {}) as Record<string, number>);

test("an unused ticket gives the pair's weekly count back once, however many look at it at the same moment", async () => {
  const s = await setup({ perPairPerWeek: 3 });
  let p = await s.pair();
  s.chain.states.set(p.id, { state: "open" });
  await s.r.advance(8 * 60_000);
  assert.equal((await s.state(s.a)).body.closed, "unaccepted");
  assert.deepEqual(counts(s), [1], "a ticket that was opened stays counted");
  p = await s.pair();
  assert.deepEqual(counts(s), [2]);
  // Time passes with no sweep, then both sides and a results call all find it expired at once.
  s.r.clock.advance(8 * 60_000);
  await Promise.all([s.state(s.a), s.state(s.b), s.r.call("GET", "/api/link/stake/results", undefined, s.a)]);
  assert.deepEqual(counts(s), [1], "one pairing given back, once");
});

test("a fighter waiting in the free queue that stakes is never paired into a free battle while its stake holds it", async () => {
  const s = await setup();
  const third = bs58.encode(new Uint8Array(32).fill(103));
  const thirdWallet = bs58.encode(new Uint8Array(32).fill(33));
  s.r.coins.coins.set(third, { name: "Third", ticker: "THREE", createdAt: s.r.clock.now(), holders: 1, volumeSol: 0, rugFlag: false, creatorHolds: true, creator: thirdWallet });
  const z = await s.r.register(third, thirdWallet);
  // a queues for a free battle and leaves its place there, then stakes and is ticketed.
  assert.equal((await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a)).body.waiting, true);
  const p = await s.pair();
  assert.equal((await s.state(s.a)).body.status, "ticketed");
  // z looks for a free battle: a's place went when it staked, so z waits, and a isn't in anything but its stake.
  const zj = await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, z);
  assert.equal(zj.body.waiting, true, zj.text);
  assert.equal(await s.r.relay.linkArena!.inBattle(MINT), false);
  // So when both stake, the battle starts (nothing else has either fighter).
  s.chain.states.set(p.id, { state: "live" });
  s.r.clock.advance(11_000);
  assert.equal((await s.state(s.b)).body.status, "playing");
  // And a free battle can't claim a held fighter even if a place of its were somehow still in the queue.
  const q = s.r.store.dump()["link:queue"] as { entries: { fighter: string }[] };
  assert.ok(!q.entries.some((e) => e.fighter === MINT));
});

test("a stake's polls are paid for before the chain is read, and the chain is asked at most every few seconds", async () => {
  const s = await setup();
  await s.pair();
  const before = s.chain.asked;
  let limited = 0;
  for (let i = 0; i < 400; i++) if ((await s.join(s.a)).status === 429) limited++;
  assert.ok(limited > 200, `only ${limited} of 400 joins by a held fighter were rate limited`);
  assert.ok(s.chain.asked - before <= 2, `${s.chain.asked - before} chain reads for 400 polls in one instant`);
  // A join that fails validation is paid for too (it has already looked at the fighter's stake).
  const t = await setup();
  const g = await t.playing();
  await t.r.call("POST", "/api/link/leave", undefined, t.a);
  assert.equal((await t.state(t.a)).body.status, "over");
  const asked = t.chain.asked;
  let refused = 0;
  for (let i = 0; i < 300; i++) if ((await t.join(t.a, { stake: "5" })).status === 429) refused++;
  assert.ok(refused > 100, `only ${refused} of 300 bad joins were rate limited`);
  assert.ok(t.chain.asked - asked <= 2);
  assert.ok(g.match);
});

test("a stake gets one battle, ever: a start that died before saying so is found again, even after that battle ended", async () => {
  const s = await setup();
  const p = await s.pair();
  s.chain.states.set(p.id, { state: "live" });
  // The start makes the battle, and the write that records it ("playing") fails once: a function that died there.
  const cas = s.r.store.cas.bind(s.r.store);
  let failed = false;
  (s.r.store as { cas: unknown }).cas = async (key: string, version: number, value: { status?: string }, ...rest: unknown[]) => {
    if (!failed && key === `link:stake:${p.id}` && value?.status === "playing") {
      failed = true;
      throw new Error("the function died");
    }
    return (cas as (...a: unknown[]) => unknown)(key, version, value, ...rest);
  };
  const first = await s.state(s.a);
  assert.deepEqual([failed, first.body.status, s.engine.starts], [true, "ticketed", 1]);
  // The agents were claimed for that battle; one leaves at once, so it's over (a forfeit) before the desk looks again.
  const left = await s.r.call("POST", "/api/link/leave", undefined, s.a);
  assert.equal(left.body.from, "battle", left.text);
  s.r.clock.advance(30_000);
  const [x, y] = [await s.state(s.a), await s.state(s.b)];
  assert.equal(s.engine.starts, 1, "no second battle for the stake");
  assert.deepEqual([x.body.status, x.body.result.you, y.body.result.you], ["over", "lost", "won"], "the one battle's result is the stake's");
});

test("a rating a failed write left out is put in the next time the stake is looked at, once", async () => {
  const s = await setup();
  const g = await s.playing();
  const cas = s.r.store.cas.bind(s.r.store);
  let failed = false;
  (s.r.store as { cas: unknown }).cas = async (key: string, ...rest: unknown[]) => {
    if (!failed && key.startsWith("link:stake-standing:")) {
      failed = true;
      throw new Error("the store hiccuped");
    }
    return (cas as (...a: unknown[]) => unknown)(key, ...rest);
  };
  await s.r.call("POST", "/api/link/leave", undefined, s.a);
  await s.state(s.b);
  assert.equal(failed, true);
  await s.r.advance(5 * 60_000);
  const [x, y] = [await s.state(s.a), await s.state(s.b)];
  assert.deepEqual([x.body.you.record.loss, y.body.you.record.win], [1, 1]);
  await s.r.advance(5 * 60_000);
  assert.deepEqual([(await s.state(s.a)).body.you.record.loss, (await s.state(s.b)).body.you.record.win], [1, 1], "and only once");
  assert.ok(g.match);
});

test("refused decisions and a rig failure on the same turn: the fallbacks are still played, the battle isn't voided", async () => {
  const s = await setup();
  const g = await s.playing();
  s.engine.refuse = (d) => d.some((x) => x?.kind === "move" && x.slot === 0);
  s.engine.failOnce = new Error("the rig crashed once");
  const quiet = console.error;
  console.error = () => undefined;
  try {
    for (const t of g.tokens) await s.r.call("POST", "/api/link/move", { match: g.match, turn: 0, action: HIT }, t);
    await s.flush();
    // The crashed resolution is picked up by the sweep after two minutes; then each swap is tried in turn.
    for (let i = 0; i < 6 && (await s.r.call("GET", `/api/link/match/${g.match}`)).body.turn === 0; i++) {
      await s.r.advance(125_000);
      await s.flush();
    }
  } finally {
    console.error = quiet;
  }
  const v = (await s.r.call("GET", `/api/link/match/${g.match}`)).body;
  assert.equal(v.ended, null, JSON.stringify(v.ended));
  assert.deepEqual(v.spectator.bars, [100, 100], "both fallbacks (wait) played: nobody was hit");
  assert.ok(v.turn >= 1, "the turn was played, with both sides' fallbacks");
});

test("a stake never holds its fighters long past its ticket, whatever the chain's RPC does", async () => {
  const s = await setup();
  await s.pair();
  s.chain.down = true;
  // Inside the ticket and a few minutes past it, the hold stands: the desk may only be slow to see the stakes.
  await s.r.advance(10 * 60_000);
  assert.equal((await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a)).status, 409);
  // Three hours on with the RPC still down: both are free to play, though the desk never managed to close the stake.
  await s.r.advance(3 * 3_600_000);
  assert.equal((await s.state(s.a)).body.status, "ticketed", "the desk couldn't read the chain to close it");
  assert.equal((await s.r.call("POST", "/api/link/join", { fallback: "first", wait: false }, s.a)).status, 200);
  await s.r.call("POST", "/api/link/leave", undefined, s.a);
  // And they can stake again once the RPC is back (the old ticket closes as expired on the way).
  s.chain.down = false;
  const again = await s.join(s.a, { wait: false });
  assert.equal(again.body.waiting, true, again.text);
});

test("an opening seen on-chain that then vanishes, past its accept time, frees both at once", async () => {
  const s = await setup();
  const p = await s.pair();
  s.chain.states.set(p.id, { state: "open" });
  await s.r.advance(60_000);
  assert.equal((await s.state(s.a)).body.status, "ticketed");
  // Cancelled on-chain once the ticket ran out, and its closing event out of the desk's reach: "none".
  s.chain.states.delete(p.id);
  await s.r.advance(7 * 60_000);
  const st = await s.state(s.b);
  assert.deepEqual([st.body.status, st.body.closed], ["done", "unaccepted"]);
});

test("Highwire's and the maintainer's own fighters stake like any other", async () => {
  // Both fighters' owners are on the operator list (as the maintainer's two are): they're paired, stake and play.
  const chain = new FakeChain();
  const engine = new FakeLinkEngine();
  const tasks: (() => Promise<unknown>)[] = [];
  const stakes: LinkStakeConfig = { programId: PROGRAM, ticketSecret: TICKET_SECRET, ticketKeyId: 1, resultSecret: RESULT_SECRET, resultKeyId: 2, tiers: [100_000_000n], chain };
  const r = rig({ operatorWallets: [WALLET, OTHER] }, { engine, rated: true, defer: (t) => tasks.push(t), stakes });
  const [a, b] = [await r.register(MINT), await r.register(MINT2, OTHER)];
  const join = (token: string) => r.call("POST", "/api/link/stake/join", { stake: TIER, fallback: "first" }, token);
  const [x, y] = await Promise.all([join(a), join(b)]);
  assert.equal(x.status, 200, x.text);
  assert.ok(x.body.stake && y.body.stake && x.body.stake.battle === y.body.stake.battle, `${x.text} ${y.text}`);
  chain.states.set(x.body.stake.battle, { state: "live" });
  const st = await r.call("GET", "/api/link/stake/state", undefined, a);
  assert.equal(st.body.status, "playing", st.text);
  // They're the maintainer's own on the free ladder all the same: listed as such, never ranked.
  const board = (await r.call("GET", "/api/link/leaderboard")).body;
  assert.deepEqual([board.ranked.length, board.fighters.every((f: { operator: boolean }) => f.operator)], [0, true]);
});
