import {
  CpmmConfigInfoLayout,
  CpmmPoolInfoLayout,
  getPdaCreatorVault,
  getPdaPlatformVault,
  LaunchpadConfig,
  LaunchpadPool,
  PlatformConfig,
} from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";
import type { Coin, HigherApi } from "../higher/api.ts";
import { feeModeOfPlatform, type FeeMode } from "../higher/constants.ts";
import { WSOL, type Chain } from "./chain.ts";
import { lamportsNumber } from "./units.ts";

// The fees higher.fun coins have generated, and where they went. Everything is
// read from the chain except two inputs: coin names, and each graduated coin's
// lifetime volume (higher.fun's daily candles), which with the on-chain fee rates
// gives the pool-phase fees. Each line says whether it was measured on-chain or
// computed from volume at the on-chain rates.
//
// On the curve, Raydium's fee accumulates in the LaunchLab pool's `protocolFee`
// and is never reset, so it measures the coin's curve volume exactly; higher.fun's
// platform fee and the creator fee are fixed multiples of it. In the CPMM pool,
// the counters reset whenever someone collects, so the pool's fees are computed
// from volume, and the collectable amounts are read as they stand.

export type Recipient = "higher.fun" | "creator" | "Raydium" | "liquidity";
export type Basis = "measured" | "computed";

export interface FeeFlow {
  phase: "curve" | "pool";
  label: string;
  to: Recipient;
  /** The rate as a percentage of volume. */
  ratePct: number;
  sol: number;
  basis: Basis;
}

export interface CoinFees {
  mint: string;
  name: string | null;
  ticker: string | null;
  creator: string;
  feeMode: FeeMode;
  status: "curve" | "graduated" | "migrating";
  createdAt: string | null;
  curveVolumeSol: number;
  /** Null when the pool's volume couldn't be read. */
  poolVolumeSol: number | null;
  volumeSol: number;
  volume24hSol: number | null;
  totalFeesSol: number;
  byRecipient: Record<Recipient, number>;
  lines: FeeFlow[];
  /** Graduated coins only. */
  pool: {
    poolId: string;
    /** The pool creator fee the creator can collect now, after Raydium's share. */
    creatorWaitingSol: number;
    /** New school only: the LP lock whose Fee Key higher.fun holds. */
    lockedLp: { sharePct: number; harvestedSol: number; harvestedLp: number } | null;
  } | null;
}

export interface EcosystemFees {
  generatedAt: string;
  solUsd: number | null;
  coins: CoinFees[];
  totals: {
    coins: number;
    graduated: number;
    volumeSol: number;
    curveVolumeSol: number;
    poolVolumeSol: number;
    feesSol: number;
    byRecipient: Record<Recipient, number>;
    byPhase: { curve: number; pool: number };
    byMode: Record<FeeMode, { coins: number; volumeSol: number; feesSol: number }>;
    /** 0.02 SOL per coin at today's launch fee: an estimate, since it isn't recorded per coin. */
    launchFeesSol: number;
  };
  /** What sits in the vaults right now, waiting to be claimed. */
  waiting: {
    higherCurveSol: number;
    creatorCurveSol: number;
    creatorPoolSol: number;
  };
  /** The rates the computed lines use, as read on-chain, in percent. */
  rates: {
    curve: Record<FeeMode, { raydium: number; platform: number; creator: number }>;
    pool: { trade: number; raydiumShareOfTrade: number; creator: number; raydiumShareOfCreator: number };
  };
  warnings: string[];
}

const PPM = 1_000_000n;
const big = (v: { toString(): string }) => BigInt(v.toString());
const pct = (ppm: bigint) => Number(ppm) / 10_000;
const LAUNCH_FEE_SOL = 0.02;

/** A token account's amount: the u64 at byte 64. */
const tokenAmount = (data: Buffer | undefined) => (data && data.length >= 72 ? data.readBigUInt64LE(64) : 0n);

async function inChunks<T, R>(items: T[], size: number, fn: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await fn(items.slice(i, i + size))));
  return out;
}

async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** Every coin higher.fun lists, for names and 24-hour volume. Best effort: a coin missing here keeps its mint. */
async function listedCoins(api: HigherApi, warnings: string[]): Promise<Map<string, Coin>> {
  const coins = new Map<string, Coin>();
  let cursor: string | undefined;
  try {
    for (let page = 0; page < 50; page++) {
      const res = await api.listCoins({ sort: "new", limit: 100, cursor });
      for (const c of res.items) coins.set(c.mint, c);
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
  } catch {
    warnings.push("Some coin names couldn't be read from higher.fun.");
  }
  return coins;
}

/** A coin's lifetime volume in lamports: the sum of its daily candles. Throws rather than guess. */
async function lifetimeVolume(api: HigherApi, mint: string): Promise<bigint> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { items } = await api.candles(mint, "1d");
      return items.reduce((n, c) => n + BigInt(c.volume.split(".")[0] || "0"), 0n);
    } catch (err) {
      if (attempt > 0) throw new Error(`${mint}'s volume couldn't be read`, { cause: err });
    }
  }
}

/** Reads and works out the fees for every higher.fun coin, or only `only` (mints). Mainnet only. */
export async function ecosystemFees(chain: Chain, api: HigherApi, opts: { only?: string[] } = {}): Promise<EcosystemFees> {
  const warnings: string[] = [];
  const program = chain.key("launchLabProgram");
  const platforms = [chain.key("rewardsPlatform"), chain.key("classicPlatform")];

  // Every pool on higher.fun's two platforms (or the named coins').
  type Found = { mint: PublicKey; state: ReturnType<typeof LaunchpadPool.decode> };
  let found: Found[];
  if (opts.only) {
    const mints = opts.only.map((m) => new PublicKey(m));
    const infos = await chain.connection.getMultipleAccountsInfo(mints.map((m) => chain.launchPoolId(m)));
    found = [];
    infos.forEach((info, i) => {
      if (!info || !info.owner.equals(program)) return;
      const state = LaunchpadPool.decode(info.data);
      if (platforms.some((p) => p.equals(state.platformId))) found.push({ mint: mints[i]!, state });
    });
  } else {
    found = [];
    for (const platform of platforms) {
      const accounts = await chain.connection.getProgramAccounts(program, {
        filters: [{ dataSize: LaunchpadPool.span }, { memcmp: { offset: LaunchpadPool.offsetOf("platformId"), bytes: platform.toBase58() } }],
      });
      for (const a of accounts) {
        const state = LaunchpadPool.decode(a.account.data);
        found.push({ mint: state.mintA, state });
      }
    }
  }
  found = found.filter((f) => f.state.mintB.equals(WSOL));

  // The rates, on-chain: each LaunchLab config's trade fee, each platform's fees, the CPMM fee tier.
  const configIds = [...new Set(found.map((f) => f.state.configId.toBase58()))].map((k) => new PublicKey(k));
  const [cpmmCfgInfo, ...rateInfos] = await chain.connection.getMultipleAccountsInfo([chain.key("cpmmConfig"), ...platforms, ...configIds]);
  if (!cpmmCfgInfo) throw new Error("higher.fun's CPMM fee tier is missing");
  const cpmm = CpmmConfigInfoLayout.decode(cpmmCfgInfo.data);
  const platformState = new Map<string, ReturnType<typeof PlatformConfig.decode>>();
  platforms.forEach((p, i) => {
    const info = rateInfos[i];
    if (info) platformState.set(p.toBase58(), PlatformConfig.decode(info.data));
  });
  const tradeRate = new Map<string, bigint>();
  configIds.forEach((c, i) => {
    const info = rateInfos[platforms.length + i];
    if (info) tradeRate.set(c.toBase58(), big(LaunchpadConfig.decode(info.data).tradeFeeRate));
  });

  const listed = opts.only ? new Map<string, Coin>() : await listedCoins(api, warnings);
  if (opts.only) {
    for (const m of opts.only) {
      const c = await api.coin(m).catch(() => null);
      if (c) listed.set(m, c);
    }
  }

  // Graduated coins: their CPMM pools, the pools' SOL vaults, lifetime volume and, for New school, the LP lock.
  const graduated = found.filter((f) => f.state.status === 2);
  const poolIds = graduated.map((f) => chain.graduatedPoolId(f.mint));
  const poolInfos = await inChunks(poolIds, 99, (ids) => chain.connection.getMultipleAccountsInfo(ids));
  const pools = new Map<string, { id: PublicKey; state: ReturnType<typeof CpmmPoolInfoLayout.decode>; solIsA: boolean }>();
  graduated.forEach((f, i) => {
    const info = poolInfos[i];
    if (!info || !info.owner.equals(chain.key("cpmmProgram"))) return;
    const state = CpmmPoolInfoLayout.decode(info.data);
    pools.set(f.mint.toBase58(), { id: poolIds[i]!, state, solIsA: state.mintA.equals(WSOL) });
  });
  const solVaults = [...pools.values()].map((p) => (p.solIsA ? p.state.vaultA : p.state.vaultB));
  const vaultInfos = await inChunks(solVaults, 99, (ids) => chain.connection.getMultipleAccountsInfo(ids));
  const solReserve = new Map<string, bigint>();
  [...pools.keys()].forEach((mint, i) => solReserve.set(mint, tokenAmount(vaultInfos[i]?.data)));

  // A missing volume or LP lock would quietly move fees between recipients, so either one fails the whole read.
  const volumes = new Map<string, bigint>();
  await pooled(graduated, 4, async (f) => volumes.set(f.mint.toBase58(), await lifetimeVolume(api, f.mint.toBase58())));

  const locks = new Map<string, { locked: bigint; claimed: bigint }>();
  await pooled(
    graduated.filter((f) => feeModeOfPlatform(chain.cluster, f.state.platformId.toBase58()) === "rewards" && pools.has(f.mint.toBase58())),
    3,
    async (f) => {
      const pool = pools.get(f.mint.toBase58())!;
      // A lock account: discriminator, then locked_lp, claimed_lp, unclaimed_lp, last_lp, last_k (u128), recent_epoch,
      // then the pool id at byte 64.
      const accounts = await chain.connection.getProgramAccounts(chain.key("lockCpmmProgram"), {
        filters: [{ memcmp: { offset: 64, bytes: pool.id.toBase58() } }],
      });
      let locked = 0n;
      let claimed = 0n;
      for (const a of accounts) {
        locked += a.account.data.readBigUInt64LE(8);
        claimed += a.account.data.readBigUInt64LE(16);
      }
      locks.set(f.mint.toBase58(), { locked, claimed });
    },
  );

  // What's waiting in the vaults: higher.fun's curve fees, each creator's curve fees.
  const creators = [...new Set(found.map((f) => f.state.creator.toBase58()))];
  const vaultKeys = [
    ...platforms.map((p) => getPdaPlatformVault(program, p, WSOL).publicKey),
    ...creators.map((c) => getPdaCreatorVault(program, new PublicKey(c), WSOL).publicKey),
  ];
  const waitingInfos = await inChunks(vaultKeys, 99, (ids) => chain.connection.getMultipleAccountsInfo(ids));
  const higherCurveWaiting = waitingInfos.slice(0, platforms.length).reduce((n, i) => n + tokenAmount(i?.data), 0n);
  const creatorCurveWaiting = waitingInfos.slice(platforms.length).reduce((n, i) => n + tokenAmount(i?.data), 0n);

  const solUsd = await api.solPrice().then(
    (r) => r.usd,
    () => null,
  );

  const coins: CoinFees[] = found.map((f) => {
    const mint = f.mint.toBase58();
    const mode = feeModeOfPlatform(chain.cluster, f.state.platformId.toBase58()) ?? "rewards";
    const plat = platformState.get(f.state.platformId.toBase58());
    const trade = tradeRate.get(f.state.configId.toBase58()) ?? 2500n;
    const raydiumCurve = big(f.state.protocolFee);
    const curveVolume = trade > 0n ? (raydiumCurve * PPM) / trade : 0n;
    const platformCurve = plat ? (raydiumCurve * big(plat.feeRate)) / trade : 0n;
    const creatorCurve = plat ? (raydiumCurve * big(plat.creatorFeeRate)) / trade : 0n;
    const lines: FeeFlow[] = [
      { phase: "curve", label: "Raydium's LaunchLab fee", to: "Raydium", ratePct: pct(trade), sol: lamportsNumber(raydiumCurve), basis: "measured" },
    ];
    if (platformCurve > 0n) {
      lines.push({ phase: "curve", label: "higher.fun's platform fee", to: "higher.fun", ratePct: pct(big(plat!.feeRate)), sol: lamportsNumber(platformCurve), basis: "measured" });
    }
    if (creatorCurve > 0n) {
      lines.push({ phase: "curve", label: "Creator fee", to: "creator", ratePct: pct(big(plat!.creatorFeeRate)), sol: lamportsNumber(creatorCurve), basis: "measured" });
    }

    const listing = listed.get(mint);
    const status = f.state.status === 2 ? "graduated" : f.state.status === 1 ? "migrating" : "curve";
    let poolVolume: bigint | null = null;
    let pool: CoinFees["pool"] = null;
    const p = pools.get(mint);
    if (status === "graduated" && p) {
      const total = volumes.get(mint) ?? 0n;
      poolVolume = total > curveVolume ? total - curveVolume : 0n;
      const v = poolVolume;
      const tradeFee = (v * big(cpmm.tradeFeeRate)) / PPM;
      const raydiumTrade = (tradeFee * (big(cpmm.protocolFeeRate) + big(cpmm.fundFeeRate))) / PPM;
      const lpFees = tradeFee - raydiumTrade;
      const creatorFee = (v * big(cpmm.creatorFeeRate)) / PPM;
      const raydiumCreator = (creatorFee * big(cpmm.creatorFeeShareRate)) / PPM;
      const lpSupply = big(p.state.lpAmount);
      const lock = locks.get(mint);
      // The locked LP's share of the pool's LP fees; the rest belongs to burned LP and stays in the pool.
      const lockedShare = lock && lpSupply > 0n ? Number(((lock.locked + lock.claimed) * PPM) / lpSupply) / 1e6 : 0;
      const lockedFees = BigInt(Math.round(Number(lpFees) * lockedShare));
      const creatorLocked = lockedFees / 3n;
      const tradePct = pct(big(cpmm.tradeFeeRate));
      const lpPct = (tradePct * Number(PPM - big(cpmm.protocolFeeRate) - big(cpmm.fundFeeRate))) / 1e6;
      lines.push(
        { phase: "pool", label: "Raydium's protocol and fund fees", to: "Raydium", ratePct: tradePct - lpPct, sol: lamportsNumber(raydiumTrade), basis: "computed" },
        { phase: "pool", label: "Pool creator fee", to: "creator", ratePct: pct(big(cpmm.creatorFeeRate) - (big(cpmm.creatorFeeRate) * big(cpmm.creatorFeeShareRate)) / PPM), sol: lamportsNumber(creatorFee - raydiumCreator), basis: "computed" },
        { phase: "pool", label: "Raydium's share of the creator fee", to: "Raydium", ratePct: pct((big(cpmm.creatorFeeRate) * big(cpmm.creatorFeeShareRate)) / PPM), sol: lamportsNumber(raydiumCreator), basis: "computed" },
      );
      if (lockedFees > 0n) {
        lines.push(
          { phase: "pool", label: "Locked-LP fees, higher.fun's two thirds", to: "higher.fun", ratePct: (lpPct * lockedShare * 2) / 3, sol: lamportsNumber(lockedFees - creatorLocked), basis: "computed" },
          { phase: "pool", label: "Locked-LP fees, the creator's third (paid off-chain)", to: "creator", ratePct: (lpPct * lockedShare) / 3, sol: lamportsNumber(creatorLocked), basis: "computed" },
        );
      }
      lines.push({ phase: "pool", label: "LP fees on burned liquidity (stay in the pool)", to: "liquidity", ratePct: lpPct * (1 - lockedShare), sol: lamportsNumber(lpFees - lockedFees), basis: "computed" });

      const waitingGross = big(p.solIsA ? p.state.creatorFeesMintA : p.state.creatorFeesMintB);
      const reserve = solReserve.get(mint) ?? 0n;
      // An LP token's worth in SOL: both sides of the pool, valued at its own price, over the LP supply.
      const lpValue = lpSupply > 0n ? (2 * Number(reserve)) / Number(lpSupply) : 0;
      pool = {
        poolId: p.id.toBase58(),
        creatorWaitingSol: lamportsNumber((waitingGross * (PPM - big(cpmm.creatorFeeShareRate))) / PPM),
        lockedLp: lock
          ? { sharePct: Math.round(lockedShare * 10_000) / 100, harvestedLp: Number(lock.claimed) / 1e9, harvestedSol: Math.round(lpValue * Number(lock.claimed)) / 1e9 }
          : null,
      };
    }

    const byRecipient: Record<Recipient, number> = { "higher.fun": 0, creator: 0, Raydium: 0, liquidity: 0 };
    for (const l of lines) byRecipient[l.to] += l.sol;
    const totalFees = lines.reduce((n, l) => n + l.sol, 0);
    return {
      mint,
      name: listing?.name ?? null,
      ticker: listing?.ticker ?? null,
      creator: f.state.creator.toBase58(),
      feeMode: mode,
      status,
      createdAt: listing?.createdAt ?? null,
      curveVolumeSol: lamportsNumber(curveVolume),
      poolVolumeSol: poolVolume == null ? (status === "graduated" ? null : 0) : lamportsNumber(poolVolume),
      volumeSol: lamportsNumber(curveVolume + (poolVolume ?? 0n)),
      volume24hSol: listing?.volume24h ? Number(BigInt(listing.volume24h.split(".")[0] || "0")) / 1e9 : null,
      totalFeesSol: round9(totalFees),
      byRecipient: mapValues(byRecipient, round9),
      lines: lines.map((l) => ({ ...l, sol: round9(l.sol), ratePct: Math.round(l.ratePct * 1e6) / 1e6 })),
      pool,
    };
  });
  coins.sort((a, b) => b.totalFeesSol - a.totalFeesSol);

  const sum = (f: (c: CoinFees) => number, list = coins) => round9(list.reduce((n, c) => n + f(c), 0));
  const modeTotals = (mode: FeeMode) => {
    const list = coins.filter((c) => c.feeMode === mode);
    return { coins: list.length, volumeSol: sum((c) => c.volumeSol, list), feesSol: sum((c) => c.totalFeesSol, list) };
  };
  const curveRates = (mode: FeeMode) => {
    const plat = platformState.get((mode === "rewards" ? platforms[0] : platforms[1])!.toBase58());
    const trade = [...tradeRate.values()][0] ?? 2500n;
    return { raydium: pct(trade), platform: plat ? pct(big(plat.feeRate)) : 0, creator: plat ? pct(big(plat.creatorFeeRate)) : 0 };
  };
  return {
    generatedAt: new Date().toISOString(),
    solUsd,
    coins,
    totals: {
      coins: coins.length,
      graduated: coins.filter((c) => c.status === "graduated").length,
      volumeSol: sum((c) => c.volumeSol),
      curveVolumeSol: sum((c) => c.curveVolumeSol),
      poolVolumeSol: sum((c) => c.poolVolumeSol ?? 0),
      feesSol: sum((c) => c.totalFeesSol),
      byRecipient: {
        "higher.fun": sum((c) => c.byRecipient["higher.fun"]),
        creator: sum((c) => c.byRecipient.creator),
        Raydium: sum((c) => c.byRecipient.Raydium),
        liquidity: sum((c) => c.byRecipient.liquidity),
      },
      byPhase: {
        curve: sum((c) => c.lines.filter((l) => l.phase === "curve").reduce((n, l) => n + l.sol, 0)),
        pool: sum((c) => c.lines.filter((l) => l.phase === "pool").reduce((n, l) => n + l.sol, 0)),
      },
      byMode: { rewards: modeTotals("rewards"), classic: modeTotals("classic") },
      launchFeesSol: round9(coins.length * LAUNCH_FEE_SOL),
    },
    waiting: {
      higherCurveSol: lamportsNumber(higherCurveWaiting),
      creatorCurveSol: lamportsNumber(creatorCurveWaiting),
      creatorPoolSol: sum((c) => c.pool?.creatorWaitingSol ?? 0),
    },
    rates: {
      curve: { rewards: curveRates("rewards"), classic: curveRates("classic") },
      pool: {
        trade: pct(big(cpmm.tradeFeeRate)),
        raydiumShareOfTrade: pct(big(cpmm.protocolFeeRate) + big(cpmm.fundFeeRate)),
        creator: pct(big(cpmm.creatorFeeRate)),
        raydiumShareOfCreator: pct(big(cpmm.creatorFeeShareRate)),
      },
    },
    warnings,
  };
}

const round9 = (n: number) => Math.round(n * 1e9) / 1e9;
const mapValues = <K extends string>(o: Record<K, number>, f: (n: number) => number) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v as number)])) as Record<K, number>;
