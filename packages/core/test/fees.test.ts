import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { replayFetch, type Recording } from "./replay.ts";
import { runScenario } from "./run-scenario.ts";
import { CLAIM_COIN, CURVE_COIN, NEW_SCHOOL_GRADUATED } from "./scenarios.ts";

const recording: Recording = JSON.parse(readFileSync(new URL("./fixtures/fees.json", import.meta.url), "utf8"));

const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} vs ${b}`);

test("fees: the curve is measured, the pool computed at the on-chain rates, and every line adds up", async () => {
  const r = await runScenario("fees", replayFetch(recording));
  const fees = r && "fees" in r ? r.fees : undefined;
  assert.ok(fees);
  assert.equal(fees.coins.length, 3);
  assert.deepEqual(fees.rates.pool, { trade: 0.25, raydiumShareOfTrade: 16, creator: 0.05, raydiumShareOfCreator: 5 });
  assert.deepEqual(fees.rates.curve.rewards, { raydium: 0.25, platform: 0.5, creator: 0.25 });

  for (const c of fees.coins) {
    close(c.lines.reduce((n, l) => n + l.sol, 0), c.totalFeesSol, `${c.ticker} lines`);
    close(Object.values(c.byRecipient).reduce((n, v) => n + v, 0), c.totalFeesSol, `${c.ticker} recipients`);
    for (const l of c.lines) assert.equal(l.basis, l.phase === "curve" ? "measured" : "computed", l.label);
  }
  close(fees.totals.feesSol, fees.coins.reduce((n, c) => n + c.totalFeesSol, 0), "totals");
  close(fees.totals.byPhase.curve + fees.totals.byPhase.pool, fees.totals.feesSol, "phases");

  // New school, graduated: higher.fun's platform fee is twice Raydium's on the curve, the creator's equal to it,
  // and higher.fun's Fee Key earns its share of the LP fees.
  const high = fees.coins.find((c) => c.mint === NEW_SCHOOL_GRADUATED.toBase58())!;
  assert.equal(high.feeMode, "rewards");
  assert.equal(high.status, "graduated");
  const curve = (label: string) => high.lines.find((l) => l.phase === "curve" && l.label.startsWith(label))!.sol;
  close(curve("higher.fun"), curve("Raydium") * 2, "platform fee");
  close(curve("Creator"), curve("Raydium"), "creator fee");
  close(high.curveVolumeSol, curve("Raydium") / 0.0025, "curve volume");
  assert.ok(high.poolVolumeSol! > 1_000);
  assert.ok(high.pool?.lockedLp && high.pool.lockedLp.sharePct > 25 && high.pool.lockedLp.sharePct < 35, JSON.stringify(high.pool));
  assert.ok(high.pool.lockedLp.harvestedSol > 0);
  const locked = high.lines.filter((l) => l.label.startsWith("Locked-LP"));
  assert.equal(locked.length, 2);
  close(locked[0]!.sol, locked[1]!.sol * 2, "higher.fun takes two thirds");

  // Old school: no curve fees but Raydium's, all LP burned, so no locked share.
  const phil = fees.coins.find((c) => c.mint === CLAIM_COIN.toBase58())!;
  assert.equal(phil.feeMode, "classic");
  assert.deepEqual(phil.lines.filter((l) => l.phase === "curve").map((l) => l.to), ["Raydium"]);
  assert.equal(phil.pool?.lockedLp, null);
  assert.equal(phil.byRecipient["higher.fun"], 0);

  // On the curve: no pool.
  const si = fees.coins.find((c) => c.mint === CURVE_COIN.toBase58())!;
  assert.equal(si.pool, null);
  assert.equal(si.poolVolumeSol, 0);
  assert.ok(si.lines.every((l) => l.phase === "curve"));
});
