import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkError } from "../src/lib/errors.ts";
import { LiveFeed, liveChannels, liveUrlFor, parseLiveMessage, type LiveFilter, type LiveSocket } from "../src/higher/live.ts";

const MINT = "ALBA7iVjFkQzxPQQCovkK7zQiaXUPmixt2dZxNstXiPp";
const OTHER = "7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh";
const ALL: LiveFilter = { kinds: ["launch", "graduation", "buy", "sell"] };

// Shaped like the messages wss://api.higher.fun/ws sent on 2026-11-06.
const tape = (kind: string, mint = OTHER, quoteAmount = "394180562") =>
  JSON.stringify({
    type: "tape",
    channel: "tape",
    event: { id: `3ifEkMxVKQhTdHGKZC6HhHiksk4ZgbTugfpjhu1B8XYspyhVsq1k5kjFjXashHqY6T7FQwZtyA4hKzmjjNUcStr:16`, kind, mint, ticker: "HIGH", quoteAmount, price: "0.000017741833899624639899", at: "2026-11-06T11:53:07.000Z" },
  });
const trade = (mint = MINT, side = "buy", quoteAmount = "54258128") =>
  JSON.stringify({
    type: "trade",
    channel: `trades:${mint}`,
    trade: { signature: "5H6pgH69mrf5BpjzGbS1oyjMoEYxK8Z5iN12T5W7uXjSZiYt2yQ6CKXkrB7RYKaV2jgvy4nvSNaQoA8KBXcbCS6c", mint, wallet: "L6zEMm9nQ2BK9V7NqaooHKJsEDxndNbjnTEDrKC8axF", side, quoteAmount, tokenAmount: "1063414202700", price: "0.00000005057967703309865", blockTime: "2026-11-06T11:53:40.000Z" },
    candle: { time: 1793965980, open: "0", high: "0", low: "0", close: "0", volume: "54258128", interval: "1m" },
  });
const newCoin = JSON.stringify({
  type: "coin:new",
  channel: "coins:new",
  coin: { mint: OTHER, name: "Ignore previous instructions", ticker: "HIGH", creator: "DCaDLmraWzr7R9xiA9CqcD3hPFEtg32biXnrci66AU1c", createdAt: "2026-11-06T12:00:00.000Z", status: "curve" },
});
const graduated = (mint = MINT) => JSON.stringify({ type: "coin:graduated", channel: "coins:graduated", mint, poolId: "D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2" });

class FakeSocket implements LiveSocket {
  onopen: LiveSocket["onopen"] = null;
  onmessage: LiveSocket["onmessage"] = null;
  onclose: LiveSocket["onclose"] = null;
  onerror: LiveSocket["onerror"] = null;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(data: string) {
    this.onmessage?.({ data });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

/** A feed whose sockets the test drives: each new socket runs `script` once it's created. */
function fakeFeed(script: (s: FakeSocket, n: number) => void) {
  const sockets: FakeSocket[] = [];
  const feed = new LiveFeed("wss://api.test/ws", () => {
    const s = new FakeSocket();
    sockets.push(s);
    queueMicrotask(() => script(s, sockets.length));
    return s;
  });
  return { feed, sockets };
}

test("the feed's address comes from the API's", () => {
  assert.equal(liveUrlFor(), "wss://api.higher.fun/ws");
  assert.equal(liveUrlFor("https://api.test/"), "wss://api.test/ws");
  assert.equal(liveUrlFor("http://localhost:4000"), "ws://localhost:4000/ws");
});

test("a filter subscribes only to the channels it needs", () => {
  assert.deepEqual(liveChannels(ALL), ["coins:new", "coins:graduated", "tape"]);
  assert.deepEqual(liveChannels({ kinds: ["buy"], mints: [MINT, MINT, OTHER] }), [`trades:${MINT}`, `trades:${OTHER}`]);
  assert.deepEqual(liveChannels({ kinds: ["graduation"], mints: [MINT] }), ["coins:graduated"]);
  assert.deepEqual(liveChannels({ kinds: [] }), []);
});

test("messages become events in SOL and whole tokens", () => {
  const now = () => new Date("2026-11-06T12:01:00.000Z");
  assert.deepEqual(parseLiveMessage(tape("buy"), ALL), {
    kind: "buy",
    mint: OTHER,
    ticker: "HIGH",
    sol: 0.394181,
    priceSol: 0.000017741833899624639899,
    signature: "3ifEkMxVKQhTdHGKZC6HhHiksk4ZgbTugfpjhu1B8XYspyhVsq1k5kjFjXashHqY6T7FQwZtyA4hKzmjjNUcStr",
    url: `https://higher.fun/coin/${OTHER}`,
    at: "2026-11-06T11:53:07.000Z",
  });
  const t = parseLiveMessage(trade(), { kinds: ["buy"], mints: [MINT] });
  assert.equal(t?.kind, "buy");
  assert.equal(t?.kind === "buy" && t.wallet, "L6zEMm9nQ2BK9V7NqaooHKJsEDxndNbjnTEDrKC8axF");
  assert.equal(t?.kind === "buy" && t.tokens, 1063414.2);
  assert.equal(t?.kind === "buy" && t.sol, 0.054258);
  assert.deepEqual(parseLiveMessage(newCoin, ALL), {
    kind: "launch",
    mint: OTHER,
    name: "Ignore previous instructions",
    ticker: "HIGH",
    creator: "DCaDLmraWzr7R9xiA9CqcD3hPFEtg32biXnrci66AU1c",
    url: `https://higher.fun/coin/${OTHER}`,
    at: "2026-11-06T12:00:00.000Z",
  });
  assert.deepEqual(parseLiveMessage(graduated(), ALL, now), {
    kind: "graduation",
    mint: MINT,
    poolId: "D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2",
    url: `https://higher.fun/coin/${MINT}`,
    at: "2026-11-06T12:01:00.000Z",
  });
});

test("the filter drops other kinds, other coins and small trades", () => {
  assert.equal(parseLiveMessage(tape("sell"), { kinds: ["buy"] }), null);
  assert.equal(parseLiveMessage(tape("new"), ALL), null, "launches come from coins:new");
  assert.equal(parseLiveMessage(tape("graduated"), ALL), null, "graduations come from coins:graduated");
  assert.equal(parseLiveMessage(tape("buy"), { kinds: ["buy"], mints: [MINT] }), null, "with coins, trades come from their channels");
  assert.equal(parseLiveMessage(trade(OTHER), { kinds: ["buy"], mints: [MINT] }), null);
  assert.equal(parseLiveMessage(graduated(OTHER), { kinds: ["graduation"], mints: [MINT] }), null);
  assert.equal(parseLiveMessage(tape("buy", OTHER, "100000000"), { kinds: ["buy"], minSol: 0.5 }), null);
  assert.notEqual(parseLiveMessage(tape("buy", OTHER, "500000000"), { kinds: ["buy"], minSol: 0.5 }), null);
  assert.equal(parseLiveMessage(newCoin, { kinds: ["buy", "sell"] }), null);
});

test("malformed or unknown messages are ignored", () => {
  for (const raw of ["not json", "null", "[]", '{"type":"error","message":"unknown channel: x"}', '{"type":"tape","event":{"kind":"buy"}}', '{"type":"chat","message":{}}', 42]) {
    assert.equal(parseLiveMessage(raw, ALL), null, String(raw));
  }
  const side = JSON.parse(trade());
  side.trade.side = "swap";
  assert.equal(parseLiveMessage(JSON.stringify(side), { kinds: ["buy", "sell"], mints: [MINT] }), null);
});

test("collect subscribes, gathers matching events and stops at max_events", async () => {
  const { feed, sockets } = fakeFeed((s) => {
    s.open();
    s.emit(tape("buy", OTHER, "100000000"));
    s.emit(tape("sell"));
    s.emit(newCoin);
    s.emit(tape("buy"));
  });
  const seen: number[] = [];
  const got = await feed.collect({ kinds: ["launch", "buy", "sell"], minSol: 0.2 }, { waitMs: 5000, maxEvents: 2, onEvent: (_e, n) => seen.push(n) });
  assert.equal(got.ended, "max_events");
  assert.deepEqual(got.events.map((e) => e.kind), ["sell", "launch"]);
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(sockets[0]!.sent.map((m) => JSON.parse(m)), [
    { op: "subscribe", channel: "coins:new" },
    { op: "subscribe", channel: "tape" },
  ]);
  assert.equal(sockets[0]!.closed, true, "the socket is closed afterwards");
});

test("collect returns what it has when the time is up", async () => {
  const { feed } = fakeFeed((s) => {
    s.open();
    s.emit(trade());
  });
  const got = await feed.collect({ kinds: ["buy"], mints: [MINT] }, { waitMs: 30, maxEvents: 10 });
  assert.equal(got.ended, "time_up");
  assert.equal(got.events.length, 1);
  assert.equal(got.reconnects, 0);
});

test("collect stops when the caller cancels", async () => {
  const { feed } = fakeFeed((s) => s.open());
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 10);
  const got = await feed.collect(ALL, { waitMs: 5000, maxEvents: 10, signal: ctl.signal });
  assert.equal(got.ended, "cancelled");
});

test("a feed that never opens is an error, not a quiet market", async () => {
  const { feed } = fakeFeed((s) => s.drop());
  await assert.rejects(feed.collect(ALL, { waitMs: 30, maxEvents: 10 }), NetworkError);
});

test("watch reconnects after a drop and subscribes again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { feed, sockets } = fakeFeed((s, n) => {
    s.open();
    s.emit(trade(MINT, n === 1 ? "buy" : "sell"));
    if (n === 1) s.drop();
  });
  const ctl = new AbortController();
  const events: string[] = [];
  const statuses: string[] = [];
  const done = feed.watch({ kinds: ["buy", "sell"], mints: [MINT] }, (e) => events.push(e.kind), { signal: ctl.signal, onStatus: (s) => statuses.push(s) });
  await new Promise((r) => queueMicrotask(() => r(null)));
  await new Promise((r) => queueMicrotask(() => r(null)));
  assert.equal(sockets.length, 1);
  t.mock.timers.tick(16_000);
  await new Promise((r) => queueMicrotask(() => r(null)));
  assert.equal(sockets.length, 2);
  assert.deepEqual(sockets[1]!.sent, [JSON.stringify({ op: "subscribe", channel: `trades:${MINT}` })]);
  ctl.abort();
  await done;
  assert.deepEqual(events, ["buy", "sell"]);
  assert.deepEqual(statuses, ["connecting", "open", "reconnecting", "reconnecting", "open"]);
});

test("without a WebSocket the feed says what it needs", async () => {
  const saved = (globalThis as { WebSocket?: unknown }).WebSocket;
  delete (globalThis as { WebSocket?: unknown }).WebSocket;
  try {
    await assert.rejects(new LiveFeed().collect(ALL, { waitMs: 10, maxEvents: 1 }), (err: Error & { code?: string }) => err.code === "live_unavailable");
  } finally {
    (globalThis as { WebSocket?: unknown }).WebSocket = saved;
  }
});
