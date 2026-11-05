import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseToTokens,
  containsLink,
  graduationProgressPct,
  lamportsToSol,
  looksLikeImpersonation,
  summarizeHolder,
} from "../src/higher/format.js";
import { MAINNET } from "../src/higher/constants.js";

test("lamportsToSol and baseToTokens convert units", () => {
  assert.equal(lamportsToSol("85000000000"), 85);
  assert.equal(lamportsToSol("20000000"), 0.02);
  assert.equal(lamportsToSol(null), null);
  assert.equal(baseToTokens("2453456"), 2.45);
  assert.equal(baseToTokens("50000000000000", 0), 50_000_000);
});

test("graduation progress is raised over target, capped, and 100 once graduated", () => {
  assert.equal(graduationProgressPct({ status: "curve", raised: "21827985104", target: "85000000000" }), 25.7);
  assert.equal(graduationProgressPct({ status: "curve", raised: "90000000000", target: "85000000000" }), 100);
  assert.equal(graduationProgressPct({ status: "graduated", raised: "1", target: "85000000000" }), 100);
  assert.equal(graduationProgressPct({ status: "curve", raised: null, target: null }), null);
});

test("impersonation check catches Cyrillic look-alikes but not plain names", () => {
  assert.equal(looksLikeImpersonation("һіgherfun"), true);
  assert.equal(looksLikeImpersonation("higherfun"), false);
  assert.equal(looksLikeImpersonation("Привет"), false);
  assert.equal(looksLikeImpersonation(null), false);
});

test("link check catches URLs and bare domains", () => {
  assert.equal(containsLink("claim at laimyoursol.com/v76"), true);
  assert.equal(containsLink("[docs](https://higher.fun/docs)"), true);
  assert.equal(containsLink("gm, sending it"), false);
});

test("holders are labelled when they are a curve, pool or lock", () => {
  const base = { balance: "1000000", shareBps: 100, isCreator: false, isCurve: false };
  assert.equal(summarizeHolder({ ...base, wallet: "x", isCurve: true }).label, "bonding curve");
  assert.equal(summarizeHolder({ ...base, wallet: MAINNET.cpmmAuth }).label, "Raydium CPMM pool vault");
  assert.match(summarizeHolder({ ...base, wallet: MAINNET.launchLabAuth, isCurve: true }).label ?? "", /locked tokens after graduation/);
  assert.equal(summarizeHolder({ ...base, wallet: "y", isCreator: true }).label, "creator");
  assert.equal(summarizeHolder({ ...base, wallet: "z" }).label, null);
});
