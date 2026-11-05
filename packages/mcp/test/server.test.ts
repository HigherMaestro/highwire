import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decodeSignPayload } from "highwire-core";
import { serverOptionsFromEnv } from "../src/env.ts";
import { createServer, type ServerOptions } from "../src/server.ts";
import { ALL_TOOLS, BUILD_TOOLS, FAKE_OPTIONS } from "./fake.ts";
import { fixtureFetch } from "./replay.ts";

async function connect(opts: ServerOptions = FAKE_OPTIONS) {
  const server = createServer(opts);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

test("lists every tool; only the build tools are not read-only, and none is destructive", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ALL_TOOLS);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, !BUILD_TOOLS.includes(t.name), t.name);
    assert.equal(t.annotations?.destructiveHint, false, t.name);
  }
});

test("build tools demand their confirm flag and cap slippage", async () => {
  const client = await connect();
  const base = {
    wallet: "H4dxJQN6DRqCPva9yaX2Nt3mAkvgo7pyQZr93fLke1U5",
    mint: "EE3p42u2rACc3PEDcgVdqfg8JRxSYdvbn53rFoc3i1ix",
    side: "buy",
    sol: 0.1,
    max_sol: 1,
    max_slippage_bps: 200,
  };
  for (const args of [base, { ...base, confirm_trade: false }, { ...base, confirm_trade: true, max_slippage_bps: 1501 }, { ...base, confirm_trade: true, max_sol: 11 }]) {
    const res = await client.callTool({ name: "build_trade", arguments: args });
    assert.equal(res.isError, true, JSON.stringify(args));
  }
  const launch = await client.callTool({
    name: "build_launch",
    arguments: { wallet: base.wallet, name: "X", ticker: "X", fee_mode: "classic", idempotency_key: "launch-key-1" },
  });
  assert.equal(launch.isError, true, "confirm_launch is required");
});

test("no tool takes a private key", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  for (const t of tools) {
    for (const prop of Object.keys((t.inputSchema as { properties?: object }).properties ?? {})) {
      assert.doesNotMatch(prop, /secret|private|seed|keypair|mnemonic/i, `${t.name}.${prop}`);
    }
  }
});

test("quote_trade wants sol for a buy and tokens for a sell", async () => {
  const client = await connect();
  const res = await client.callTool({
    name: "quote_trade",
    arguments: { mint: "EE3p42u2rACc3PEDcgVdqfg8JRxSYdvbn53rFoc3i1ix", side: "buy", tokens: 5 },
  });
  assert.equal(res.isError, true);
  assert.equal(parse(res).code, "bad_request");
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

test("a build result's sign_url carries the envelope, on the configured site", async () => {
  const client = await connect({ fetch: fixtureFetch("buy-curve"), retries: 0, siteUrl: "http://localhost:3000" });
  const out = parse(
    await client.callTool({
      name: "build_trade",
      arguments: {
        wallet: "H4dxJQN6DRqCPva9yaX2Nt3mAkvgo7pyQZr93fLke1U5",
        mint: "EE3p42u2rACc3PEDcgVdqfg8JRxSYdvbn53rFoc3i1ix",
        side: "buy",
        sol: 0.01,
        max_slippage_bps: 200,
        max_sol: 5,
        confirm_trade: true,
      },
    }),
  );
  const url = new URL(out.sign_url);
  assert.equal(url.origin + url.pathname, "http://localhost:3000/sign");
  assert.deepEqual(await decodeSignPayload(url.hash), out.unsigned);
  assert.ok(out.unsigned.transactions[0].summary.some((l: string) => l.includes("built by Highwire")));
});

test("the environment sets the sign site and the launch secret", () => {
  const o = serverOptionsFromEnv({ HIGHWIRE_SITE_URL: "http://localhost:3000/", HIGHWIRE_LAUNCH_SECRET: "s" });
  assert.equal(o.siteUrl, "http://localhost:3000");
  assert.equal(o.launchKeySecret, "s");
  assert.throws(() => serverOptionsFromEnv({ HIGHWIRE_SITE_URL: "ftp://x" }), /http/);
  assert.equal(serverOptionsFromEnv({}).siteUrl, undefined);
});

test("the instructions tell agents to hand over the sign link and never ask for keys", async () => {
  const client = await connect();
  const text = client.getInstructions() ?? "";
  assert.match(text, /sign_url/);
  assert.match(text, /never needs a private key or seed phrase: never ask for one/);
});
