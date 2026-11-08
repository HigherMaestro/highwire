import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { replayFetch, type Recording } from "./replay.ts";
import { runScenario } from "./run-scenario.ts";
import type { ecosystemFees } from "../src/tx/fees.ts";
import { CLAIM_COIN, CREATOR, CURVE_COIN, NEW_SCHOOL_GRADUATED, TRADER } from "./scenarios.ts";

const recording: Recording = JSON.parse(readFileSync(new URL("./fixtures/fees.json", import.meta.url), "utf8"));

const creatorRecording: Recording = JSON.parse(readFileSync(new URL("./fixtures/fees-creator.json", import.meta.url), "utf8"));

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

test("fees: the last 24 hours price each coin's 24-hour volume at the rates of the phase it trades in now", async () => {
  const r = await runScenario("fees", replayFetch(recording));
  const fees = r && "fees" in r ? r.fees : undefined;
  assert.ok(fees);
  for (const c of fees.coins) {
    if (!c.last24h) {
      assert.ok(c.volume24hSol == null || c.status === "migrating", `${c.ticker} has 24-hour volume but no 24-hour fees`);
      continue;
    }
    assert.equal(c.last24h.volumeSol, c.volume24hSol);
    const phase = c.status === "graduated" ? "pool" : "curve";
    const rate = c.lines.filter((l) => l.phase === phase).reduce((n, l) => n + l.ratePct, 0);
    // Line rates are rounded to six decimals in the output, so allow for it.
    const want = (c.last24h.volumeSol * rate) / 100;
    assert.ok(Math.abs(c.last24h.feesSol - want) <= Math.max(1e-6, want * 1e-5), `${c.ticker} 24h fees: ${c.last24h.feesSol} vs ${want}`);
    close(Object.values(c.last24h.byRecipient).reduce((n, v) => n + v, 0), c.last24h.feesSol, `${c.ticker} 24h recipients`);
  }
  close(fees.totals.last24h.feesSol, fees.coins.reduce((n, c) => n + (c.last24h?.feesSol ?? 0), 0), "24h totals");
  // On the curve a New school trade pays 1%; in the pool, 0.3%.
  const si = fees.coins.find((c) => c.mint === CURVE_COIN.toBase58())!;
  if (si.last24h && si.last24h.volumeSol > 0) close(si.last24h.feesSol / si.last24h.volumeSol, 0.01, "curve rate");
  const high = fees.coins.find((c) => c.mint === NEW_SCHOOL_GRADUATED.toBase58())!;
  assert.ok(high.last24h);
  close(high.last24h.feesSol / high.last24h.volumeSol, 0.003, "pool rate");
  assert.equal(high.last24h.byRecipient.holders, 0);
});

test("fees: a creator's coins, found by their wallet, with their curve vault's fees waiting", async () => {
  const r = (await runScenario("fees-creator", replayFetch(creatorRecording))) as { fees: Awaited<ReturnType<typeof ecosystemFees>> };
  const fees = r.fees;
  assert.ok(fees.coins.length >= 1);
  assert.ok(fees.coins.every((c) => c.creator === CREATOR.toBase58()));
  assert.ok(fees.coins.some((c) => c.mint === CLAIM_COIN.toBase58()));
  close(fees.totals.feesSol, fees.coins.reduce((n, c) => n + c.totalFeesSol, 0), "totals");
  assert.ok(fees.waiting.creatorCurveSol >= 0);
  assert.ok(fees.creatorPayouts && fees.creatorPayouts.paidOutSol >= 0 && fees.creatorPayouts.pendingSol >= 0);
});

test("fees: a wallet that created no coins costs one request to higher.fun, and nothing on-chain", async () => {
  const { Chain } = await import("../src/tx/chain.ts");
  const { HigherApi } = await import("../src/higher/api.ts");
  const { createHttpConfig } = await import("../src/lib/http.ts");
  const { ecosystemFees } = await import("../src/tx/fees.ts");
  const seen: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ items: [], nextCursor: null }), { headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  const chain = new Chain({ cluster: "mainnet", rpcUrl: "https://rpc.invalid", fetch });
  const api = new HigherApi(createHttpConfig({ baseUrl: "https://api.higher.fun", fetch, retries: 0 }));
  const r = await ecosystemFees(chain, api, { creator: TRADER.toBase58() });
  assert.equal(r.coins.length, 0);
  assert.deepEqual(seen, [`https://api.higher.fun/users/${TRADER.toBase58()}/coins`]);
});

test("fees over time: a coin's days add up to its lifetime fees, at curve rates until its curve volume, pool rates after", async () => {
  const { dailyFees, sumDailyFees } = await import("../src/tx/fees.ts");
  const c = ((await runScenario("fees-coin", replayFetch(coinRecording))) as { fees: Awaited<ReturnType<typeof ecosystemFees>> }).fees.coins[0]!;
  assert.equal(c.status, "graduated");
  const candles = (coinRecording[`get:https://api.higher.fun/coins/${NEW_SCHOOL_GRADUATED.toBase58()}/candles?interval=1d`]![0] as { items: { time: number; volume: string }[] }).items;
  const days = dailyFees(c, candles);
  assert.equal(days.length, candles.length);
  const sum = (f: (d: (typeof days)[number]) => number) => days.reduce((n, d) => n + f(d), 0);
  // Within the rounding of the rates to six decimals, as the 24-hour figures.
  assert.ok(Math.abs(sum((d) => d.feesSol) / c.totalFeesSol - 1) < 1e-5, `${sum((d) => d.feesSol)} vs ${c.totalFeesSol}`);
  assert.ok(Math.abs(sum((d) => d.volumeSol) / c.volumeSol - 1) < 1e-6, "volume");
  for (const r of ["creator", "Raydium", "liquidity"] as const) assert.ok(Math.abs(sum((d) => d.byRecipient[r]) / c.byRecipient[r] - 1) < 1e-5, r);
  // Pool fees start on the day the running volume passes the curve's, and not before.
  let running = 0;
  const graduatedOn = days.findIndex((d) => (running += d.volumeSol) > c.curveVolumeSol);
  assert.equal(days.findIndex((d) => d.byRecipient.liquidity > 0), graduatedOn);

  // Added up over a window: every day present, quiet ones as zero, the rest summed.
  const last = Date.parse(`${days.at(-1)!.day}T12:00:00Z`);
  const window = sumDailyFees([days, days], 3, last + 86_400_000);
  assert.deepEqual(window.map((d) => d.day), [days.at(-2)!.day, days.at(-1)!.day, new Date(last + 86_400_000).toISOString().slice(0, 10)].filter((d, i, a) => a.indexOf(d) === i).slice(-3));
  assert.equal(window.at(-1)!.feesSol, 0);
  assert.ok(Math.abs(window.at(-2)!.feesSol - 2 * days.at(-1)!.feesSol) < 1e-6);
});
