// Records and replays network responses, so the transaction tests run offline
// against real mainnet state. A recording maps a request key to the responses
// it got, in order: JSON-RPC calls are keyed by method and params (the request
// id is random), HTTP GETs by URL. simulateTransaction is keyed by method only,
// because Raydium's SDK seeds its temporary wrapped-SOL account at random.

export type Recording = Record<string, unknown[]>;

const METHOD_ONLY = new Set(["simulateTransaction"]);

async function keyOf(input: string | URL | Request, init?: RequestInit): Promise<{ key: string; rpcId?: unknown }> {
  const url = String(input instanceof Request ? input.url : input);
  const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  if (typeof body === "string" && body.startsWith("{")) {
    const rpc = JSON.parse(body) as { method?: string; params?: unknown; id?: unknown };
    if (rpc.method) {
      return { key: METHOD_ONLY.has(rpc.method) ? `rpc:${rpc.method}` : `rpc:${rpc.method}:${JSON.stringify(rpc.params ?? [])}`, rpcId: rpc.id };
    }
  }
  return { key: `get:${url}` };
}

/** Wraps a real fetch and records every response into `recording`. */
export function recordingFetch(recording: Recording, real: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const { key } = await keyOf(input, init);
    const res = await real(input, init);
    const text = await res.clone().text();
    if (res.ok) {
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep text */
      }
      // Rate-limited RPC answers aren't worth replaying.
      if (!(parsed && typeof parsed === "object" && "error" in parsed && (parsed as { error?: { code?: number } }).error?.code === 429)) {
        (recording[key] ??= []).push(parsed);
      }
    }
    return res;
  }) as typeof globalThis.fetch;
}

/**
 * Answers from a recording. Each key's responses are served in order and the
 * last one repeats. An unknown key fails loudly, so a test never reaches the network.
 */
export function replayFetch(recording: Recording, overrides: Record<string, unknown> = {}): typeof globalThis.fetch {
  const used = new Map<string, number>();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const { key, rpcId } = await keyOf(input, init);
    let body: unknown;
    if (key in overrides) body = overrides[key];
    else {
      const list = recording[key];
      if (!list?.length) throw new Error(`no recorded response for ${key.slice(0, 200)}`);
      const i = used.get(key) ?? 0;
      used.set(key, i + 1);
      body = list[Math.min(i, list.length - 1)];
    }
    if (rpcId !== undefined && body && typeof body === "object" && "jsonrpc" in body) body = { ...body, id: rpcId };
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}
