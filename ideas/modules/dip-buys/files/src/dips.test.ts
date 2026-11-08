// The dip-buys module's plan, with made-up facts: no network, no wallet.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Order } from "highwire-agent";
import { lastFill, planDips, type DipFacts, type DipRules } from "./dips.ts";

const RULES: DipRules = { buy_sol: 0.1, drop_pct: 15, keep_sol: 0.1, cooldown_hours: 12, reset_rise_pct: 25, expires_days: 30, slippage_bps: 500 };
const NOW = new Date("2026-11-08T12:00:00Z");
const MINT = "So11111111111111111111111111111111111111112";
const facts = (f: Partial<DipFacts>): DipFacts => ({ rules: RULES, open: [], now: NOW, ...f });

function order(o: Partial<Order>): Order {
  return {
    id: "0000000a",
    kind: "limit_buy",
    cluster: "mainnet",
    wallet: "7bK1LThaA8xMKpmJt3wosCRcYvVA2R8V2PzoiAdqfu4B",
    mint: MINT,
    status: "open",
    createdAt: "2026-11-07T00:00:00Z",
    maxSlippageBps: 500,
    sol: 0.1,
    triggerPriceSol: 8.5e-8,
    runsDone: 0,
    failures: 0,
    history: [],
    ...o,
  };
}

test("with SOL to spare and nothing open, it sets a buy", () => {
  assert.equal(planDips(facts({ balanceSol: 0.62 })).do, "place");
});

test("it never spends into the SOL it keeps", () => {
  const step = planDips(facts({ balanceSol: 0.2 }));
  assert.equal(step.do, "wait");
  assert.match(step.reason, /less than the 0.1 SOL it keeps/);
  assert.equal(planDips(facts({ balanceSol: 0.21 })).do, "place");
});

test("an unread balance sets nothing", () => {
  assert.equal(planDips(facts({})).do, "wait");
});

test("after a fill it waits out the cooldown, then sets the next buy", () => {
  const recent = planDips(facts({ balanceSol: 0.6, lastFillAt: "2026-11-08T06:00:00Z" }));
  assert.equal(recent.do, "wait");
  assert.match(recent.reason, /after 2026-11-08T18:00:00.000Z/);
  assert.equal(planDips(facts({ balanceSol: 0.6, lastFillAt: "2026-11-07T23:00:00Z" })).do, "place");
});

test("an open buy waits while the price stays under the reset line", () => {
  // Set 15% under 1e-7: trigger 8.5e-8. 25% over 1e-7 is 1.25e-7.
  const open = [order({ triggerPriceSol: 8.5e-8 })];
  assert.equal(planDips(facts({ open, priceSol: 1.2e-7 })).do, "wait");
  assert.equal(planDips(facts({ open, priceSol: 9e-8 })).do, "wait");
});

test("an open buy moves up once the price rises past the reset line", () => {
  const step = planDips(facts({ open: [order({ id: "0000000b", triggerPriceSol: 8.5e-8 })], priceSol: 1.3e-7 }));
  assert.deepEqual(step.do, "reset");
  assert.equal(step.do === "reset" && step.cancel, "0000000b");
});

test("an unread price changes nothing, and two open buys are left alone", () => {
  assert.equal(planDips(facts({ open: [order({})], priceSol: null })).do, "wait");
  assert.equal(planDips(facts({ open: [order({ id: "0000000a" }), order({ id: "0000000b" })], priceSol: 5e-7, balanceSol: 5 })).do, "wait");
});

test("fills and failures start the cooldown; cancelled and expired buys don't", () => {
  const orders = [
    order({ status: "done", closedAt: "2026-11-08T01:00:00Z" }),
    order({ status: "failed", closedAt: "2026-11-08T03:00:00Z" }),
    order({ status: "cancelled", closedAt: "2026-11-08T05:00:00Z" }),
    order({ status: "expired", closedAt: "2026-11-08T07:00:00Z" }),
    order({ kind: "fee_claim", status: "done", closedAt: "2026-11-08T09:00:00Z" }),
  ];
  assert.equal(lastFill(orders, MINT), "2026-11-08T03:00:00Z");
  assert.equal(lastFill([], MINT), undefined);
});
