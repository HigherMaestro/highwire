import type { RegistrationRpc, RpcTransaction } from "./registration.ts";

// The two Solana RPC calls registration needs, over plain JSON-RPC: the genesis hash (to be sure it's mainnet) and a
// confirmed transaction in getTransaction's JSON shape.

export class JsonRpc implements RegistrationRpc {
  private f: typeof globalThis.fetch;
  constructor(
    private url: string,
    private timeoutMs = 10_000,
    f?: typeof globalThis.fetch,
  ) {
    this.f = f ?? ((input, init) => globalThis.fetch(input, init));
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.f(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`the RPC answered ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? "the RPC returned an error");
    return body.result as T;
  }

  genesisHash() {
    return this.call<string>("getGenesisHash", []);
  }

  getTransaction(signature: string) {
    return this.call<RpcTransaction | null>("getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  }
}
