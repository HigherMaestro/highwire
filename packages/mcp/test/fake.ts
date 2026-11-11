// A fake api.higher.fun and RPC, so this test runs offline.
export const fakeFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "rpc.test") {
    return json({ jsonrpc: "2.0", id: 1, result: { value: null } });
  }
  switch (url.pathname) {
    case "/coins/highest":
      // higher.fun answers null when nothing is featured.
      return json(null);
    case "/sol-price":
      return json({ usd: 100 });
    case "/launch-fee":
      return json({ lamports: "20000000", treasury: "Treasury1111111111111111111111111111111111" });
    case "/coins":
      return json({
        items: [
          {
            mint: "9CmhXRBhjNw2LM6rHJ75735yFG6aCK9fNwwMeJMQBswb",
            name: "Higher Elon",
            ticker: "HE",
            imageUri: null,
            creator: "DCaDLmraWzr7R9xiA9CqcD3hPFEtg32biXnrci66AU1c",
            status: "curve",
            createdAt: "2026-11-05T12:20:56.000Z",
            lastPrice: "0.000000027601971649304892",
            marketCap: "27601971649",
            volume24h: "3483523830",
            raised: "8500000000",
            target: "85000000000",
            replyCount: 0,
            lastTradeAt: "2026-11-05T12:21:27.000Z",
            trustGrade: "B",
          },
        ],
        nextCursor: "abc",
      });
    default:
      return json({ error: "not_found", message: "coin not found" }, 404);
  }
}) as typeof globalThis.fetch;

export const FAKE_OPTIONS = { apiUrl: "https://api.test", rpcUrl: "https://rpc.test", fetch: fakeFetch, retries: 0 };

export const READ_TOOLS = [
  "check_ticker",
  "get_chat",
  "get_coin",
  "get_coin_candles",
  "get_coin_comments",
  "get_coin_fees",
  "get_coin_holders",
  "get_coin_trades",
  "get_creator_coins",
  "get_creator_fees",
  "get_ecosystem_fees",
  "get_featured_coin",
  "get_leaderboard",
  "get_platform_info",
  "get_top_coins",
  "get_trade_tape",
  "get_wallet_profile",
  "line_leaderboard",
  "line_practice",
  "line_rules",
  "list_coins",
  "rug_check",
  "search_coins",
  "watch_market",
];

export const TRANSACTION_TOOLS = ["build_claim_creator_fees", "build_launch", "build_trade", "get_wallet_pnl", "get_wallet_positions", "quote_trade"];
/** Served by the stdio server only: the sign page never signs transfers. */
export const LOCAL_ONLY_TOOLS = ["build_transfer"];
/** Only with a local signer. */
export const EXECUTE_TOOLS = ["cancel_order", "execute_claim", "execute_launch", "execute_trade", "execute_transfer", "get_signer_status", "line_join", "line_move", "line_register", "line_retire", "line_state", "list_orders", "place_order", "post_chat", "post_comment"];
export const BUILD_TOOLS = ["build_claim_creator_fees", "build_launch", "build_trade", "build_transfer"];
export const HOSTED_TOOLS = [...READ_TOOLS, ...TRANSACTION_TOOLS].sort();
export const ALL_TOOLS = [...HOSTED_TOOLS, ...LOCAL_ONLY_TOOLS].sort();
