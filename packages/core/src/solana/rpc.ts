import { HigherError, NetworkError, TimeoutError } from "../lib/errors.js";

// The few Solana JSON-RPC reads the server needs, over plain fetch so the
// read-only server carries no Solana SDK.

export interface MintInfo {
  mint: string;
  tokenProgram: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: string;
  decimals: number;
}

export class SolanaRpc {
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 15_000,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new TimeoutError(`Solana RPC timed out after ${this.timeoutMs}ms`);
      }
      throw new NetworkError(err instanceof Error ? err.message : "Solana RPC request failed");
    } finally {
      clearTimeout(timeoutId);
    }
    if (!res.ok) throw new HigherError(`Solana RPC answered HTTP ${res.status}`, { status: res.status });
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new HigherError(`Solana RPC: ${body.error.message}`, { code: String(body.error.code) });
    return body.result as T;
  }

  async mintInfo(mint: string): Promise<MintInfo | null> {
    type Parsed = {
      value: {
        owner: string;
        data: { parsed?: { type: string; info: Record<string, unknown> } };
      } | null;
    };
    const result = await this.call<Parsed>("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
    const parsed = result.value?.data.parsed;
    if (!result.value || !parsed || parsed.type !== "mint") return null;
    const info = parsed.info;
    return {
      mint,
      tokenProgram: result.value.owner,
      mintAuthority: (info.mintAuthority as string | null) ?? null,
      freezeAuthority: (info.freezeAuthority as string | null) ?? null,
      supply: String(info.supply),
      decimals: Number(info.decimals),
    };
  }
}
