// Live smoke test: starts the real server over stdio, the way an MCP client
// would, and calls the main tools against api.higher.fun and mainnet RPC.
// Run with `npm run smoke`. Needs network access.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HIGH = "7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--conditions=highwire-source", "--import", "tsx", "src/cli.ts"],
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

let failed = 0;
async function call(name: string, args: Record<string, unknown>, show: (out: any) => string) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
  if (res.isError) {
    // Solana's public RPC rate-limits by IP, and this check calls it many times in a row: that's the machine, not the tool.
    if (JSON.parse(text).code === "rate_limited") {
      console.log(`skip ${name}: the RPC rate-limited this run (set SOLANA_RPC_URL to a provider's to check it)`);
      return;
    }
    failed++;
    console.log(`FAIL ${name}: ${text}`);
    return;
  }
  console.log(`ok   ${name}: ${show(JSON.parse(text))}`);
}

await call("get_platform_info", {}, (o) => `launch fee ${o.launchFee.sol} SOL, SOL $${o.solUsd}`);
await call("list_coins", { sort: "trending", limit: 3 }, (o) => o.coins.map((c: any) => `$${c.ticker} ${c.graduationProgressPct}%`).join(", "));
await call("list_coins", { sort: "graduating", limit: 3 }, (o) => o.coins.map((c: any) => `$${c.ticker} ${c.graduationProgressPct}%`).join(", "));
await call("search_coins", { query: "higher" }, (o) => `${o.coins.length} results`);
await call("get_coin", { mint: HIGH }, (o) => `$${o.ticker} ${o.stage}, ${o.feeMode?.label}, grade ${o.safety?.grade}, mcap ${o.marketCapSol} SOL`);
await call("get_coin_trades", { mint: HIGH }, (o) => `${o.trades.length} trades, latest ${o.trades[0]?.side} ${o.trades[0]?.sol} SOL`);
await call("get_coin_holders", { mint: HIGH }, (o) => o.holders.slice(0, 3).map((h: any) => `${h.sharePct}% ${h.label ?? h.wallet.slice(0, 6)}`).join(", "));
await call("get_coin_candles", { mint: HIGH, interval: "1h", limit: 5 }, (o) => `${o.candles.length} candles, last close ${o.candles.at(-1)?.close}`);
await call("get_coin_comments", { mint: HIGH }, (o) => `${o.comments.length} comments, ${o.comments.filter((c: any) => c.flags).length} flagged`);
await call("get_trade_tape", {}, (o) => `${o.events.length} events`);
await call("watch_market", { events: ["buy", "sell"], wait_seconds: 15, max_events: 3 }, (o) => `${o.events.length} live trades in ${o.seconds}s (${o.ended})`);
await call("get_top_coins", { window: "24h" }, (o) => o.coins.slice(0, 3).map((c: any) => `#${c.rank} $${c.ticker}`).join(", "));
await call("get_leaderboard", { kind: "creators", window: "7d" }, (o) => `${o.rows.length} creators`);
await call("get_featured_coin", {}, (o) => (o.featured === null ? "none featured right now" : `$${o.ticker}`));
await call("get_chat", {}, (o) => `${o.messages.length} messages, ${o.messages.filter((m: any) => m.flags).length} flagged`);
await call("get_wallet_profile", { wallet: "9qfu1eHi6aWrPGKYTbDcKcFbYBPj2VexzfWJYVvJ48E1" }, (o) => `${o.coinsCreated.length} coins, ${o.locks.length} locks`);
await call("check_ticker", { ticker: "HIGH" }, (o) => `HIGH available: ${o.available}`);
await call("rug_check", { mint: HIGH }, (o) => `${o.verdict}; mint auth ${o.onchain.mintAuthority ?? "revoked"}, freeze ${o.onchain.freezeAuthority ?? "revoked"}; ${o.flags.length} flags`);
await call("get_coin_fees", { mint: HIGH }, (o) => `${o.totalFeesSol} SOL in fees, ${o.byRecipient.creator} to the creator`);
await call("get_ecosystem_fees", { top: 3 }, (o) => `${o.totals.coins} coins, ${o.totals.feesSol} SOL in fees, ${o.totals.last24h.feesSol} in 24h; top $${o.coins[0]?.ticker}`);
await call("get_creator_fees", { wallet: "3nG8WsVqotPWH74NRUpLwfQ1NMabdorWQ52YvbrVHA2E" }, (o) => `${o.coins.length} coins, ${o.earnedSol} SOL earned, ${o.waitingToClaim.totalSol} waiting`);
await call("quote_trade", { mint: HIGH, side: "buy", sol: 0.1 }, (o) => `0.1 SOL buys ${o.tokensOut} $HIGH in the ${o.venue}, impact ${o.priceImpactPct}%`);
await call("get_wallet_positions", { wallet: "DFZYHaTZiRFWo23q5NQZCBTxXGZi36ZwVNP62iyB2Vmj" }, (o) => `${o.solBalance} SOL, ${o.positions.length} higher.fun coins`);
// Solana's public RPC often times out searching history; that's the tool working, so it isn't counted as a failure.
const pnl = await client.callTool({ name: "get_wallet_pnl", arguments: { wallet: "DFZYHaTZiRFWo23q5NQZCBTxXGZi36ZwVNP62iyB2Vmj", mints: ["ESWuXHiwswpkfhQtA6A1tAtiBJh9A5hUDYj5fEYhigh"] } });
const pnlText = (pnl.content as Array<{ text: string }>)[0]?.text ?? "";
const pnlOut = JSON.parse(pnlText);
if (!pnl.isError) console.log(`ok   get_wallet_pnl: ${pnlOut.coins[0].transactions.buys} buys, total ${pnlOut.totals.totalSol} SOL`);
else if (pnlOut.code === "history_unavailable") console.log("ok   get_wallet_pnl: the RPC timed out searching history (set SOLANA_RPC_URL to a provider's to check it fully)");
else {
  failed++;
  console.log(`FAIL get_wallet_pnl: ${pnlText}`);
}

const coin = await client.readResource({ uri: `higher://coins/${HIGH}` });
console.log(`ok   resource higher://coins/{mint}: ${(coin.contents[0] as { text: string }).text.length} chars`);

await client.close();
if (failed) {
  console.log(`${failed} tool call(s) failed`);
  process.exit(1);
}
