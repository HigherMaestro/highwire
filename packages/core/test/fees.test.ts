import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { replayFetch, type Recording } from "./replay.ts";
import { runScenario } from "./run-scenario.ts";
import type { ecosystemFees } from "../src/tx/fees.ts";
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

// Holder airdrops: the recording predates them, so a coin's record gains an airdrop wallet here, and the wallet's
// balance is answered directly. What holders got comes out of higher.fun's lines, or the creator's when they gave them.
const AIRDROP_WALLET = "Eo8NZ9MTgZbJnfKrpoKUn3eopZDSWFbeq6df4m6oYtPo";
const coinRecording: Recording = JSON.parse(readFileSync(new URL("./fixtures/fees-coin.json", import.meta.url), "utf8"));

function withAirdrops(airdrops: { creatorAdds: boolean; airdroppedLamports: string }, balanceLamports: number): typeof globalThis.fetch {
  const key = `get:https://api.higher.fun/coins/${NEW_SCHOOL_GRADUATED.toBase58()}`;
  const coin = { ...(coinRecording[key]![0] as object), airdrops: { wallet: AIRDROP_WALLET, ...airdrops } };
  const replay = replayFetch(coinRecording, { [key]: coin });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (body?.method === "getMultipleAccounts" && JSON.stringify(body.params?.[0]) === JSON.stringify([AIRDROP_WALLET])) {
      const account = { data: ["", "base64"], executable: false, lamports: balanceLamports, owner: "11111111111111111111111111111111", rentEpoch: 0, space: 0 };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value: [account] } }), { headers: { "content-type": "application/json" } });
    }
    return replay(input, init);
  }) as typeof globalThis.fetch;
}

test("fees: holder airdrops come out of higher.fun's fee: what was paid out, plus what waits above the wallet's floor", async () => {
  const before = (await runScenario("fees-coin", replayFetch(coinRecording))) as { fees: Awaited<ReturnType<typeof ecosystemFees>> };
  const base = before.fees.coins[0]!;
  assert.equal(base.holders, null);
  // 0.05 SOL paid out, and 0.03 SOL waiting above higher.fun's 0.002 SOL floor.
  const r = (await runScenario("fees-coin", withAirdrops({ creatorAdds: false, airdroppedLamports: "50000000" }, 32_000_000))) as { fees: typeof before.fees };
  const c = r.fees.coins[0]!;
  assert.deepEqual(c.holders, { wallet: AIRDROP_WALLET, creatorAdds: false, paidSol: 0.05, waitingSol: 0.03 });
  close(c.byRecipient.holders, 0.08, "holders");
  close(c.byRecipient["higher.fun"], base.byRecipient["higher.fun"] - 0.08, "higher.fun keeps the rest");
  close(c.byRecipient.creator, base.byRecipient.creator, "the creator's share is untouched");
  close(c.totalFeesSol, base.totalFeesSol, "no new fee, only who got it");
  close(Object.values(c.byRecipient).reduce((n, v) => n + v, 0), c.totalFeesSol, "recipients add up");
  const platform = c.lines.find((l) => l.label.startsWith("higher.fun's platform fee"))!;
  assert.equal(platform.label, "higher.fun's platform fee, less holder airdrops");
  assert.equal(platform.ratePct, 0.25);
  const held = c.lines.find((l) => l.to === "holders")!;
  assert.deepEqual([held.phase, held.ratePct, held.basis], ["curve", 0.25, "measured"]);
  close(r.fees.waiting.holdersSol, 0.03, "waiting");
  close(r.fees.totals.byRecipient.holders, 0.08, "totals");
});

test("fees: a creator who gave their fees to holders: their lines go to holders, and higher.fun's part is what's left", async () => {
  const base = ((await runScenario("fees-coin", replayFetch(coinRecording))) as { fees: Awaited<ReturnType<typeof ecosystemFees>> }).fees.coins[0]!;
  const creatorTotal = base.byRecipient.creator;
  // The wallet holds the creator's floor (0.008 SOL) and nothing has been paid out: holders got the creator's fees only.
  const r = (await runScenario("fees-coin", withAirdrops({ creatorAdds: true, airdroppedLamports: "0" }, 8_000_000))) as { fees: { coins: typeof base[] } };
  const c = r.fees.coins[0]!;
  assert.equal(c.byRecipient.creator, 0);
  close(c.byRecipient.holders, creatorTotal, "the creator's fees are the holders'");
  close(c.byRecipient["higher.fun"], base.byRecipient["higher.fun"], "nothing beyond the creator's fees, so higher.fun's lines stand");
  assert.ok(c.lines.filter((l) => l.to === "holders").every((l) => l.label.endsWith(", given to holders")));
  close(c.totalFeesSol, base.totalFeesSol, "no new fee");
});
