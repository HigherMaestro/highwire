import { CLUSTERS, type Cluster } from "highwire-core";
import type { ServerOptions } from "./server.ts";

type Env = Record<string, string | undefined>;

function numberEnv(env: Env, name: string): number | undefined {
  const v = env[name];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${v}"`);
  return n;
}

function clusterEnv(env: Env): Cluster | undefined {
  const v = env.HIGHWIRE_CLUSTER;
  if (v === undefined || v === "") return undefined;
  if (!(CLUSTERS as readonly string[]).includes(v)) throw new Error(`HIGHWIRE_CLUSTER must be ${CLUSTERS.join(" or ")}, got "${v}"`);
  return v as Cluster;
}

function urlEnv(env: Env, name: string): string | undefined {
  const v = env[name];
  if (v === undefined || v === "") return undefined;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${name} must be a URL, got "${v}"`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${name} must be an http(s) URL`);
  return u.origin;
}

/**
 * Server options from HIGHER_API_URL, SOLANA_RPC_URL, HIGHWIRE_CLUSTER, HIGHWIRE_MAX_SOL_PER_TX, HIGHER_TIMEOUT_MS,
 * HIGHER_RETRIES, HIGHWIRE_SITE_URL and HIGHWIRE_LAUNCH_SECRET.
 */
export function serverOptionsFromEnv(env: Env = process.env): ServerOptions {
  const maxSol = numberEnv(env, "HIGHWIRE_MAX_SOL_PER_TX");
  if (maxSol === 0) throw new Error("HIGHWIRE_MAX_SOL_PER_TX must be more than 0");
  return {
    apiUrl: env.HIGHER_API_URL || undefined,
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    cluster: clusterEnv(env),
    maxSolPerTx: maxSol,
    timeoutMs: numberEnv(env, "HIGHER_TIMEOUT_MS"),
    retries: numberEnv(env, "HIGHER_RETRIES"),
    siteUrl: urlEnv(env, "HIGHWIRE_SITE_URL"),
    launchKeySecret: env.HIGHWIRE_LAUNCH_SECRET || undefined,
  };
}
