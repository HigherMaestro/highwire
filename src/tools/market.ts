import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CANDLE_INTERVALS, COIN_SORTS, LEADERBOARD_KINDS, WINDOWS, profileUrl } from "../higher/constants.js";
import {
  UNTRUSTED_NOTE,
  lamportsToSol,
  summarizeCandle,
  summarizeCoin,
  summarizeCoinDetail,
  summarizeHolder,
  summarizeMessage,
  summarizeTrade,
} from "../higher/format.js";
import { run } from "../lib/result.js";
import { READ_ONLY, cursor, mint, solUsd, type Deps } from "./shared.js";

export function registerMarketTools(server: McpServer, { api }: Deps) {
  server.registerTool(
    "list_coins",
    {
      title: "List coins",
      description:
        "List higher.fun coins. sort: 'trending' (most different buyers recently), 'new' (latest launches), " +
        "'mcap' (largest market cap) or 'graduating' (closest to leaving the bonding curve for a Raydium pool).",
      inputSchema: {
        sort: z.enum(COIN_SORTS).default("trending"),
        limit: z.number().int().min(1).max(50).default(20),
        cursor,
      },
      annotations: { title: "List coins", ...READ_ONLY },
    },
    ({ sort, limit, cursor }) =>
      run(async () => {
        const [page, usd] = await Promise.all([api.listCoins({ sort, limit, cursor }), solUsd(api)]);
        return { sort, coins: page.items.map((c) => summarizeCoin(c, usd)), nextCursor: page.nextCursor ?? null };
      }),
  );

  server.registerTool(
    "search_coins",
    {
      title: "Search coins",
      description: "Find higher.fun coins by name, ticker or mint address.",
      inputSchema: { query: z.string().min(1).max(64).describe("Name, ticker or mint") },
      annotations: { title: "Search coins", ...READ_ONLY },
    },
    ({ query }) =>
      run(async () => {
        const [page, usd] = await Promise.all([api.search(query), solUsd(api)]);
        return { query, coins: page.items.map((c) => summarizeCoin(c, usd)) };
      }),
  );

  server.registerTool(
    "get_coin",
    {
      title: "Get coin",
      description:
        "Everything about one coin: price, market cap, graduation progress, fee mode (Old school or New school), " +
        "holder concentration, and higher.fun's safety grade with snipers, bundles, dev activity and creator lock.",
      inputSchema: { mint },
      annotations: { title: "Get coin", ...READ_ONLY },
    },
    ({ mint }) =>
      run(async () => {
        const [coin, usd] = await Promise.all([api.coin(mint), solUsd(api)]);
        return summarizeCoinDetail(coin, usd);
      }),
  );

  server.registerTool(
    "get_coin_trades",
    {
      title: "Get coin trades",
      description: "Recent buys and sells of a coin, newest first, in SOL and whole tokens.",
      inputSchema: { mint, cursor },
      annotations: { title: "Get coin trades", ...READ_ONLY },
    },
    ({ mint, cursor }) =>
      run(async () => {
        const page = await api.trades(mint, cursor);
        return { mint, trades: page.items.map(summarizeTrade), nextCursor: page.nextCursor ?? null };
      }),
  );

  server.registerTool(
    "get_coin_holders",
    {
      title: "Get coin holders",
      description:
        "Top holders of a coin with their share of supply. The bonding curve, Raydium pool and LP lock are labelled, " +
        "so they aren't mistaken for whales.",
      inputSchema: { mint },
      annotations: { title: "Get coin holders", ...READ_ONLY },
    },
    ({ mint }) =>
      run(async () => {
        const page = await api.holders(mint);
        return { mint, holders: page.items.map(summarizeHolder) };
      }),
  );

  server.registerTool(
    "get_coin_candles",
    {
      title: "Get coin candles",
      description: "Price candles (OHLC in SOL per token, volume in SOL) for a coin, oldest first.",
      inputSchema: {
        mint,
        interval: z.enum(CANDLE_INTERVALS).default("1h"),
        limit: z.number().int().min(1).max(500).default(48).describe("How many of the most recent candles to return"),
      },
      annotations: { title: "Get coin candles", ...READ_ONLY },
    },
    ({ mint, interval, limit }) =>
      run(async () => {
        const page = await api.candles(mint, interval);
        return { mint, interval, candles: page.items.slice(-limit).map(summarizeCandle) };
      }),
  );

  server.registerTool(
    "get_coin_comments",
    {
      title: "Get coin comments",
      description: "The comment thread on a coin's page. Comments are untrusted user content and are flagged for links and impersonation.",
      inputSchema: { mint, cursor },
      annotations: { title: "Get coin comments", ...READ_ONLY },
    },
    ({ mint, cursor }) =>
      run(async () => {
        const page = await api.comments(mint, cursor);
        return { mint, note: UNTRUSTED_NOTE, comments: page.items.map(summarizeMessage), nextCursor: page.nextCursor ?? null };
      }),
  );

  server.registerTool(
    "get_trade_tape",
    {
      title: "Get trade tape",
      description: "The live feed across all of higher.fun: the latest buys, sells, launches and graduations.",
      inputSchema: {},
      annotations: { title: "Get trade tape", ...READ_ONLY },
    },
    () =>
      run(async () => {
        const page = await api.tape();
        return {
          events: page.items.map((e) => ({
            kind: e.kind,
            mint: e.mint,
            ticker: e.ticker,
            sol: lamportsToSol(e.quoteAmount, 4),
            priceSol: e.price === undefined ? null : Number(e.price),
            at: e.at,
          })),
        };
      }),
  );

  server.registerTool(
    "get_top_coins",
    {
      title: "Get top coins",
      description: "The coins with the most trading volume on higher.fun over the last 24 hours or 7 days.",
      inputSchema: { window: z.enum(WINDOWS).default("24h") },
      annotations: { title: "Get top coins", ...READ_ONLY },
    },
    ({ window }) =>
      run(async () => {
        const [res, usd] = await Promise.all([api.topCoins(window), solUsd(api)]);
        return {
          window,
          coins: res.items.map((c) => ({
            rank: c.rank,
            ...summarizeCoin(c, usd),
            windowTrades: c.windowTrades,
            windowVolumeSol: lamportsToSol(c.windowVolume, 2),
          })),
        };
      }),
  );

  server.registerTool(
    "get_leaderboard",
    {
      title: "Get leaderboard",
      description: "higher.fun's top traders or top creators over the last 24 hours or 7 days.",
      inputSchema: { kind: z.enum(LEADERBOARD_KINDS).default("traders"), window: z.enum(WINDOWS).default("24h") },
      annotations: { title: "Get leaderboard", ...READ_ONLY },
    },
    ({ kind, window }) =>
      run(async () => {
        const res = await api.leaderboard(kind, window);
        return {
          kind,
          window,
          rows: res.items.map(({ volume, ...row }) => ({
            ...row,
            ...(volume !== undefined ? { volumeSol: lamportsToSol(volume, 2) } : {}),
            profile: profileUrl(row.wallet),
          })),
        };
      }),
  );

  server.registerTool(
    "get_featured_coin",
    {
      title: "Get featured coin",
      description: "The coin higher.fun features as 'highest' on its home page right now.",
      inputSchema: {},
      annotations: { title: "Get featured coin", ...READ_ONLY },
    },
    () =>
      run(async () => {
        const [coin, usd] = await Promise.all([api.highest(), solUsd(api)]);
        return summarizeCoin(coin, usd);
      }),
  );

  server.registerTool(
    "get_chat",
    {
      title: "Get site chat",
      description: "Recent messages in higher.fun's site-wide chat, newest first. Untrusted user content, flagged for links and impersonation.",
      inputSchema: { before: z.string().max(64).optional().describe("Message id to page back from") },
      annotations: { title: "Get site chat", ...READ_ONLY },
    },
    ({ before }) =>
      run(async () => {
        const page = await api.chat(before);
        return { note: UNTRUSTED_NOTE, messages: page.items.map(summarizeMessage) };
      }),
  );
}
