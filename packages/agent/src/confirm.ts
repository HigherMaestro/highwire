import type { Connection } from "@solana/web3.js";

// Confirmation by polling the signature's status, with no websocket. web3.js's confirmTransaction subscribes over a
// websocket, and public RPCs cap those: a refused subscription errors where nothing can catch it and ends the process
// (it did, on devnet's public RPC, mid-series). Polling costs a call every second and a half and can't crash anything.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolves once `signature` is confirmed; throws if it failed on-chain, or once its blockhash has expired without it
 * (after one last look through the history, in case it landed in the final blocks), or after `timeoutMs`. RPC errors
 * while polling (a 429, a dropped connection) just mean "ask again".
 */
export async function confirmByPolling(connection: Connection, signature: string, lastValidBlockHeight: number, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<void> {
  const interval = opts.intervalMs ?? 1_500;
  const until = Date.now() + (opts.timeoutMs ?? 150_000);
  for (let poll = 0; ; poll++) {
    const status = await connection.getSignatureStatuses([signature]).then((r) => r.value[0], () => undefined);
    if (status?.err) throw new Error(JSON.stringify(status.err));
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return;
    if (poll % 4 === 3 || Date.now() > until) {
      const height = await connection.getBlockHeight("confirmed").catch(() => undefined);
      if ((height !== undefined && height > lastValidBlockHeight) || Date.now() > until) {
        const last = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true }).then((r) => r.value[0], () => undefined);
        if (last?.err) throw new Error(JSON.stringify(last.err));
        if (last && last.confirmationStatus !== "processed") return;
        throw new Error(height !== undefined && height > lastValidBlockHeight ? "its blockhash expired before it confirmed" : "no confirmation in time");
      }
    }
    await sleep(interval);
  }
}
