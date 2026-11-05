import { cache } from "react";
import { Chain, DEFAULT_API_URL, HigherApi, createHttpConfig, ecosystemFees, type EcosystemFees, type Recipient } from "highwire-core";
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
  { key: "higher.fun", label: "higher.fun", color: "#F7C84C", note: "New school platform fees and two thirds of the locked-LP fees" },
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

export const isMint = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

// Names and tickers are written by coin creators. Slurs are shown as the mint instead, so this site doesn't repeat them.
const SLURS = [/n+[i1!|l]+g{2,}/i, /f+[a@4]+g{1,2}[o0]+t/i, /\bk[i1]ke/i, /\bch[i1]nk/i, /\btrann(y|ie)/i];
const hidden = (s: string | null) => s != null && SLURS.some((re) => re.test(s.replace(/[\s._-]+/g, "")));

/** The ticker and name to show for a coin; both null when either would repeat a slur. */
export function coinLabel(c: { ticker: string | null; name: string | null }): { ticker: string | null; name: string | null } {
  return hidden(c.ticker) || hidden(c.name) ? { ticker: null, name: null } : { ticker: c.ticker, name: c.name };
}
