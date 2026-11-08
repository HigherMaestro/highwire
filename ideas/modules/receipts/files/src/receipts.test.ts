import { test } from "node:test";
import assert from "node:assert/strict";
import type { Order, OrderRun } from "highwire-agent";
import { receiptsFor, sol } from "./receipts.ts";

// The receipts module, with made-up order histories in the shapes Highwire's order runner records.

const COIN = { mint: "So11111111111111111111111111111111111111112", ticker: "CAT" };
const T1 = "2026-11-08T10:00:00.000Z";
const T2 = "2026-11-09T10:00:00.000Z";
const claim = (at: string, outcome: OrderRun["outcome"], reason: string): OrderRun => ({ at, outcome, reason, step: "claim" });
const buy = (at: string, outcome: OrderRun["outcome"], reason: string): OrderRun => ({ at, outcome, reason, step: "buyback" });

function order(o: Partial<Order>): Order {
  return {
    id: "0000000a",
    kind: "fee_claim",
    cluster: "mainnet",
    wallet: "7bK1LThaA8xMKpmJt3wosCRcYvVA2R8V2PzoiAdqfu4B",
    mint: COIN.mint,
    status: "open",
    createdAt: "2026-11-07T00:00:00Z",
    maxSlippageBps: 500,
    runsDone: 0,
    failures: 0,
    history: [],
    ...o,
  };
}
const claims = (history: OrderRun[]) => receiptsFor([order({ history })], COIN);

test("a claim and buyback sent make one receipt", () => {
  assert.deepEqual(claims([claim(T1, "sent", "claimed about 1.2324 SOL"), buy(T1, "sent", "bought back with 0.6162 SOL")]), [
    { at: T1, text: "I claimed 1.232 SOL of my $CAT creator fees and spent 0.616 SOL buying $CAT back." },
  ]);
});

test("a skipped or refused buyback says so", () => {
  const r = claims([
    claim(T1, "sent", "claimed about 0.012 SOL"),
    buy(T1, "skipped", "0.006 SOL is too little to buy back"),
    claim(T2, "sent", "claimed about 0.8 SOL"),
    buy(T2, "refused", "The policy refused this."),
  ]);
  assert.equal(r[0]!.text, "I claimed 0.012 SOL of my $CAT creator fees, too little to buy back this time.");
  assert.match(r[1]!.text, /^I claimed 0\.8 SOL of my \$CAT creator fees\. My buyback didn't go through/);
});

test("a claim with no buyback coin doesn't name one", () => {
  const r = receiptsFor([order({ mint: undefined, history: [claim(T1, "sent", "claimed about 0.5 SOL")] })], COIN);
  assert.deepEqual(r.map((x) => x.text), ["I claimed 0.5 SOL of my creator fees."]);
});

test("skipped claims, dry runs and unreadable reasons make nothing", () => {
  assert.deepEqual(claims([claim(T1, "skipped", "nothing to claim")]), []);
  assert.deepEqual(claims([claim(T1, "dry_run", "would claim about 1 SOL"), buy(T1, "dry_run", "bought back with 0.5 SOL")]), []);
  assert.deepEqual(claims([claim(T1, "sent", "claimed some SOL")]), []);
  assert.deepEqual(claims([claim(T1, "sent", "claimed about 1 SOL"), buy(T1, "sent", "bought back")]), []);
});

test("dry runs show when asked, for the loop's preview", () => {
  const r = receiptsFor([order({ history: [claim(T1, "dry_run", "would claim about 1.2 SOL"), buy(T1, "dry_run", "bought back with 0.6 SOL")] })], COIN, undefined, { dryRuns: true });
  assert.deepEqual(r.map((x) => x.text), ["I claimed 1.2 SOL of my $CAT creator fees and spent 0.6 SOL buying $CAT back."]);
});

test("filled limit buys and recurring buys of the coin get receipts; other coins' don't", () => {
  const orders = [
    order({ id: "0000000b", kind: "limit_buy", sol: 0.1, status: "done", history: [{ at: T2, outcome: "sent", signatures: ["s"] }] }),
    order({ id: "0000000c", kind: "limit_buy", sol: 0.1, history: [{ at: T1, outcome: "refused", reason: "over the cap" }] }),
    order({ id: "0000000d", kind: "recurring_buy", sol: 0.05, everyHours: 24, history: [{ at: T1, outcome: "sent", signatures: ["t"] }] }),
    order({ id: "0000000e", kind: "limit_buy", sol: 1, mint: "7bK1LThaA8xMKpmJt3wosCRcYvVA2R8V2PzoiAdqfu4B", history: [{ at: T1, outcome: "sent" }] }),
  ];
  assert.deepEqual(receiptsFor(orders, COIN), [
    { at: T1, text: "I bought $CAT with 0.05 SOL, as I do every 24 hours." },
    { at: T2, text: "$CAT fell to the price I'd set, so I bought it with 0.1 SOL." },
  ]);
});

test("runs at or before the last posted one are never posted again", () => {
  const history = [claim(T1, "sent", "claimed about 1 SOL"), claim(T2, "sent", "claimed about 0.2 SOL")];
  assert.deepEqual(receiptsFor([order({ history })], COIN, T1).map((r) => r.at), [T2]);
  assert.deepEqual(receiptsFor([order({ history })], COIN, T2), []);
});

test("amounts read plainly", () => {
  assert.equal(sol(1.2324), "1.232");
  assert.equal(sol(0.5), "0.5");
  assert.equal(sol(0.0041), "0.0041");
});
