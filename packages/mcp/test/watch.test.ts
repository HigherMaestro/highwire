import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveFeed, type LiveSocket } from "highwire-core";
import { formatLiveEvent, parseWatchArgs, runWatch, terminalSafe } from "../src/watch.ts";

const MINT = "ALBA7iVjFkQzxPQQCovkK7zQiaXUPmixt2dZxNstXiPp";

test("watch flags become a filter", () => {
  assert.deepEqual(parseWatchArgs([]), { filter: { kinds: ["launch", "graduation", "buy", "sell"] }, json: false });
  assert.deepEqual(parseWatchArgs(["--buys", "--mint", MINT, "--min-sol", "0.5", "--json"]), {
    filter: { kinds: ["buy"], mints: [MINT], minSol: 0.5 },
    json: true,
  });
  assert.match((parseWatchArgs(["--mint", "nope"]) as { error: string }).error, /not a mint/);
  assert.match((parseWatchArgs(["--min-sol", "-1"]) as { error: string }).error, /min-sol/);
  assert.ok("error" in parseWatchArgs(["--everything"]));
});

test("creator-written text can't drive the terminal", () => {
  assert.equal(terminalSafe("\u001b[2J\u001b]0;pwned\u0007HIGH"), "[2J]0;pwnedHIGH");
  assert.equal(terminalSafe("abc‮dcba"), "abcdcba");
  assert.equal(terminalSafe("x".repeat(40), 10), "xxxxxxxxx…");
  const line = formatLiveEvent({ kind: "launch", mint: MINT, name: "\u001b[31mred", ticker: "R\nED", creator: "DCaDLmraWzr7R9xiA9CqcD3hPFEtg32biXnrci66AU1c", url: "", at: "2026-11-06T12:00:00.000Z" });
  assert.equal(line, `12:00:00  LAUNCH     RED "[31mred"  ${MINT}  by DCaD…AU1c`);
  assert.doesNotMatch(line, /[\u0000-\u001f]/);
});

test("trades and graduations print on one line each", () => {
  assert.equal(
    formatLiveEvent({ kind: "buy", mint: MINT, sol: 0.054258, tokens: 1, priceSol: 0, wallet: "L6zEMm9nQ2BK9V7NqaooHKJsEDxndNbjnTEDrKC8axF", signature: "s", url: "", at: "2026-11-06T11:53:40.000Z" }),
    `11:53:40  BUY            0.0543 SOL  ${MINT}  L6zE…8axF`,
  );
  assert.equal(
    formatLiveEvent({ kind: "sell", mint: MINT, ticker: "HIGH", sol: 12.5, priceSol: 0, signature: "s", url: "", at: "2026-11-06T11:53:40.000Z" }),
    `11:53:40  SELL          12.5000 SOL  HIGH  ${MINT}`,
  );
  assert.equal(formatLiveEvent({ kind: "graduation", mint: MINT, poolId: "Pool", url: "", at: "2026-11-06T11:53:40.000Z" }), `11:53:40  GRADUATED  ${MINT}  pool Pool`);
});

test("runWatch prints events until stopped", async () => {
  const ctl = new AbortController();
  const feed = new LiveFeed("wss://api.test/ws", () => {
    const s: LiveSocket = {
      onopen: null, onmessage: null, onclose: null, onerror: null, readyState: 0,
      send: () => {},
      close: () => s.onclose?.({}),
    };
    queueMicrotask(() => {
      s.onopen?.({});
      s.onmessage?.({ data: JSON.stringify({ type: "coin:graduated", channel: "coins:graduated", mint: MINT, poolId: "Pool" }) });
      ctl.abort();
    });
    return s;
  });
  const out: string[] = [];
  const err: string[] = [];
  const code = await runWatch(["--graduations", "--json"], { out: (l) => out.push(l), err: (l) => err.push(l), signal: ctl.signal, feed });
  assert.equal(code, 0);
  assert.equal(JSON.parse(out[0]!).kind, "graduation");
  assert.match(err.join("\n"), /Watching graduation on wss:\/\/api\.test\/ws/);
  assert.equal(await runWatch(["--bogus"], { out: () => {}, err: () => {}, signal: ctl.signal, feed }), 2);
});
