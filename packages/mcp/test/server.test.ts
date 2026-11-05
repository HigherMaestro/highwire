import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { ALL_TOOLS, FAKE_OPTIONS } from "./fake.ts";

async function connect() {
  const server = createServer(FAKE_OPTIONS);
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
  assert.deepEqual(names, ALL_TOOLS);
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
