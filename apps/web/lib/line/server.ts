import { Chain, createHttpConfig, DEFAULT_API_URL, evaluateRisk, HigherApi, HIGHWIRE_WALLET, NotFoundError, SolanaRpc, solToLamports } from "highwire-core";
import { readWagerConfig, seriesOutcome, WAGER_PROGRAM_IDS } from "highwire-wager/chain";
import { GENESIS_HASHES } from "highwire-agent";
import { serverOptionsFromEnv } from "highwire-mcp";
import { createRelay, JsonRpc, realClock, UpstashStore, type CoinDirectory, type Relay, type WagerConfig } from "highwire-relay";

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

/**
 * Which cluster the wager desk plays on: LINE_WAGER_CLUSTER, "devnet" (the default) or "mainnet". Flipping it to
 * "mainnet" (with the program's config unpaused on-chain) is the switch (docs/wager-mainnet.md): mainnet's settings
 * are set ahead of time under their own names, so the flip changes nothing else.
 */
export function wagerCluster(): "devnet" | "mainnet" {
  return process.env.LINE_WAGER_CLUSTER?.trim().toLowerCase() === "mainnet" ? "mainnet" : "devnet";
}

/** A wager setting for the desk's cluster: devnet's are LINE_WAGER_<NAME>, mainnet's LINE_WAGER_MAINNET_<NAME>. */
export function wagerSetting(name: string): string | undefined {
  return process.env[wagerCluster() === "mainnet" ? `LINE_WAGER_MAINNET_${name}` : `LINE_WAGER_${name}`] || undefined;
}

/** The desk's chain: its cluster, through RPC_URL (devnet's public RPC throttles reads; mainnet's is required). */
export function wagerChain(): Chain {
  return new Chain({ cluster: wagerCluster(), rpcUrl: wagerSetting("RPC_URL") });
}

/**
 * Wagering's matchmaker (docs/wager-mode.md 7.4): on only with the ticket key (TICKET_KEY: its 32-byte Ed25519 secret,
 * hex, held only in the site's environment), the key id the program's config holds for it (KEY_ID), and a program on
 * that cluster. TIERS lists the tiers in SOL; MIN_QUEUE how many owners must wait at a tier before it pairs;
 * PER_PAIR_WEEK how many series two owners may play in a week. Mainnet's defaults are the spec's (W2: one 0.1 SOL tier,
 * four owners, two a week); devnet's are looser for practice.
 */
function wagerConfig(): WagerConfig | undefined {
  const cluster = wagerCluster();
  const mainnet = cluster === "mainnet";
  const secret = wagerSetting("TICKET_KEY");
  const programId = WAGER_PROGRAM_IDS[cluster];
  if (!secret || !/^[0-9a-f]{64}$/i.test(secret) || !programId) return undefined;
  if (mainnet && !wagerSetting("RPC_URL")) return undefined;
  const chain = wagerChain();
  // The RPC must be on the desk's cluster: one on another would answer "no such series" for every live one, and the
  // desk would close them as never opened. Checked once; on a mismatch every read fails, so nothing closes.
  let genesis: Promise<void> | null = null;
  const onCluster = () =>
    (genesis ??= chain.connection.getGenesisHash().then((g) => {
      if (g !== GENESIS_HASHES[cluster]) {
        console.error(`line: the wager RPC isn't on ${cluster} (genesis ${g}): wager outcomes won't be read until it is`);
        throw new Error(`the wager RPC isn't on ${cluster}`);
      }
    })).catch((err: unknown) => {
      genesis = null;
      throw err;
    });
  return {
    programId,
    cluster,
    ticketSecret: Uint8Array.from(Buffer.from(secret, "hex")),
    keyId: Number(wagerSetting("KEY_ID") ?? 1),
    tiers: (wagerSetting("TIERS") ?? (mainnet ? "0.1" : "0.01,0.1")).split(",").map((t) => solToLamports(Number(t.trim()))),
    minQueue: Number(wagerSetting("MIN_QUEUE") ?? 4),
    perPairPerWeek: Math.max(1, Math.floor(Number(wagerSetting("PER_PAIR_WEEK") ?? 2)) || 2),
    chain: {
      status: async (id) => {
        await onCluster();
        return seriesOutcome(chain, id);
      },
      config: async () => {
        await onCluster();
        const c = await readWagerConfig(chain);
        return { paused: c.paused, keyId: c.ticketKeyId };
      },
    },
  };
}

let relay: Relay | null = null;

export function lineRelay(): Relay | null {
  if (!lineConfigured()) return null;
  if (relay) return relay;
  const rpcUrl = serverOptionsFromEnv(process.env).rpcUrl ?? "https://api.mainnet-beta.solana.com";
  const options = {
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
      // The house takes 4 seconds a round, so a match against it lasts about a minute and /line can show it live.
      housePaceMs: 4000,
      wager: wagerConfig(),
    },
  } satisfies Parameters<typeof createRelay>[0];
  try {
    relay = createRelay(options);
  } catch (err) {
    // A wager setting the desk refuses turns wagering off, not The Line.
    console.error(`line: wagering is off: ${err instanceof Error ? err.message : String(err)}`);
    relay = createRelay({ ...options, referee: { ...options.referee, wager: undefined } });
  }
  return relay;
}

/** The routes' handler: the referee, or a plain "not open yet" while the database isn't connected. */
export async function lineHandler(req: Request): Promise<Response> {
  const r = lineRelay();
  if (!r) return Response.json({ error: "The Line isn't open yet.", code: "not_found" }, { status: 404 });
  return r.fetch(req);
}
