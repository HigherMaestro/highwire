import { HigherError, NetworkError } from "../lib/errors.ts";
import type { Coin, TapeEntry, Trade } from "./api.ts";
import { coinUrl, DEFAULT_API_URL } from "./constants.ts";
import { baseToTokens, lamportsToSol, priceSol } from "./format.ts";

// higher.fun's live feed, wss://api.higher.fun/ws: the socket its own site uses for the tape, new coins, graduations
// and each coin's trades. Send {op: "subscribe", channel}; messages are JSON with a `type` and the `channel`.
// Channels: `tape` (every launch, buy, sell and graduation, without the wallet), `coins:new`, `coins:graduated` and
// `trades:<mint>` (one coin's trades, with the wallet). No sign-in.

export const LIVE_EVENT_KINDS = ["launch", "graduation", "buy", "sell"] as const;
export type LiveEventKind = (typeof LIVE_EVENT_KINDS)[number];

/** higher.fun's site keeps at most 20 channels open on one socket; one per coin, plus the shared ones, stays inside it. */
export const MAX_LIVE_MINTS = 16;

export interface LiveFilter {
  kinds: readonly LiveEventKind[];
  /** Only these coins' trades and graduations, with the trader's wallet. Launches are new coins, so always pass. */
  mints?: readonly string[];
  /** Only buys and sells of at least this much SOL. */
  minSol?: number;
}

export type LiveEvent =
  | { kind: "launch"; mint: string; name: string; ticker: string; creator: string; url: string; at: string }
  | { kind: "graduation"; mint: string; poolId: string; url: string; at: string }
  | {
      kind: "buy" | "sell";
      mint: string;
      ticker?: string;
      sol: number | null;
      tokens?: number | null;
      priceSol: number | null;
      wallet?: string;
      signature: string;
      url: string;
      at: string;
    };

/** What LiveFeed needs of a WebSocket: the browser API, which Node has had built in since 22. */
export interface LiveSocket {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  readonly readyState: number;
  send(data: string): void;
  close(): void;
}
export type LiveSocketFactory = (url: string) => LiveSocket;

export type LiveStatus = "connecting" | "open" | "reconnecting";

/** The feed's address for an API base URL: https://api.higher.fun becomes wss://api.higher.fun/ws. */
export function liveUrlFor(apiUrl = DEFAULT_API_URL): string {
  const u = new URL(apiUrl);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  u.pathname = u.pathname.replace(/\/$/, "") + "/ws";
  return u.toString();
}

/** The channels a filter needs: buys and sells come from each coin's channel when there are coins, else the tape. */
export function liveChannels(filter: LiveFilter): string[] {
  const kinds = new Set(filter.kinds);
  const channels: string[] = [];
  if (kinds.has("launch")) channels.push("coins:new");
  if (kinds.has("graduation")) channels.push("coins:graduated");
  if (kinds.has("buy") || kinds.has("sell")) {
    if (filter.mints?.length) channels.push(...[...new Set(filter.mints)].map((m) => `trades:${m}`));
    else channels.push("tape");
  }
  return channels;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const has = <K extends string>(o: Record<string, unknown>, keys: K[]): o is Record<K, string> => keys.every((k) => isString(o[k]));

/** One feed message as a LiveEvent, or null for anything this filter doesn't want or that doesn't parse. */
export function parseLiveMessage(raw: unknown, filter: LiveFilter, now = () => new Date()): LiveEvent | null {
  let msg: unknown;
  try {
    msg = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  if (!isObject(msg)) return null;
  const kinds = new Set(filter.kinds);
  const mints = filter.mints?.length ? new Set(filter.mints) : null;
  const bigEnough = (sol: number | null) => filter.minSol === undefined || (sol !== null && sol >= filter.minSol);

  switch (msg.type) {
    case "coin:new": {
      const c = msg.coin;
      if (!kinds.has("launch") || !isObject(c) || !has(c, ["mint", "name", "ticker", "creator", "createdAt"])) return null;
      const coin = c as unknown as Coin;
      return { kind: "launch", mint: coin.mint, name: coin.name, ticker: coin.ticker, creator: coin.creator, url: coinUrl(coin.mint), at: coin.createdAt };
    }
    case "coin:graduated": {
      if (!kinds.has("graduation") || !has(msg, ["mint", "poolId"]) || (mints && !mints.has(msg.mint))) return null;
      return { kind: "graduation", mint: msg.mint, poolId: msg.poolId, url: coinUrl(msg.mint), at: now().toISOString() };
    }
    case "trade": {
      const t = msg.trade;
      if (!isObject(t) || !has(t, ["signature", "mint", "wallet", "side", "quoteAmount", "tokenAmount", "price", "blockTime"])) return null;
      const trade = t as unknown as Trade;
      if ((trade.side !== "buy" && trade.side !== "sell") || !kinds.has(trade.side) || (mints && !mints.has(trade.mint))) return null;
      const sol = lamportsToSol(trade.quoteAmount, 6);
      if (!bigEnough(sol)) return null;
      return {
        kind: trade.side,
        mint: trade.mint,
        sol,
        tokens: baseToTokens(trade.tokenAmount),
        priceSol: priceSol(trade.price),
        wallet: trade.wallet,
        signature: trade.signature,
        url: coinUrl(trade.mint),
        at: trade.blockTime,
      };
    }
    case "tape": {
      // Only buys and sells: launches and graduations come from their own channels, with more detail.
      const e = msg.event;
      if (!isObject(e) || !has(e, ["id", "kind", "mint", "ticker", "at"])) return null;
      const entry = e as unknown as TapeEntry;
      if ((entry.kind !== "buy" && entry.kind !== "sell") || !kinds.has(entry.kind) || mints) return null;
      const sol = lamportsToSol(isString(entry.quoteAmount) ? entry.quoteAmount : null, 6);
      if (!bigEnough(sol)) return null;
      return {
        kind: entry.kind,
        mint: entry.mint,
        ticker: entry.ticker,
        sol,
        priceSol: priceSol(isString(entry.price) ? entry.price : null),
        // The tape's id is the transaction signature and the instruction's index.
        signature: entry.id.split(":")[0]!,
        url: coinUrl(entry.mint),
        at: entry.at,
      };
    }
    default:
      return null;
  }
}

export interface WatchOptions {
  signal: AbortSignal;
  onStatus?: (status: LiveStatus) => void;
}

export interface CollectOptions {
  waitMs: number;
  maxEvents: number;
  signal?: AbortSignal;
  onEvent?: (event: LiveEvent, count: number) => void;
}

export interface Collected {
  events: LiveEvent[];
  ended: "max_events" | "time_up" | "cancelled";
  /** Times the socket dropped and came back during the wait: events in those gaps were missed. */
  reconnects: number;
}

/** A connection to higher.fun's live feed. Each watch opens its own socket, and reconnects until it's stopped. */
export class LiveFeed {
  constructor(
    readonly url = liveUrlFor(),
    private readonly socket?: LiveSocketFactory,
  ) {}

  private open(): LiveSocket {
    if (this.socket) return this.socket(this.url);
    const WS = (globalThis as { WebSocket?: new (url: string) => LiveSocket }).WebSocket;
    if (!WS) throw new HigherError("The live feed needs a WebSocket, built into Node 22 and later.", { code: "live_unavailable" });
    return new WS(this.url);
  }

  /**
   * Deliver every event that matches until `signal` aborts, reconnecting with backoff when the socket drops.
   * Resolves once it's stopped.
   */
  watch(filter: LiveFilter, onEvent: (event: LiveEvent) => void, { signal, onStatus }: WatchOptions): Promise<void> {
    const channels = liveChannels(filter);
    return new Promise((resolve, reject) => {
      if (signal.aborted || channels.length === 0) return resolve();
      let ws: LiveSocket | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let failures = 0;
      const stop = () => {
        clearTimeout(timer);
        const s = ws;
        ws = null;
        s?.close();
        resolve();
      };
      signal.addEventListener("abort", stop, { once: true });
      const connect = () => {
        if (signal.aborted) return;
        onStatus?.(failures ? "reconnecting" : "connecting");
        let s: LiveSocket;
        try {
          s = this.open();
        } catch (err) {
          signal.removeEventListener("abort", stop);
          return reject(err);
        }
        ws = s;
        s.onopen = () => {
          if (ws !== s) return;
          failures = 0;
          for (const channel of channels) s.send(JSON.stringify({ op: "subscribe", channel }));
          onStatus?.("open");
        };
        s.onmessage = (ev) => {
          if (ws !== s) return;
          const event = parseLiveMessage(ev.data, filter);
          if (event) onEvent(event);
        };
        s.onerror = () => {};
        s.onclose = () => {
          if (ws !== s || signal.aborted) return;
          ws = null;
          failures += 1;
          // The same backoff as higher.fun's site: 2, 4, 8, then 16 seconds at most, jittered.
          const delay = Math.min(15_000, 1000 * 2 ** Math.min(failures, 4)) * (0.7 + 0.6 * Math.random());
          onStatus?.("reconnecting");
          timer = setTimeout(connect, delay);
        };
      };
      connect();
    });
  }

  /**
   * Wait up to `waitMs` and return what matched, early once there are `maxEvents`. Throws a NetworkError if the
   * socket never opened, so silence is never mistaken for a quiet market.
   */
  async collect(filter: LiveFilter, { waitMs, maxEvents, signal, onEvent }: CollectOptions): Promise<Collected> {
    const events: LiveEvent[] = [];
    const ctl = new AbortController();
    // Set from the callbacks below, so TypeScript can't follow it.
    let ended = "time_up" as Collected["ended"];
    let opened = 0;
    const timer = setTimeout(() => ctl.abort(), waitMs);
    const cancel = () => {
      ended = "cancelled";
      ctl.abort();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await this.watch(
        filter,
        (event) => {
          if (events.length >= maxEvents) return;
          events.push(event);
          onEvent?.(event, events.length);
          if (events.length >= maxEvents) {
            ended = "max_events";
            ctl.abort();
          }
        },
        { signal: ctl.signal, onStatus: (s) => s === "open" && (opened += 1) },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
    if (opened === 0 && ended !== "cancelled") throw new NetworkError("Couldn't connect to higher.fun's live feed.");
    return { events, ended, reconnects: Math.max(0, opened - 1) };
  }
}
