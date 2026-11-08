import { createHttpConfig, DEFAULT_API_URL, evaluateRisk, HigherApi, HIGHWIRE_WALLET, NotFoundError, SolanaRpc } from "highwire-core";
import { serverOptionsFromEnv } from "highwire-mcp";
import { createRelay, JsonRpc, realClock, UpstashStore, type CoinDirectory, type Relay } from "highwire-relay";

// The Line's referee, hosted in the site (docs/arena.md 8): highwire-relay over the Upstash database Vercel connected
// as LINE_*, mainnet's RPC for registrations, and higher.fun's API with the rug check for coins. Null until the
// database is connected, so the routes and pages stay off without it.

export const lineConfigured = () => Boolean(process.env.LINE_KV_REST_API_URL && process.env.LINE_KV_REST_API_TOKEN);

/** What the referee needs to know about a coin: its name and creator, and whether the page may link to it. */
function coinDirectory(rpcUrl: string): CoinDirectory {
  const api = new HigherApi(createHttpConfig({ baseUrl: DEFAULT_API_URL, timeoutMs: 8000, retries: 1, userAgent: "highwire-line" }));
  const rpc = new SolanaRpc(rpcUrl, 8000);
  return {
    async coin(mint) {
      let coin;
      try {
        coin = await api.coin(mint);
      } catch (err) {
        if (err instanceof NotFoundError) return null;
        throw err;
      }
      const onchain = await rpc.mintInfo(mint).catch((err: unknown) => ({ error: String(err) }));
      return {
        name: coin.name,
        ticker: coin.ticker,
        createdAt: Date.parse(coin.createdAt),
        holders: 0,
        volumeSol: 0,
        rugFlag: evaluateRisk(coin, onchain).verdict === "HIGH_RISK",
        creatorHolds: (coin.creatorHoldingBps ?? 0) > 0,
        creator: coin.creator,
      };
    },
  };
}

let relay: Relay | null = null;

export function lineRelay(): Relay | null {
  if (!lineConfigured()) return null;
  if (relay) return relay;
  const rpcUrl = serverOptionsFromEnv(process.env).rpcUrl ?? "https://api.mainnet-beta.solana.com";
  relay = createRelay({
    store: new UpstashStore({ url: process.env.LINE_KV_REST_API_URL!, token: process.env.LINE_KV_REST_API_TOKEN! }),
    clock: realClock,
    rpc: new JsonRpc(rpcUrl),
    coins: coinDirectory(rpcUrl),
    cronSecret: process.env.CRON_SECRET || undefined,
    adminToken: process.env.LINE_ADMIN_TOKEN || undefined,
    clientKey: (req) => req.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    referee: {
      // Highwire's own coins play but are never ranked; LINE_OPERATOR_WALLETS adds the maintainer's.
      operatorWallets: [HIGHWIRE_WALLET, ...(process.env.LINE_OPERATOR_WALLETS ?? "").split(",").map((w) => w.trim()).filter(Boolean)],
    },
  });
  return relay;
}

/** The routes' handler: the referee, or a plain "not open yet" while the database isn't connected. */
export async function lineHandler(req: Request): Promise<Response> {
  const r = lineRelay();
  if (!r) return Response.json({ error: "The Line isn't open yet.", code: "not_found" }, { status: 404 });
  return r.fetch(req);
}
