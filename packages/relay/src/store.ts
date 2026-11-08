import { RelayError } from "./errors.ts";
import type { Clock } from "./clock.ts";

// The relay's state lives in one key-value store (Upstash Redis in production, its own database for the arena). The
// referee needs only these operations, each atomic on its own: versioned documents written by compare-and-set (one
// short Lua script in Redis), counters with an expiry, and deletes. Game logic runs in the relay, never in the store:
// read a document, compute, write it back only if nobody else wrote first, and retry otherwise.
//
// If the store doesn't answer, every operation throws `paused`: the relay fails closed and the referee stops clocks.

export interface Stored<T> {
  value: T;
  /** Bumped on every write; 0 never appears (it means "absent" to `cas`). */
  version: number;
}

export interface Store {
  get<T>(key: string): Promise<Stored<T> | null>;
  /** Writes `value` if the key is still at `version` (0: absent). Returns the new version, or null if someone wrote first. */
  cas<T>(key: string, version: number, value: T, ttlSeconds?: number): Promise<number | null>;
  del(key: string): Promise<void>;
  /** Adds `by` to a counter, creating it with this expiry if absent. Returns the new total. */
  incr(key: string, by: number, ttlSeconds: number): Promise<number>;
}

export const paused = () => new RelayError("paused", "The arena's store isn't answering. Moves are refused and clocks are stopped until it's back; nobody loses on time.");

/** An in-memory store with the same semantics, for tests and local runs. `down` makes it fail like an outage. */
export class MemoryStore implements Store {
  private data = new Map<string, { value: string; version: number; expires: number | null }>();
  down = false;
  /** How many operations it served, to check the budget. */
  ops = 0;

  constructor(private clock: Clock) {}

  private live(key: string) {
    const e = this.data.get(key);
    if (e && e.expires !== null && e.expires <= this.clock.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  private check() {
    if (this.down) throw paused();
    this.ops++;
  }

  async get<T>(key: string): Promise<Stored<T> | null> {
    this.check();
    const e = this.live(key);
    // A copy, as from a real store: callers can't change stored state without writing it.
    return e ? { value: JSON.parse(e.value) as T, version: e.version } : null;
  }

  async cas<T>(key: string, version: number, value: T, ttlSeconds?: number): Promise<number | null> {
    this.check();
    const e = this.live(key);
    if ((e?.version ?? 0) !== version) return null;
    const next = version + 1;
    this.data.set(key, { value: JSON.stringify(value), version: next, expires: ttlSeconds ? this.clock.now() + ttlSeconds * 1000 : null });
    return next;
  }

  async del(key: string): Promise<void> {
    this.check();
    this.data.delete(key);
  }

  async incr(key: string, by: number, ttlSeconds: number): Promise<number> {
    this.check();
    const e = this.live(key);
    const n = (e ? Number(JSON.parse(e.value)) : 0) + by;
    this.data.set(key, { value: JSON.stringify(n), version: (e?.version ?? 0) + 1, expires: e?.expires ?? this.clock.now() + ttlSeconds * 1000 });
    return n;
  }

  /** Every key, for tests that look for leaks. */
  dump(): Record<string, unknown> {
    return Object.fromEntries([...this.data].map(([k, v]) => [k, JSON.parse(v.value)]));
  }
}

/**
 * Reads a document, applies `change` and writes it back if nobody wrote in between, retrying a few times. `change`
 * returns the new value, or undefined to leave it as it is. Returns the value now stored (or null when absent).
 */
export async function update<T>(store: Store, key: string, change: (current: T | null) => T | undefined, ttlSeconds?: number): Promise<T | null> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await store.get<T>(key);
    const next = change(cur ? cur.value : null);
    if (next === undefined) return cur ? cur.value : null;
    if ((await store.cas(key, cur?.version ?? 0, next, ttlSeconds)) !== null) return next;
  }
  throw new RelayError("conflict", "Too many writes at once; try again.");
}
