import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoinDetail } from "../src/higher/api.ts";
import { evaluateRisk } from "../src/risk.ts";

const coin = (over: Partial<CoinDetail> = {}): CoinDetail => ({
  mint: "M",
  name: "n",
  ticker: "T",
  imageUri: null,
  creator: "C",
  status: "curve",
  createdAt: "",
  lastPrice: null,
  marketCap: null,
  volume24h: null,
  raised: null,
  target: null,
  replyCount: 0,
  lastTradeAt: null,
  trustGrade: "A",
  description: null,
  website: null,
  x: null,
  telegram: null,
  metadataUri: null,
  poolId: null,
  creatorHoldingBps: 0,
  top10HoldingBps: 1500,
  tickerFlagged: false,
  indexedSlot: null,
  safety: { score: 90, grade: "A", bundleHeldBps: 0, reasons: [] },
  feeMode: "classic",
  ...over,
});

const revoked = { mint: "M", tokenProgram: "Tok", mintAuthority: null, freezeAuthority: null, supply: "1", decimals: 6 };

test("a clean coin passes", () => {
  assert.equal(evaluateRisk(coin(), revoked).verdict, "CLEAN_ON_CHECKS");
});

test("an active mint authority is high risk", () => {
  const r = evaluateRisk(coin(), { ...revoked, mintAuthority: "Auth" });
  assert.equal(r.verdict, "HIGH_RISK");
  assert.match(r.flags[0]!.reason, /mint authority/);
});

test("concentration thresholds follow the rug-check skill (30% caution, 60% danger)", () => {
  assert.equal(evaluateRisk(coin({ top10HoldingBps: 3500 }), revoked).verdict, "CAUTION");
  assert.equal(evaluateRisk(coin({ top10HoldingBps: 6500 }), revoked).verdict, "HIGH_RISK");
});

test("grade D is high risk and grade C is caution", () => {
  assert.equal(evaluateRisk(coin({ safety: { score: 30, grade: "D" } }), revoked).verdict, "HIGH_RISK");
  assert.equal(evaluateRisk(coin({ safety: { score: 60, grade: "C" } }), revoked).verdict, "CAUTION");
});

test("three cautions add up to high risk", () => {
  const r = evaluateRisk(coin({ top10HoldingBps: 3500, creatorHoldingBps: 1200, tickerFlagged: true }), revoked);
  assert.equal(r.flags.length, 3);
  assert.equal(r.verdict, "HIGH_RISK");
});

test("an RPC failure doesn't block the check", () => {
  assert.equal(evaluateRisk(coin(), { error: "timeout" }).verdict, "CLEAN_ON_CHECKS");
});
