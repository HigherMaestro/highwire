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
 * The Solana RPC URL, tolerating stray whitespace or quotes from a copy-paste. A value that still isn't an http(s) URL
 * falls back to the public RPC with a warning, rather than taking every request down. The value is never logged: it
 * usually carries an API key.
 */
export function rpcUrlEnv(env: Env, name = "SOLANA_RPC_URL", warn: (msg: string) => void = console.warn): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const v = raw.trim().replace(/^["']|["']$/g, "").trim();
  if (v === "") return undefined;
  try {
    const u = new URL(v);
    if (u.protocol === "https:" || u.protocol === "http:") return v;
  } catch {
    // fall through to the warning
  }
  warn(`[highwire] ${name} isn't an http(s) URL (it should start with https://), so the public RPC is used instead.`);
  return undefined;
}

/**
 * Server options from HIGHER_API_URL, SOLANA_RPC_URL, HIGHWIRE_CLUSTER, HIGHWIRE_MAX_SOL_PER_TX, HIGHER_TIMEOUT_MS,
 * HIGHER_RETRIES, HIGHWIRE_SITE_URL, HIGHWIRE_LAUNCH_SECRET, HIGHWIRE_ARENA and HIGHWIRE_RELAY_URL.
 */
export function serverOptionsFromEnv(env: Env = process.env): ServerOptions {
  const maxSol = numberEnv(env, "HIGHWIRE_MAX_SOL_PER_TX");
  if (maxSol === 0) throw new Error("HIGHWIRE_MAX_SOL_PER_TX must be more than 0");
  return {
    apiUrl: env.HIGHER_API_URL || undefined,
    rpcUrl: rpcUrlEnv(env),
    cluster: clusterEnv(env),
    maxSolPerTx: maxSol,
    timeoutMs: numberEnv(env, "HIGHER_TIMEOUT_MS"),
    retries: numberEnv(env, "HIGHER_RETRIES"),
    siteUrl: urlEnv(env, "HIGHWIRE_SITE_URL"),
    launchKeySecret: env.HIGHWIRE_LAUNCH_SECRET || undefined,
    // The arena isn't public yet: its tools are off unless this is set.
    arena: env.HIGHWIRE_ARENA === "1",
    relayUrl: urlEnv(env, "HIGHWIRE_RELAY_URL"),
  };
}
