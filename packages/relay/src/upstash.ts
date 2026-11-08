import { RelayError } from "./errors.ts";
import { paused, type Store, type Stored } from "./store.ts";

// The Store on Upstash Redis, over its REST API (no client library: one fetch per command). Each document is a hash
// with its version `v` and its JSON `d`, so compare-and-set is one short Lua script that reads only the version. Any
// failure to reach Upstash is `paused`: the referee fails closed and stops clocks.

/** Writes `d` at version `v+1` if the key is still at `v` (0: absent); 0 when someone else wrote first. */
export const CAS_SCRIPT = `local cur = tonumber(redis.call('HGET', KEYS[1], 'v') or '0')
if cur ~= tonumber(ARGV[1]) then return 0 end
local nv = cur + 1
redis.call('HSET', KEYS[1], 'v', nv, 'd', ARGV[2])
if tonumber(ARGV[3]) > 0 then redis.call('EXPIRE', KEYS[1], ARGV[3]) else redis.call('PERSIST', KEYS[1]) end
return nv`;

/** Adds to a counter, setting its expiry when it's first made. */
export const INCR_SCRIPT = `local n = redis.call('INCRBY', KEYS[1], ARGV[1])
if n == tonumber(ARGV[1]) then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return n`;

export interface UpstashOptions {
  url: string;
  token: string;
  /** Keys are stored under this prefix, so one database could serve more than one thing. Default "line:". */
  prefix?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class UpstashStore implements Store {
  private url: string;
  private prefix: string;
  private timeoutMs: number;
  private f: typeof globalThis.fetch;
  /** Commands sent, to check the budget. */
  commands = 0;

  constructor(private o: UpstashOptions) {
    this.url = o.url.replace(/\/+$/, "");
    this.prefix = o.prefix ?? "line:";
    this.timeoutMs = o.timeoutMs ?? 5000;
    this.f = o.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  private async run<T>(command: (string | number)[]): Promise<T> {
    this.commands++;
    let res: Response;
    try {
      res = await this.f(this.url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json" },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw paused();
    }
    if (!res.ok) throw paused();
    const body = (await res.json().catch(() => null)) as { result?: T; error?: string } | null;
    if (!body || body.error !== undefined) throw paused();
    return body.result as T;
  }

  async get<T>(key: string): Promise<Stored<T> | null> {
    const [v, d] = await this.run<[string | null, string | null]>(["HMGET", this.prefix + key, "v", "d"]);
    if (v === null || d === null) return null;
    try {
      return { value: JSON.parse(d) as T, version: Number(v) };
    } catch {
      throw new RelayError("paused", "A stored document couldn't be read.");
    }
  }

  async cas<T>(key: string, version: number, value: T, ttlSeconds?: number): Promise<number | null> {
    const n = await this.run<number>(["EVAL", CAS_SCRIPT, 1, this.prefix + key, version, JSON.stringify(value), ttlSeconds ?? 0]);
    return n === 0 ? null : n;
  }

  async del(key: string): Promise<void> {
    await this.run(["DEL", this.prefix + key]);
  }

  async incr(key: string, by: number, ttlSeconds: number): Promise<number> {
    return this.run<number>(["EVAL", INCR_SCRIPT, 1, this.prefix + key, by, ttlSeconds]);
  }
}
