import { DEFAULT_API_URL, HigherApi, createHttpConfig, summarizeCoin } from "highwire-core";

export type CoinSummary = ReturnType<typeof summarizeCoin>;

const api = new HigherApi(
  createHttpConfig({
    baseUrl: DEFAULT_API_URL,
    timeoutMs: 5_000,
    retries: 1,
    userAgent: "highwire-site",
    // Cache in Next's data cache; the page revalidates every minute.
    fetch: (input, init) => fetch(input, { ...init, next: { revalidate: 60 } }),
  }),
);

/** Coins closest to graduating. Never throws: the strip just hides if higher.fun is down. */
export async function graduatingCoins(limit = 6): Promise<CoinSummary[]> {
  try {
    const page = await api.listCoins({ sort: "graduating", limit });
    return page.items.filter((c) => c.status === "curve").map((c) => summarizeCoin(c));
  } catch {
    return [];
  }
}
