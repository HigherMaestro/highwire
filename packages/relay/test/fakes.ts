import { FakeClock } from "../src/clock.ts";
import { createRelay, type Relay } from "../src/http.ts";
import { randomHex, sha256Hex } from "../src/registration.ts";
import { MemoryStore } from "../src/store.ts";
import { FakeCoins, FakeRpc, launchTx, memoTx, MINT, WALLET } from "../src/testing.ts";

// The relay's test rig: the fakes from src/testing.ts, wired into a relay with an in-memory store and a clock that
// moves only when told to.

export * from "../src/testing.ts";

export interface Rig {
  clock: FakeClock;
  store: MemoryStore;
  rpc: FakeRpc;
  coins: FakeCoins;
  relay: Relay;
  /** Calls a route; returns the status and parsed body, and keeps the raw text for leak checks. */
  call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: any; text: string }>;
  /** Moves time forward, with the cron's sweep running every minute as it does in production. */
  advance(ms: number): Promise<void>;
  /** Registers a coin end to end and returns its arena token. */
  register(mint?: string, wallet?: string): Promise<string>;
}

export const CRON = "cron-secret";

export function rig(): Rig {
  const clock = new FakeClock();
  const store = new MemoryStore(clock);
  const rpc = new FakeRpc();
  const coins = new FakeCoins(clock.now());
  const relay = createRelay({ store, clock, rpc, coins, cronSecret: CRON });
  const call: Rig["call"] = async (method, path, body, token) => {
    const res = await relay.fetch(
      new Request(`https://relay.test${path}`, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text };
  };
  const advance: Rig["advance"] = async (ms) => {
    let left = ms;
    while (left > 0) {
      const step = Math.min(60_000, left);
      clock.advance(step);
      left -= step;
      if (!store.down) await call("POST", "/api/arena/sweep", undefined, CRON);
    }
  };
  const register: Rig["register"] = async (mint = MINT, wallet = WALLET) => {
    const secret = randomHex();
    const launch = rpc.add(launchTx({ payer: wallet, mint }));
    const ch = await call("POST", "/api/agents/challenge", { wallet, mint, launchSignature: launch, secretHash: sha256Hex(secret) });
    if (ch.status !== 200) throw new Error(ch.text);
    const memo = rpc.add(memoTx(wallet, ch.body.memo, clock.now() + 5000));
    const reg = await call("POST", "/api/agents/register", { code: ch.body.code, signature: memo, secret });
    if (reg.status !== 200) throw new Error(reg.text);
    return reg.body.arenaToken as string;
  };
  // The sweep runs from the start, as the cron would.
  return { clock, store, rpc, coins, relay, call, advance, register };
}
