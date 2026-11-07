import { cache } from "react";
import { PublicKey } from "@solana/web3.js";
import { Chain, DEFAULT_API_URL, HOLDER_AIRDROPS, HigherApi, createHttpConfig, ecosystemFees, type EcosystemFees, type FeeMode, type Recipient } from "highwire-core";
import type { Flow, FlowScenario, Scenario } from "../components/fees/FeeFlow.tsx";
import { serverOptionsFromEnv } from "highwire-mcp";

// The fee pages' data: read from mainnet and higher.fun's API on the server. The
// pages are regenerated in the background at most every 10 minutes (their
// `revalidate`), so a visit never waits on the chain.

/**
 * A failed read. While building, the page renders its "couldn't be read" notice. At run time it throws instead, so a
 * failed refresh keeps serving the last good page rather than replacing it with the notice.
 */
function failed<T>(what: string, err: unknown, fallback: T): T {
  console.error(`fees: couldn't read ${what}`, err);
  if (process.env.NEXT_PHASE === "phase-production-build") return fallback;
  throw err instanceof Error ? err : new Error(String(err));
}

function sources() {
  const chain = new Chain({ cluster: "mainnet", rpcUrl: serverOptionsFromEnv(process.env).rpcUrl, timeoutMs: 20_000 });
  const api = new HigherApi(createHttpConfig({ baseUrl: DEFAULT_API_URL, timeoutMs: 10_000, retries: 1, userAgent: "highwire-site" }));
  return { chain, api };
}

/** Every higher.fun coin's fees, or null when the chain or the API couldn't be read while building. */
export const allFees = cache(async (): Promise<EcosystemFees | null> => {
  try {
    const { chain, api } = sources();
    return await ecosystemFees(chain, api);
  } catch (err) {
    return failed("the ecosystem", err, null);
  }
});

/** One coin's fees; null when it isn't a higher.fun coin, undefined when it couldn't be read while building. */
export const coinFees = cache(async (mint: string): Promise<EcosystemFees | null | undefined> => {
  try {
    const { chain, api } = sources();
    const r = await ecosystemFees(chain, api, { only: [mint] });
    return r.coins.length ? r : null;
  } catch (err) {
    return failed(mint, err, undefined);
  }
});

export const RECIPIENTS: { key: Recipient; label: string; color: string; note: string }[] = [
  { key: "creator", label: "Creators", color: "#F6A9C4", note: "Curve and pool creator fees, and New school creators' third of the locked-LP fees" },
  { key: "higher.fun", label: "higher.fun", color: "#F7C84C", note: "New school platform fees, less what it airdrops to holders, and two thirds of the locked-LP fees" },
  { key: "holders", label: "Holders", color: "#C9B8F5", note: "SOL airdropped to New school coins' holders, or waiting in their airdrop wallets: part of higher.fun's fee, and the creator fees of creators who gave theirs" },
  { key: "Raydium", label: "Raydium", color: "#93E2FB", note: "LaunchLab's fee on the curve, the pool's protocol and fund fees, and 5% of pool creator fees" },
  { key: "liquidity", label: "Stays in the pool", color: "#A6EFCB", note: "LP fees earned by burned liquidity, which no one can withdraw" },
];

export const MODE_LABEL = { rewards: "New school", classic: "Old school" } as const;

/** SOL, with as many decimals as the size calls for. */
export function sol(n: number): string {
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : abs >= 0.01 ? 3 : abs > 0 ? 4 : 0;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function usd(n: number | null, solUsd: number | null): string | null {
  if (n == null || solUsd == null) return null;
  const v = n * solUsd;
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 0 : 2 })}`;
}

export function pctOf(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const p = (part / whole) * 100;
  return `${p >= 10 ? p.toFixed(0) : p.toFixed(1)}%`;
}

export function updatedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC";
}

/** A real 32-byte Solana address, not just base58 of the right length. */
export function isMint(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return new PublicKey(s).toBytes().length === 32;
  } catch {
    return false;
  }
}

export { coinLabel } from "./names.ts";

/**
 * The fee-flow diagram's four views (curve or pool, New or Old school): each recipient's cut of one trade, from the rates
 * read on-chain, and what it has been paid so far. A New school pool's locked share is the average across its pools.
 */
export function flowScenarios(data: EcosystemFees): Record<Scenario, FlowScenario> {
  const r = data.rates;
  const locks = data.coins.map((c) => c.pool?.lockedLp?.sharePct).filter((v): v is number => v != null);
  const locked = locks.length ? locks.reduce((a, b) => a + b, 0) / locks.length / 100 : 0.3;
  const lp = r.pool.trade * (1 - r.pool.raydiumShareOfTrade / 100);
  const raydiumPool = r.pool.trade - lp + (r.pool.creator * r.pool.raydiumShareOfCreator) / 100;
  const creatorPool = r.pool.creator * (1 - r.pool.raydiumShareOfCreator / 100);
  const soFar = (phase: "curve" | "pool", mode: FeeMode, to: Recipient) =>
    data.coins.filter((c) => c.feeMode === mode).reduce((n, c) => n + c.lines.filter((l) => l.phase === phase && l.to === to).reduce((m, l) => m + l.sol, 0), 0);
  const label = Object.fromEntries(RECIPIENTS.map((x) => [x.key, x])) as Record<Recipient, (typeof RECIPIENTS)[number]>;
  const flow = (key: Recipient, ratePct: number, phase: "curve" | "pool", mode: FeeMode, detail: string): Flow => ({
    key,
    label: key === "creator" ? "Creator" : label[key].label,
    color: label[key].color,
    ratePct: Math.round(ratePct * 1e6) / 1e6,
    soFarSol: soFar(phase, mode, key),
    detail,
  });
  const curve = (mode: FeeMode): FlowScenario => {
    const c = r.curve[mode];
    // New school: higher.fun passes part of its platform fee to holders as airdrops.
    const toHolders = c.platform > 0 ? Math.min(c.platform, HOLDER_AIRDROPS.platformBps / 100) : 0;
    return {
      totalPct: c.raydium + c.platform + c.creator,
      hopPct: null,
      lockedPct: null,
      flows: [
        flow("creator", c.creator, "curve", mode, c.creator ? "The creator fee, collected in the creator's LaunchLab vault." : "Old school creators earn nothing on the curve."),
        flow("holders", toHolders, "curve", mode, toHolders ? "Airdropped to the coin's holders as SOL, out of higher.fun's platform fee." : "Old school coins have no holder airdrops."),
        flow("higher.fun", c.platform - toHolders, "curve", mode, c.platform ? "higher.fun's platform fee, into its platform vault, less what it airdrops to holders." : "Old school charges no platform fee."),
        flow("Raydium", c.raydium, "curve", mode, "LaunchLab's own fee."),
        flow("liquidity", 0, "curve", mode, "The curve has no liquidity providers."),
      ],
    };
  };
  const pool = (mode: FeeMode): FlowScenario => {
    const share = mode === "rewards" ? locked : 0;
    const pct = Math.round(share * 100);
    return {
      totalPct: r.pool.trade + r.pool.creator,
      hopPct: mode === "rewards" ? (lp * share) / 3 : null,
      lockedPct: mode === "rewards" ? pct : null,
      flows: [
        flow("creator", creatorPool + (lp * share) / 3, "pool", mode, mode === "rewards" ? `The pool creator fee, plus a third of the locked ${pct}%'s LP fees, paid by higher.fun.` : "The pool creator fee, on the SOL side."),
        flow("holders", 0, "pool", mode, "Holder airdrops come out of higher.fun's curve fee."),
        flow("higher.fun", (lp * share * 2) / 3, "pool", mode, mode === "rewards" ? `Two thirds of the LP fees earned by the locked ${pct}% of the liquidity.` : "Nothing in the pool; Old school pays higher.fun in supply."),
        flow("Raydium", raydiumPool, "pool", mode, `${r.pool.raydiumShareOfTrade}% of the trade fee, and ${r.pool.raydiumShareOfCreator}% of the creator fee.`),
        flow("liquidity", lp * (1 - share), "pool", mode, mode === "rewards" ? `LP fees earned by the burned ${100 - pct}%: no one can withdraw them.` : "LP fees on burned liquidity: no one can withdraw them."),
      ],
    };
  };
  return { "curve-rewards": curve("rewards"), "curve-classic": curve("classic"), "pool-rewards": pool("rewards"), "pool-classic": pool("classic") };
}
