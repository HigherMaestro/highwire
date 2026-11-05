import type { Cluster } from "highwire-core/browser";

// The few Solana JSON-RPC calls the signing page makes, straight from the
// browser to the RPC: never through Highwire's server. The CSP for /sign only
// allows connections to these origins.

export const PUBLIC_RPC_URLS: Record<Cluster, string> = {
  mainnet: "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
};

/** The RPC the page uses for a cluster: NEXT_PUBLIC_SOLANA_RPC_URL (mainnet) or NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL. */
export function rpcUrlFor(cluster: Cluster): string {
  const configured = cluster === "mainnet" ? process.env.NEXT_PUBLIC_SOLANA_RPC_URL : process.env.NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL;
  return configured || PUBLIC_RPC_URLS[cluster];
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

let nextId = 1;

export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      // No cookies or referrer to the RPC: it only needs the call.
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new RpcError(`The Solana RPC didn't answer (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (res.status === 429) throw new RpcError("The Solana RPC is rate-limiting this browser. Wait a few seconds and try again.", 429);
  if (res.status === 403) {
    // Solana's public mainnet endpoint refuses every request that comes from a web page.
    throw new RpcError(
      `The Solana RPC at ${new URL(url).host} refused this page (HTTP 403). This site needs its own RPC endpoint ` +
        "(NEXT_PUBLIC_SOLANA_RPC_URL); until then, sign with the transaction's base64 in another wallet tool.",
      403,
    );
  }
  if (!res.ok) throw new RpcError(`The Solana RPC answered HTTP ${res.status}.`, res.status);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new RpcError(body.error.message, body.error.code);
  return body.result as T;
}

export interface AccountInfo {
  owner: string;
  lamports: number;
  data: [string, "base64"];
}

export async function getAccountInfo(url: string, address: string): Promise<AccountInfo | null> {
  const r = await rpc<{ value: AccountInfo | null }>(url, "getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
  return r.value;
}

export const getBlockHeight = (url: string) => rpc<number>(url, "getBlockHeight", [{ commitment: "confirmed" }]);

export async function getLatestBlockhash(url: string): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  return (await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>(url, "getLatestBlockhash", [{ commitment: "confirmed" }])).value;
}

export async function getBalance(url: string, address: string): Promise<number> {
  return (await rpc<{ value: number }>(url, "getBalance", [address, { commitment: "confirmed" }])).value;
}

export interface SimulationResult {
  ok: boolean;
  error?: string;
  /** The blockhash has expired, or the RPC hasn't seen it. */
  expired?: boolean;
  unitsConsumed?: number;
  /** Lamports: the wallet's balance after the transaction, minus before. */
  netLamports?: number;
  logs: string[];
  at: number;
}

function simulationError(err: unknown, logs: string[]): string {
  const rev = [...logs].reverse();
  const line = rev.find((l) => /^Program log: (AnchorError|Error)/.test(l)) ?? rev.find((l) => /Error|failed|insufficient/i.test(l));
  return (line?.replace(/^Program log: /, "") ?? (typeof err === "string" ? err : JSON.stringify(err))).slice(0, 300);
}

/**
 * Simulates the transaction exactly as it is: no signature check (the wallet hasn't signed yet), and with its own
 * blockhash, so an expired one fails here instead of in the wallet.
 */
export async function simulate(url: string, base64: string, wallet: string): Promise<SimulationResult> {
  const [before, r] = await Promise.all([
    getBalance(url, wallet),
    rpc<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number; accounts?: ({ lamports: number } | null)[] } }>(
      url,
      "simulateTransaction",
      [
        base64,
        {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: false,
          commitment: "confirmed",
          accounts: { encoding: "base64", addresses: [wallet] },
        },
      ],
    ),
  ]);
  const logs = r.value.logs ?? [];
  const after = r.value.accounts?.[0]?.lamports;
  if (r.value.err) {
    const expired = r.value.err === "BlockhashNotFound" || JSON.stringify(r.value.err).includes("BlockhashNotFound");
    return { ok: false, expired, error: expired ? "The blockhash has expired." : simulationError(r.value.err, logs), logs: logs.slice(-12), at: Date.now() };
  }
  return {
    ok: true,
    unitsConsumed: r.value.unitsConsumed,
    netLamports: after === undefined ? undefined : after - before,
    logs: [],
    at: Date.now(),
  };
}

export async function sendRaw(url: string, bytes: Uint8Array): Promise<string> {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return rpc<string>(url, "sendTransaction", [btoa(bin), { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }]);
}

export type Confirmation = { status: "confirmed" } | { status: "failed"; error: string } | { status: "expired" };

/** Polls until the signature is confirmed, fails, or its blockhash expires. Plain HTTP, no websocket. */
export async function confirm(url: string, signature: string, lastValidBlockHeight: number, signal?: AbortSignal): Promise<Confirmation> {
  for (;;) {
    if (signal?.aborted) throw new Error("stopped");
    const r = await rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>(url, "getSignatureStatuses", [
      [signature],
      { searchTransactionHistory: false },
    ]);
    const s = r.value[0];
    if (s?.err) return { status: "failed", error: JSON.stringify(s.err) };
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return { status: "confirmed" };
    if (!s && (await getBlockHeight(url)) > lastValidBlockHeight) return { status: "expired" };
    await new Promise((res) => setTimeout(res, 2000));
  }
}
