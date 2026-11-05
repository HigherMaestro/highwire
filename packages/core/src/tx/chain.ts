import {
  CpmmConfigInfoLayout,
  CpmmPoolInfoLayout,
  getCpmmPdaPoolId,
  getPdaLaunchpadPoolId,
  LaunchpadConfig,
  LaunchpadPool,
  PlatformConfig,
  Raydium,
} from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT } from "@solana/spl-token";
import { Connection, PublicKey, type AddressLookupTableAccount, type VersionedTransaction } from "@solana/web3.js";
import {
  ADDRESSES,
  DEFAULT_RPC_URLS,
  feeModeOfPlatform,
  LAUNCH_CONFIGS_URLS,
  type Cluster,
  type ClusterAddresses,
  type FeeMode,
} from "../higher/constants.ts";
import { HigherError, NetworkError, TimeoutError, ValidationError } from "../lib/errors.ts";

// Solana and Raydium access for the transaction builders. Every network call
// goes through one fetch: Solana JSON-RPC through @solana/web3.js, and the one
// Raydium HTTP read the SDK needs (LaunchLab's default curve parameters)
// through launchConfigs(). Tests replay recorded responses through it.

export type LaunchpadPoolState = ReturnType<typeof LaunchpadPool.decode>;
export type LaunchpadConfigState = ReturnType<typeof LaunchpadConfig.decode>;
export type PlatformState = ReturnType<typeof PlatformConfig.decode>;
export type CpmmPoolState = ReturnType<typeof CpmmPoolInfoLayout.decode>;
export type CpmmConfigState = ReturnType<typeof CpmmConfigInfoLayout.decode>;

export const WSOL = NATIVE_MINT;

export interface ChainOptions {
  cluster?: Cluster;
  rpcUrl?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** A LaunchLab default config as Raydium's launch-mint API publishes it. */
export interface LaunchConfig {
  key: { pubKey: string };
  defaultParams: { supplyInit: string; totalSellA: string; totalFundRaisingB: string };
}

/** Where a coin trades right now. */
export type Market =
  | {
      stage: "curve" | "migrating";
      mint: PublicKey;
      mode: FeeMode;
      poolId: PublicKey;
      pool: LaunchpadPoolState;
      config: LaunchpadConfigState;
      platform: PlatformState;
    }
  | {
      stage: "graduated";
      mint: PublicKey;
      mode: FeeMode;
      launchPoolId: PublicKey;
      poolId: PublicKey;
      pool: CpmmPoolState;
      config: CpmmConfigState;
    };

export class Chain {
  readonly cluster: Cluster;
  readonly addresses: ClusterAddresses;
  readonly connection: Connection;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private launchConfigsCache?: Promise<LaunchConfig[]>;

  constructor(opts: ChainOptions = {}) {
    this.cluster = opts.cluster ?? "mainnet";
    this.addresses = ADDRESSES[this.cluster];
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    const base = opts.fetch ?? globalThis.fetch;
    this.fetchImpl = (input, init) => {
      const signal = init?.signal ?? AbortSignal.timeout(this.timeoutMs);
      return base(input, { ...init, signal });
    };
    this.connection = new Connection(opts.rpcUrl ?? DEFAULT_RPC_URLS[this.cluster], {
      commitment: "confirmed",
      // The public RPC rate-limits hard; web3.js backs off and retries on 429.
      disableRetryOnRateLimit: false,
      fetch: this.fetchImpl as never,
    });
  }

  key(name: keyof ClusterAddresses): PublicKey {
    return new PublicKey(this.addresses[name]);
  }

  /**
   * Raydium's SDK, bound to a wallet that only ever appears as a public key.
   * The SDK's own HTTP client is replaced, so it can't reach Raydium's API
   * behind our back: the calls we allow are answered here.
   */
  async raydium(owner?: PublicKey): Promise<Raydium> {
    const raydium = await Raydium.load({
      connection: this.connection,
      owner,
      cluster: this.cluster,
      disableLoadToken: true,
      disableFeatureCheck: true,
      blockhashCommitment: "confirmed",
    });
    const api = raydium.api as unknown as Record<string, unknown>;
    api.fetchLaunchConfigs = () => this.launchConfigs();
    api.getTokenInfo = async () => [];
    api.getChainTimeOffset = async () => ({ offset: 0 });
    api.api = new Proxy(
      {},
      { get: (_t, prop) => () => Promise.reject(new Error(`unexpected Raydium API call (${String(prop)})`)) },
    );
    return raydium;
  }

  /** LaunchLab's default curve parameters (supply, amount sold on the curve, graduation target). */
  launchConfigs(): Promise<LaunchConfig[]> {
    this.launchConfigsCache ??= (async () => {
      let res: Response;
      try {
        res = await this.fetchImpl(LAUNCH_CONFIGS_URLS[this.cluster], { headers: { accept: "application/json" } });
      } catch (err) {
        this.launchConfigsCache = undefined;
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
          throw new TimeoutError("Raydium's launch config API timed out");
        }
        throw new NetworkError(err instanceof Error ? err.message : "Raydium's launch config API is unreachable");
      }
      if (!res.ok) {
        this.launchConfigsCache = undefined;
        throw new HigherError(`Raydium's launch config API answered HTTP ${res.status}`, { status: res.status });
      }
      const body = (await res.json()) as { data?: { data?: LaunchConfig[] } };
      return body.data?.data ?? [];
    })();
    return this.launchConfigsCache;
  }

  async launchConfig(): Promise<LaunchConfig> {
    const id = this.addresses.launchLabSolConfig;
    const found = (await this.launchConfigs()).find((c) => c.key.pubKey === id);
    if (!found) throw new HigherError(`Raydium publishes no defaults for LaunchLab config ${id}`, { code: "unavailable" });
    return found;
  }

  launchPoolId(mint: PublicKey): PublicKey {
    return getPdaLaunchpadPoolId(this.key("launchLabProgram"), mint, WSOL).publicKey;
  }

  /** The CPMM pool a graduated coin trades in, on higher.fun's fee tier. */
  graduatedPoolId(mint: PublicKey): PublicKey {
    const [a, b] = [mint, WSOL].sort((x, y) => Buffer.compare(x.toBuffer(), y.toBuffer()));
    return getCpmmPdaPoolId(this.key("cpmmProgram"), this.key("cpmmConfig"), a!, b!).publicKey;
  }

  async platform(platformId: PublicKey): Promise<PlatformState> {
    const info = await this.connection.getAccountInfo(platformId);
    if (!info) throw new HigherError(`platform config ${platformId.toBase58()} not found on ${this.cluster}`, { code: "unavailable" });
    if (!info.owner.equals(this.key("launchLabProgram"))) {
      throw new HigherError(`platform config ${platformId.toBase58()} is not owned by LaunchLab`, { code: "unsafe" });
    }
    return PlatformConfig.decode(info.data);
  }

  /** Reads the coin's LaunchLab pool and, once it has graduated, its CPMM pool. */
  async market(mint: PublicKey): Promise<Market> {
    const launchPoolId = this.launchPoolId(mint);
    const info = await this.connection.getAccountInfo(launchPoolId);
    if (!info || !info.owner.equals(this.key("launchLabProgram"))) {
      throw new ValidationError(`${mint.toBase58()} did not launch on Raydium LaunchLab on ${this.cluster}, so it isn't a higher.fun coin`, {
        code: "not_higher_coin",
      });
    }
    const pool = LaunchpadPool.decode(info.data);
    const mode = feeModeOfPlatform(this.cluster, pool.platformId.toBase58());
    if (!mode) {
      throw new ValidationError(
        `${mint.toBase58()} launched on another LaunchLab platform (${pool.platformId.toBase58()}), not higher.fun`,
        { code: "not_higher_coin" },
      );
    }
    if (pool.status === 2) {
      const poolId = this.graduatedPoolId(mint);
      const [cp, cfg] = await this.connection.getMultipleAccountsInfo([poolId, this.key("cpmmConfig")]);
      if (!cp || !cp.owner.equals(this.key("cpmmProgram")) || !cfg) {
        throw new HigherError(`graduated coin ${mint.toBase58()} has no CPMM pool on higher.fun's fee tier`, { code: "unavailable" });
      }
      const cpPool = CpmmPoolInfoLayout.decode(cp.data);
      if (!cpPool.configId.equals(this.key("cpmmConfig"))) {
        throw new HigherError("the coin's pool is not on higher.fun's CPMM fee tier", { code: "unsafe" });
      }
      return { stage: "graduated", mint, mode, launchPoolId, poolId, pool: cpPool, config: CpmmConfigInfoLayout.decode(cfg.data) };
    }
    const [cfg, plat] = await this.connection.getMultipleAccountsInfo([pool.configId, pool.platformId]);
    if (!cfg || !plat) throw new HigherError("LaunchLab config or platform account missing", { code: "unavailable" });
    return {
      stage: pool.status === 0 ? "curve" : "migrating",
      mint,
      mode,
      poolId: launchPoolId,
      pool,
      config: LaunchpadConfig.decode(cfg.data),
      platform: PlatformConfig.decode(plat.data),
    };
  }

  async lookupTables(txs: VersionedTransaction[]): Promise<AddressLookupTableAccount[]> {
    const keys = [...new Set(txs.flatMap((t) => t.message.addressTableLookups.map((l) => l.accountKey.toBase58())))];
    return Promise.all(
      keys.map(async (k) => {
        const { value } = await this.connection.getAddressLookupTable(new PublicKey(k));
        if (!value) throw new HigherError(`lookup table ${k} not found`, { code: "unavailable" });
        return value;
      }),
    );
  }
}
