import { DEFAULT_API_URL, HigherApi, createHttpConfig, type TapeEntry } from "highwire-core";

// higher.fun's tape (its latest launches, buys, sells and graduations), cut down for the homepage's live wire. Its
// socket only answers higher.fun's own pages and its HTTP API sends no CORS headers, so the browser reads it through
// /api/tape, which the CDN caches for five seconds. Tickers are written by creators: only letters and digits pass.

export interface TapeItem {
  id: string;
  kind: "launch" | "buy" | "sell" | "graduation";
  ticker: string;
  /** SOL in a buy or sell. */
  sol: number | null;
  at: string;
}

const KIND: Record<TapeEntry["kind"], TapeItem["kind"]> = { new: "launch", buy: "buy", sell: "sell", graduated: "graduation" };

export function cleanTape(items: TapeEntry[]): TapeItem[] {
  return items.flatMap((e) => {
    const kind = KIND[e.kind];
    if (!kind || typeof e.id !== "string" || Number.isNaN(Date.parse(e.at))) return [];
    const lamports = e.quoteAmount && /^\d+$/.test(e.quoteAmount.split(".")[0] ?? "") ? Number(e.quoteAmount.split(".")[0]) : null;
    return [{ id: e.id.slice(0, 120), kind, ticker: (e.ticker ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 10), sol: lamports === null ? null : lamports / 1e9, at: e.at }];
  });
}

export async function readTape(): Promise<TapeItem[] | null> {
  const api = new HigherApi(createHttpConfig({ baseUrl: DEFAULT_API_URL, timeoutMs: 6_000, retries: 0, userAgent: "highwire-site" }));
  try {
    return cleanTape((await api.tape()).items);
  } catch {
    return null;
  }
}
