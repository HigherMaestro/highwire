import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HigherError, type Quote } from "highwire-core";
import { holdProcessLock, lockHolder } from "../src/lock.ts";
import { OrderBook, type NewOrder, type Order } from "../src/orders.ts";
import { PolicySchema } from "../src/policy.ts";
import { OrderRunner, MAX_ORDER_FAILURES, MIN_BUYBACK_LAMPORTS, type OrderMarket } from "../src/runner.ts";
import { describeOrder } from "../src/orders.ts";
import type { ExecuteResult } from "../src/signer.ts";

const WALLET = "H4dxJQN6DRqCPva9yaX2Nt3mAkvgo7pyQZr93fLke1U5";
const MINT = "7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh";
const OTHER = "ALBA7iVjFkQzxPQQCovkK7zQiaXUPmixt2dZxNstXiPp";

function tmpBook(now: () => Date = () => new Date()) {
  const dir = mkdtempSync(join(tmpdir(), "hw-orders-"));
  return new OrderBook(join(dir, "orders.json"), now);
}

const stop = (o: Partial<NewOrder> = {}): NewOrder => ({ kind: "stop_loss", cluster: "mainnet", wallet: WALLET, mint: MINT, maxSlippageBps: 300, triggerPriceSol: 0.00001, sellPct: 50, ...o });
const claimer = (o: Partial<NewOrder> = {}): NewOrder => ({ kind: "fee_claim", cluster: "mainnet", wallet: WALLET, mint: MINT, maxSlippageBps: 300, everyHours: 6, minClaimSol: 0.001, buybackPct: 50, nextRunAt: "2026-11-06T12:00:00.000Z", expiresAt: "2026-12-06T12:00:00.000Z", ...o });
const dca = (o: Partial<NewOrder> = {}): NewOrder => ({ kind: "recurring_buy", cluster: "mainnet", wallet: WALLET, mint: MINT, maxSlippageBps: 300, sol: 0.01, everyHours: 24, times: 2, nextRunAt: "2026-11-06T12:00:00.000Z", ...o });

/** A market the test drives: a spot price, a balance, and what each trade returns. */
function fakeMarket() {
  const m = {
    price: 0.00002,
    balance: 2_000_000_000n, // 2,000 tokens
    quotes: 0,
    trades: [] as { order: string; side: string; amountIn: bigint }[],
    claims: [] as { order: string; minLamports: bigint }[],
    /** What the wallet has to claim, in lamports, and what a claim returns. */
    claimable: 100_000_000n,
    claimNext: (): ExecuteResult | Error => ({ status: "sent", wallet: WALLET, cluster: "mainnet", transactions: [{ index: 0, label: "Claim", signature: `claim${m.claims.length - 1}`, confirmed: true }], summary: [], spentSol: 0, dayLeftSol: 1 }),
    next: (): ExecuteResult | Error => ({ status: "sent", wallet: WALLET, cluster: "mainnet", transactions: [{ index: 0, label: "Trade", signature: `sig${m.trades.length - 1}`, confirmed: true }], summary: [], spentSol: 0, dayLeftSol: 1 }),
    market: null as unknown as OrderMarket,
  };
  m.market = {
    balance: async () => m.balance,
    quote: async (_mint, side, amountIn) => {
      m.quotes++;
      const out = side === "sell" ? BigInt(Math.round((Number(amountIn) / 1e6) * m.price * 1e9)) : 0n;
      return { spotPriceSol: m.price, amountOut: out, minOut: (out * 97n) / 100n } as unknown as Quote;
    },
    trade: async ({ order, side, amountIn }) => {
      m.trades.push({ order: order.id, side, amountIn });
      const r = m.next();
      if (r instanceof Error) throw r;
      return r;
    },
    claim: async ({ order, minLamports }) => {
      if (m.claimable === 0n || m.claimable < minLamports) return { result: null, lamports: m.claimable };
      m.claims.push({ order: order.id, minLamports });
      const r = m.claimNext();
      if (r instanceof Error) throw r;
      return { result: r, lamports: m.claimable };
    },
  };
  return m;
}

function clock(start = "2026-11-06T12:00:00.000Z") {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

function runner(book: OrderBook, m: ReturnType<typeof fakeMarket>, c: ReturnType<typeof clock>, extra: Partial<ConstructorParameters<typeof OrderRunner>[0]> = {}) {
  return new OrderRunner({ book, wallet: WALLET, cluster: "mainnet", market: m.market, now: c.now, pollMs: 60_000, hintMs: 10_000, ...extra });
}

test("the policy's orders section is optional and strict", () => {
  const base = { version: 1, cluster: "devnet", actions: ["trade"], max_sol_per_tx: 0.1, max_sol_per_day: 0.5, max_slippage_bps: 300 };
  assert.equal(PolicySchema.parse(base).orders, undefined);
  assert.deepEqual(PolicySchema.parse({ ...base, orders: { kinds: ["stop_loss"] } }).orders, { kinds: ["stop_loss"], max_open: 10 });
  assert.equal(PolicySchema.safeParse({ ...base, orders: { kinds: ["stop_loss"], anything: true } }).success, false);
  assert.equal(PolicySchema.safeParse({ ...base, orders: { kinds: ["market_maker"] } }).success, false);
  assert.equal(PolicySchema.safeParse({ ...base, orders: { kinds: [] } }).success, false);
});

test("the book places, lists and cancels orders, within max_open, in a private file", async () => {
  const book = tmpBook();
  const a = await book.place(stop(), 2);
  const b = await book.place(dca(), 2);
  assert.match(a.id, /^[0-9a-f]{8}$/);
  assert.deepEqual(book.list().map((o) => o.id), [b.id, a.id]);
  await assert.rejects(book.place(stop(), 2), (err: HigherError) => err.code === "policy_refused");
  // Another wallet's orders don't count against this one's.
  await book.place(stop({ wallet: OTHER }), 2);
  const c = await book.cancel(a.id);
  assert.equal(c.status, "cancelled");
  await assert.rejects(book.cancel(a.id), (err: HigherError) => err.code === "order_closed");
  await assert.rejects(book.cancel("00000000"), (err: HigherError) => err.code === "not_found");
  assert.equal(statSync(book.path).mode & 0o777, 0o600);
});

test("a damaged orders file is an error, never overwritten", async () => {
  const book = tmpBook();
  writeFileSync(book.path, "{not json");
  assert.throws(() => book.list(), (err: HigherError) => err.code === "orders_invalid");
  await assert.rejects(book.place(stop(), 5), (err: HigherError) => err.code === "orders_invalid");
  assert.equal(readFileSync(book.path, "utf8"), "{not json");
});

test("a stop-loss waits above its trigger, then sells its share once the on-chain price falls to it", async () => {
  const c = clock();
  const book = tmpBook(c.now);
  const m = fakeMarket();
  const o = await book.place(stop(), 5);
  const r = runner(book, m, c);
  await r.tick();
  assert.equal(m.trades.length, 0);
  m.price = 0.00001;
  await r.tick();
  assert.equal(m.trades.length, 0, "checked at most once a minute without a hint");
  c.advance(60_000);
  await r.tick();
  assert.deepEqual(m.trades, [{ order: o.id, side: "sell", amountIn: 1_000_000_000n }], "50% of 2,000 tokens");
  const after = book.get(o.id)!;
  assert.equal(after.status, "done");
  assert.equal(after.closeReason, "filled");
  assert.deepEqual(after.history.map((h) => [h.outcome, h.signatures, h.priceSol]), [["sent", ["sig0"], 0.00001]]);
  assert.equal(after.fillingSince, undefined);
  c.advance(60_000);
  await r.tick();
  assert.equal(m.trades.length, 1, "a filled order never fills again");
});

test("a trade on the coin brings the next check forward, but not under hintMs", async () => {
  const c = clock();
  const book = tmpBook(c.now);
  const m = fakeMarket();
  await book.place(stop(), 5);
  const r = runner(book, m, c);
  await r.tick();
  assert.equal(m.quotes, 1);
  r.hint(MINT);
  c.advance(5_000);
  await r.tick();
  assert.equal(m.quotes, 1);
  c.advance(5_000);
  await r.tick();
  assert.equal(m.quotes, 2);
  assert.deepEqual(r.watchedMints(), [MINT]);
});

test("a take-profit on a dry-run policy triggers once and says nothing was sent", async () => {
  const c = clock();
  const book = tmpBook(c.now);
  const m = fakeMarket();
  m.next = () => ({ status: "dry_run", wallet: WALLET, cluster: "mainnet", transactions: [], summary: [], spentSol: 0, dayLeftSol: 1 });
  const o = await book.place(stop({ kind: "take_profit", triggerPriceSol: 0.00003, sellPct: 100 }), 5);
  const r = runner(book, m, c);
  await r.tick();
  assert.equal(m.trades.length, 0);
  m.price = 0.00004;
  c.advance(60_000);
  await r.tick();
  assert.equal(m.trades[0]!.amountIn, 2_000_000_000n);
  const after = book.get(o.id)!;
  assert.equal(after.status, "done");
  assert.match(after.closeReason!, /dry run/);
  assert.equal(after.history[0]!.outcome, "dry_run");
});

test("a stop-limit under its SOL floor waits, and says so once; no balance waits too", async () => {
  const c = clock();
  const book = tmpBook(c.now);
  const m = fakeMarket();
  m.price = 0.000001;
  // 1,000 tokens at 0.000001 is 0.001 SOL, under 0.5.
  const o = await book.place(stop({ minSolOut: 0.5 }), 5);
  const r = runner(book, m, c);
  await r.tick();
  c.advance(60_000);
  await r.tick();
  assert.equal(m.trades.length, 0);
  let after = book.get(o.id)!;
  assert.equal(after.status, "open");
  assert.equal(after.history.length, 1);
  assert.match(after.history[0]!.reason!, /under its 0.5 SOL floor/);

  m.balance = 0n;
  const empty = await book.place(stop(), 5);
  c.advance(60_000);
  await r.tick();
  after = book.get(empty.id)!;
  assert.equal(after.status, "open");
  assert.match(after.history[0]!.reason!, /holds none/);
});

test("recurring buys run on schedule, skip a refused run, and finish after their count", async () => {
  const c = clock();
  const book = tmpBook(c.now);
  const m = fakeMarket();
  const o = await book.place(dca({ times: 2 }), 5);
  const r = runner(book, m, c);
  await r.tick();
  assert.deepEqual(m.trades.map((t) => [t.side, t.amountIn]), [["buy", 10_000_000n]]);
  let after = book.get(o.id)!;
  assert.equal(after.runsDone, 1);
  assert.equal(after.nextRunAt, "2026-11-07T12:00:00.000Z");
  c.advance(3_600_000);
  await r.tick();
  assert.equal(m.trades.length, 1, "not due for another 23 hours");

  m.next = () => new HigherError("The policy refused this: it would take the last 24 hours past the policy's 0.5 SOL.", { code: "policy_refused" });
  c.advance(23 * 3_600_000);
  await r.tick();
  after = book.get(o.id)!;
  assert.equal(after.status, "open");
  assert.equal(after.runsDone, 1, "a refused run doesn't count");
  assert.equal(after.history.at(-1)!.outcome, "refused");
  assert.equal(after.nextRunAt, "2026-11-08T12:00:00.000Z");

  m.next = fakeMarket().next;
  c.advance(24 * 3_600_000);
  await r.tick();
  after = book.get(o.id)!;
  assert.equal(after.status, "done");
  assert.equal(after.runsDone, 2);
});

test("failures that may pass are retried, then the order is given up", async () => {
  const c = clock();
  const book = tmpBook(c.now);
  const m = fakeMarket();
  m.next = () => new HigherError("Transaction 1 (Trade) failed simulation", { code: "simulation_failed" });
  const o = await book.place(dca(), 5);
  const r = runner(book, m, c);
  for (let i = 0; i < MAX_ORDER_FAILURES; i++) {
    await r.tick();
    c.advance(10 * 60_000);
  }
  assert.equal(m.trades.length, MAX_ORDER_FAILURES);
  const after = book.get(o.id)!;
  assert.equal(after.status, "failed");
  assert.match(after.closeReason!, /5 times in a row/);
});

test("an unknown send closes the order instead of risking a second fill", async () => {
  const c = clock();
  const book = tmpBook(c.now);
  const m = fakeMarket();
  m.next = () => new HigherError("the RPC didn't accept it", { code: "send_failed" });
  const o = await book.place(dca(), 5);
  await runner(book, m, c).tick();
  assert.equal(book.get(o.id)!.status, "failed");
});

test("an order a stopped runner left mid-fill is closed, not filled again", async () => {
  const c = clock();
  const book = tmpBook(c.now);
  const m = fakeMarket();
  const o = await book.place(dca(), 5);
  await book.update(o.id, (x: Order) => (x.fillingSince = "2026-11-06T11:59:00.000Z"));
  await runner(book, m, c).tick();
  assert.equal(m.trades.length, 0);
  const after = book.get(o.id)!;
  assert.equal(after.status, "failed");
  assert.match(after.closeReason!, /may have been sent/);
});

test("orders expire, other wallets' orders are left alone, and the kill switch pauses everything", async () => {
  const c = clock();
  const book = tmpBook(c.now);
  const m = fakeMarket();
  m.price = 0.000001;
  const expiring = await book.place(stop({ expiresAt: "2026-11-06T12:00:00.000Z" }), 5);
  const theirs = await book.place(dca({ wallet: OTHER }), 5);
  const devnet = await book.place(dca({ cluster: "devnet" }), 5);
  const mine = await book.place(dca(), 5);
  let off = true;
  const r = runner(book, m, c, { stopped: () => off });
  await r.tick();
  assert.equal(m.trades.length, 0, "stopped");
  off = false;
  await r.tick();
  assert.equal(book.get(expiring.id)!.status, "expired");
  assert.equal(book.get(theirs.id)!.history.length, 0);
  assert.equal(book.get(devnet.id)!.history.length, 0);
  assert.deepEqual(m.trades.map((t) => t.order), [mine.id]);
});

test("a fill that lands after a cancel is still recorded", async () => {
  const c = clock();
  const book = tmpBook(c.now);
  const m = fakeMarket();
  const o = await book.place(dca({ times: 5 }), 5);
  m.market.trade = async () => {
    await book.cancel(o.id);
    return { status: "sent", wallet: WALLET, cluster: "mainnet", transactions: [{ index: 0, label: "Trade", signature: "late", confirmed: true }], summary: [], spentSol: 0.01, dayLeftSol: 1 };
  };
  await runner(book, m, c).tick();
  const after = book.get(o.id)!;
  assert.equal(after.status, "cancelled");
  assert.deepEqual(after.history[0]!.signatures, ["late"]);
});

test("only one runner holds the lock", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hw-lock-")), "orders-runner.lock");
  const release = holdProcessLock(path, "highwire orders run");
  assert.equal(lockHolder(path), process.pid);
  assert.throws(() => holdProcessLock(path, "highwire orders run"), (err: HigherError) => err.code === "already_running");
  release();
  assert.equal(lockHolder(path), null);
  // A lock left by a process that's gone is taken over.
  writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 12345, at: 0 }));
  holdProcessLock(path, "highwire orders run")();
});

test("descriptions say what an order does, with prices in plain decimals", async () => {
  const { describeOrder } = await import("../src/orders.ts");
  assert.equal(describeOrder(stop({ triggerPriceSol: 2.78698e-8 })), `Sell 50% of ${MINT} if its price falls to 0.0000000278698 SOL or below`);
  assert.equal(describeOrder(stop({ kind: "take_profit", triggerPriceSol: 0.00003, minSolOut: 1 })), `Sell 50% of ${MINT} if its price rises to 0.00003 SOL or above, for at least 1 SOL`);
  assert.equal(describeOrder(dca()), `Buy 0.01 SOL of ${MINT} every 24 hours, 2 times`);
  assert.equal(describeOrder(dca({ everyHours: 1, times: 1 })), `Buy 0.01 SOL of ${MINT} every hour, once`);
});

test("a fee claim claims on schedule, then buys back its share of what came in", async () => {
  const c = clock();
  const book = tmpBook(c.now);
  const m = fakeMarket();
  const o = await book.place(claimer(), 5);
  const r = runner(book, m, c);
  await r.tick();
  assert.deepEqual(m.claims, [{ order: o.id, minLamports: 1_000_000n }]);
  // Half of the 0.1 SOL claimed.
  assert.deepEqual(m.trades, [{ order: o.id, side: "buy", amountIn: 50_000_000n }]);
  let after = book.get(o.id)!;
  assert.equal(after.status, "open");
  assert.equal(after.runsDone, 1);
  assert.deepEqual(after.history.map((h) => [h.step, h.outcome]), [["claim", "sent"], ["buyback", "sent"]]);
  // Idea templates read these amounts from the history (ideas/*/PRD.md): keep the wording.
  assert.equal(after.history[0]!.reason, "claimed about 0.1 SOL");
  assert.equal(after.history[1]!.reason, "bought back with 0.05 SOL");
  assert.equal(after.nextRunAt, "2026-11-06T18:00:00.000Z");
  // Not due again until six hours on.
  c.advance(3_600_000);
  await r.tick();
  assert.equal(m.claims.length, 1);
  c.advance(5 * 3_600_000);
  await r.tick();
  assert.equal(m.claims.length, 2);
  after = book.get(o.id)!;
  assert.equal(after.runsDone, 2);
});

test("a fee claim skips a dusting, notes it once, and buys back nothing too small", async () => {
  const c = clock();
  const book = tmpBook(c.now);
  const m = fakeMarket();
  m.claimable = 500_000n; // under the 0.001 SOL minimum
  const o = await book.place(claimer(), 5);
  const r = runner(book, m, c);
  await r.tick();
  c.advance(6 * 3_600_000);
  await r.tick();
  assert.equal(m.claims.length, 0);
  let after = book.get(o.id)!;
  assert.deepEqual(after.history.map((h) => [h.step, h.outcome]), [["claim", "skipped"]]);
  assert.match(after.history[0]!.reason!, /under its 0.001 SOL minimum/);
  // Enough to claim, but half of it is under the smallest buyback.
  m.claimable = MIN_BUYBACK_LAMPORTS + 1n;
  c.advance(6 * 3_600_000);
  await r.tick();
  assert.equal(m.claims.length, 1);
  assert.equal(m.trades.length, 0);
  after = book.get(o.id)!;
  assert.deepEqual(after.history.slice(-2).map((h) => [h.step, h.outcome]), [["claim", "sent"], ["buyback", "skipped"]]);
  // Without a buyback, it only claims.
  const plain = await book.place(claimer({ mint: undefined, buybackPct: undefined }), 5);
  await runner(book, m, c).tick();
  assert.equal(book.get(plain.id)!.history.at(-1)!.step, "claim");
  assert.equal(m.trades.length, 0);
});

test("a fee claim's unanswered claim is tried again next run; an unanswered buyback closes it", async () => {
  const c = clock();
  const book = tmpBook(c.now);
  const m = fakeMarket();
  m.claimNext = () => new HigherError("no answer", { code: "send_failed" });
  const o = await book.place(claimer(), 5);
  const r = runner(book, m, c);
  await r.tick();
  let after = book.get(o.id)!;
  assert.equal(after.status, "open");
  assert.equal(m.trades.length, 0);
  assert.equal(after.nextRunAt, "2026-11-06T18:00:00.000Z");

  m.claimNext = () => ({ status: "sent", wallet: WALLET, cluster: "mainnet", transactions: [{ index: 0, label: "Claim", signature: "c", confirmed: true }], summary: [], spentSol: 0, dayLeftSol: 1 });
  m.next = () => new HigherError("no answer", { code: "send_failed" });
  c.advance(6 * 3_600_000);
  await r.tick();
  after = book.get(o.id)!;
  assert.equal(after.status, "failed");
  assert.match(after.closeReason!, /buyback's send outcome is unknown/);
});

test("fee claims are a kind the policy can allow, and describe themselves", () => {
  const base = { version: 1, cluster: "mainnet", actions: ["claim", "trade"], max_sol_per_tx: 0.1, max_sol_per_day: 0.5, max_slippage_bps: 300 };
  assert.deepEqual(PolicySchema.parse({ ...base, orders: { kinds: ["fee_claim"] } }).orders?.kinds, ["fee_claim"]);
  assert.equal(
    describeOrder({ kind: "fee_claim", mint: MINT, everyHours: 6, minClaimSol: 0.001, buybackPct: 50 }),
    `Claim creator fees every 6 hours when at least 0.001 SOL is waiting, then spend 50% of what came in buying ${MINT}`,
  );
  assert.equal(describeOrder({ kind: "fee_claim", everyHours: 1 }), "Claim creator fees every hour");
});

test("a limit buy waits above its trigger, buys its SOL once the price falls to it, and fills once", async () => {
  const c = clock();
  const book = tmpBook(c.now);
  const m = fakeMarket();
  const o = await book.place({ kind: "limit_buy", cluster: "mainnet", wallet: WALLET, mint: MINT, maxSlippageBps: 300, sol: 0.05, triggerPriceSol: 0.000015 }, 5);
  assert.equal(describeOrder(o), `Buy 0.05 SOL of ${MINT} if its price falls to 0.000015 SOL or below`);
  const r = runner(book, m, c);
  assert.deepEqual(r.watchedMints(), [MINT], "the feed watches its coin for hints");
  await r.tick();
  assert.equal(m.trades.length, 0, "0.00002 is above the trigger");
  m.price = 0.000015;
  c.advance(60_000);
  await r.tick();
  assert.deepEqual(m.trades, [{ order: o.id, side: "buy", amountIn: 50_000_000n }]);
  assert.equal(book.get(o.id)!.status, "done");
  assert.deepEqual(book.get(o.id)!.history.map((h) => [h.outcome, h.priceSol]), [["sent", 0.000015]]);
  c.advance(60_000);
  await r.tick();
  assert.equal(m.trades.length, 1, "a filled limit buy never buys again");

  // A lost send closes it, like any fill; the policy refusing it leaves it waiting.
  const lost = await book.place({ kind: "limit_buy", cluster: "mainnet", wallet: WALLET, mint: MINT, maxSlippageBps: 300, sol: 0.05, triggerPriceSol: 0.00002 }, 5);
  m.next = () => new HigherError("no answer", { code: "send_failed" });
  c.advance(60_000);
  await r.tick();
  assert.equal(book.get(lost.id)!.status, "failed");
  const waits = await book.place({ kind: "limit_buy", cluster: "mainnet", wallet: WALLET, mint: MINT, maxSlippageBps: 300, sol: 0.05, triggerPriceSol: 0.00002 }, 5);
  m.next = () => new HigherError("The policy refused this: over the day's limit.", { code: "policy_refused" });
  c.advance(60_000);
  await r.tick();
  assert.equal(book.get(waits.id)!.status, "open");
  assert.equal(book.get(waits.id)!.history.at(-1)?.outcome, "refused");
});
