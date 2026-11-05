import { readFileSync } from "node:fs";

// Replays one of highwire-core's recorded mainnet fixtures, so a build tool can
// run end to end offline. The fixtures are data; the format is described in
// packages/core/test/replay.ts. JSON-RPC calls are keyed by method and params
// (simulateTransaction by method only), HTTP GETs by URL.

type Recording = Record<string, unknown[]>;

export function fixtureFetch(name: string): typeof globalThis.fetch {
  const recording: Recording = JSON.parse(readFileSync(new URL(`../../core/test/fixtures/${name}.json`, import.meta.url), "utf8"));
  const used = new Map<string, number>();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    let key = `get:${url}`;
    let id: unknown;
    if (typeof body === "string" && body.startsWith("{")) {
      const rpc = JSON.parse(body) as { method?: string; params?: unknown; id?: unknown };
      if (rpc.method) {
        key = rpc.method === "simulateTransaction" ? `rpc:${rpc.method}` : `rpc:${rpc.method}:${JSON.stringify(rpc.params ?? [])}`;
        id = rpc.id;
      }
    }
    const list = recording[key];
    if (!list?.length) throw new Error(`no recorded response for ${key.slice(0, 200)}`);
    const i = used.get(key) ?? 0;
    used.set(key, i + 1);
    let out = list[Math.min(i, list.length - 1)];
    if (id !== undefined && out && typeof out === "object" && "jsonrpc" in out) out = { ...out, id };
    return new Response(typeof out === "string" ? out : JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
}
