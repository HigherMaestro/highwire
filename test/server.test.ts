import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

// A fake api.higher.fun and RPC, so this test runs offline.
const fakeFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "rpc.test") {
    return json({ jsonrpc: "2.0", id: 1, result: { value: null } });
  }
  switch (url.pathname) {
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

async function connect() {
  const server = createServer({ apiUrl: "https://api.test", rpcUrl: "https://rpc.test", fetch: fakeFetch, retries: 0 });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

test("lists every tool, all read-only", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "check_ticker",
    "get_chat",
    "get_coin",
    "get_coin_candles",
    "get_coin_comments",
    "get_coin_holders",
    "get_coin_trades",
    "get_creator_coins",
    "get_featured_coin",
    "get_leaderboard",
    "get_platform_info",
    "get_top_coins",
    "get_trade_tape",
    "get_wallet_profile",
    "list_coins",
    "rug_check",
    "search_coins",
  ]);
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
});

test("list_coins converts units and keeps the cursor", async () => {
  const client = await connect();
  const out = parse(await client.callTool({ name: "list_coins", arguments: { sort: "new", limit: 1 } }));
  assert.equal(out.coins[0].ticker, "HE");
  assert.equal(out.coins[0].graduationTargetSol, 85);
  assert.equal(out.coins[0].graduationProgressPct, 10);
  assert.equal(out.coins[0].marketCapUsd, 2760);
  assert.equal(out.nextCursor, "abc");
});

test("API errors come back as isError with a next step", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "get_coin", arguments: { mint: "7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh" } });
  assert.equal(res.isError, true);
  const out = parse(res);
  assert.equal(out.code, "not_found");
  assert.ok(out.next_step);
});

test("a bad mint is rejected by the schema", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "get_coin", arguments: { mint: "not-a-mint!" } });
  assert.equal(res.isError, true);
});

test("get_platform_info reports the live launch fee and both fee modes", async () => {
  const client = await connect();
  const out = parse(await client.callTool({ name: "get_platform_info", arguments: {} }));
  assert.equal(out.launchFee.sol, 0.02);
  assert.equal(out.feeModes.classic.totalTradeFeeBps, 25);
  assert.equal(out.feeModes.rewards.totalTradeFeeBps, 100);
});

test("prompts and resources are registered", async () => {
  const client = await connect();
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), ["coin_due_diligence", "creator_report", "plan_launch", "scan_launches"]);
  const { resourceTemplates } = await client.listResourceTemplates();
  assert.equal(resourceTemplates[0]?.uriTemplate, "higher://coins/{mint}");
});
