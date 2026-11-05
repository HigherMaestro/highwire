import type { ServerOptions } from "./server.ts";

type Env = Record<string, string | undefined>;

function numberEnv(env: Env, name: string): number | undefined {
  const v = env[name];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${v}"`);
  return n;
}

/** Server options from HIGHER_API_URL, SOLANA_RPC_URL, HIGHER_TIMEOUT_MS and HIGHER_RETRIES. */
export function serverOptionsFromEnv(env: Env = process.env): ServerOptions {
  return {
    apiUrl: env.HIGHER_API_URL || undefined,
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    timeoutMs: numberEnv(env, "HIGHER_TIMEOUT_MS"),
    retries: numberEnv(env, "HIGHER_RETRIES"),
  };
}
