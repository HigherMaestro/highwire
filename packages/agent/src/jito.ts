import { HigherError, JITO_MIN_TIP_LAMPORTS } from "highwire-core";

// Jito's block engine, for protected sends (docs/protected-sends.md): one transaction at a time, as a one-transaction
// bundle (bundleOnly), so it lands whole or not at all and never sits in the public queue. Only the local signer uses
// this, and only when the user's policy sets "send": { "route": "jito" }.

export const DEFAULT_JITO_URL = "https://mainnet.block-engine.jito.wtf";
export const TIP_FLOOR_URL = "https://bundles.jito.wtf/api/v1/bundles/tip_floor";

/** The block engine said no (rate limited, or refused the transaction): nothing was accepted, so nothing can land. */
export class JitoRejected extends Error {}

export interface JitoClient {
  /** Jito's tip accounts, as the block engine lists them. */
  tipAccounts(): Promise<string[]>;
  /** The recent median landed tip, in lamports; null when it can't be read. */
  tipFloorLamports(): Promise<bigint | null>;
  /**
   * Sends a signed transaction (base64) as a one-transaction bundle. Resolves once the block engine accepts it; throws
   * JitoRejected when it refuses, and anything else when the answer is lost (it may still land).
   */
  send(base64: string): Promise<{ bundleId?: string }>;
}

export function jitoClient(base = process.env.HIGHWIRE_JITO_URL ?? DEFAULT_JITO_URL, fetchImpl: typeof fetch = fetch): JitoClient {
  const url = base.replace(/\/+$/, "");
  const rpc = async (path: string, method: string, params: unknown[]) => {
    const res = await fetchImpl(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null;
    return { res, body };
  };
  return {
    async tipAccounts() {
      const { res, body } = await rpc("/api/v1/getTipAccounts", "getTipAccounts", []);
      if (!res.ok || !Array.isArray(body?.result)) throw new HigherError(`Jito's block engine didn't list its tip accounts (HTTP ${res.status})`, { code: "unavailable" });
      return body.result as string[];
    },
    async tipFloorLamports() {
      try {
        const res = await fetchImpl(TIP_FLOOR_URL, { signal: AbortSignal.timeout(5_000) });
        const rows = (await res.json()) as { landed_tips_50th_percentile?: number }[];
        const sol = rows?.[0]?.landed_tips_50th_percentile;
        return typeof sol === "number" && Number.isFinite(sol) && sol >= 0 ? BigInt(Math.ceil(sol * 1e9)) : null;
      } catch {
        return null;
      }
    },
    async send(base64) {
      const { res, body } = await rpc("/api/v1/transactions?bundleOnly=true", "sendTransaction", [base64, { encoding: "base64" }]);
      // An answer that says no means nothing was accepted. Anything else (no answer at all) is thrown by fetch itself.
      if (res.status === 429) throw new JitoRejected("Jito's block engine is rate limiting this IP (one send a second)");
      if (!res.ok || body?.error || typeof body?.result !== "string") {
        throw new JitoRejected(`Jito's block engine refused it: ${body?.error?.message ?? `HTTP ${res.status}`}`);
      }
      return { bundleId: res.headers.get("x-bundle-id") ?? undefined };
    },
  };
}

/** The tip for one send: 1.2 times the recent median, between Jito's minimum and the policy's cap; a quarter of the cap without a floor. */
export function tipFor(floor: bigint | null, cap: bigint): bigint {
  const want = floor === null ? cap / 4n : (floor * 12n + 9n) / 10n;
  return want < JITO_MIN_TIP_LAMPORTS ? JITO_MIN_TIP_LAMPORTS : want > cap ? cap : want;
}
