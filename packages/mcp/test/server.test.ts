import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { attestationPublicKey, attestationSeed, decodeSignPayload, verifyAttestation } from "highwire-core";
import { rpcUrlEnv, serverOptionsFromEnv } from "../src/env.ts";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { agentPaths, LocalSigner, POLICY_TEMPLATE } from "highwire-agent";
import { signInMessage } from "highwire-core";
import { createServer, SIGNER_INSTRUCTIONS, type ServerOptions } from "../src/server.ts";
import { readCoinImage } from "../src/tools/execute.ts";
import { localLaunchSecret } from "../src/signer-env.ts";
import { ALL_TOOLS, BUILD_TOOLS, EXECUTE_TOOLS, FAKE_OPTIONS } from "./fake.ts";
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

test("a malformed SOLANA_RPC_URL falls back to the public RPC instead of failing, and is never logged", () => {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  assert.equal(rpcUrlEnv({ SOLANA_RPC_URL: "  https://rpc.example/?api-key=abc \n" }, "SOLANA_RPC_URL", warn), "https://rpc.example/?api-key=abc");
  assert.equal(rpcUrlEnv({ SOLANA_RPC_URL: '"https://rpc.example/x"' }, "SOLANA_RPC_URL", warn), "https://rpc.example/x");
  assert.equal(warnings.length, 0);
  assert.equal(rpcUrlEnv({ SOLANA_RPC_URL: "rpc.example/?api-key=secret123" }, "SOLANA_RPC_URL", warn), undefined);
  assert.equal(rpcUrlEnv({ SOLANA_RPC_URL: "secret123" }, "SOLANA_RPC_URL", warn), undefined);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((w) => !w.includes("secret123")));
  assert.equal(rpcUrlEnv({}, "SOLANA_RPC_URL", warn), undefined);
});

test("the instructions tell agents to hand over the sign link and never ask for keys", async () => {
  const client = await connect();
  const text = client.getInstructions() ?? "";
  assert.match(text, /sign_url/);
  assert.match(text, /never needs a private key or seed phrase: never ask for one/);
});

test("get_featured_coin says so when higher.fun features nothing", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "get_featured_coin", arguments: {} });
  assert.ok(!res.isError);
  assert.equal(parse(res).featured, null);
});

// ---------------------------------------------------------------- the local signer's tools

const TRADER = "H4dxJQN6DRqCPva9yaX2Nt3mAkvgo7pyQZr93fLke1U5";

/** A signer whose wallet is the fixtures' trader, so builds replay. It never signs here: these are dry runs. */
class FixtureSigner extends LocalSigner {
  override get wallet() {
    return TRADER;
  }
  override get publicKey() {
    return new PublicKey(TRADER);
  }
}

function signerHome(policy?: object) {
  const paths = agentPaths({ HIGHWIRE_HOME: mkdtempSync(join(tmpdir(), "highwire-mcp-")) });
  if (policy) writeFileSync(paths.policy, JSON.stringify(policy));
  return paths;
}

test("the execute tools exist only with a local signer, are marked destructive, and the hosted endpoint can't have them", async () => {
  const signer = new LocalSigner(Keypair.generate(), signerHome());
  const client = await connect({ ...FAKE_OPTIONS, signer });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...ALL_TOOLS, ...EXECUTE_TOOLS].sort());
  for (const t of tools.filter((t) => t.name.startsWith("execute_"))) assert.equal(t.annotations?.destructiveHint, true, t.name);
  assert.equal(tools.find((t) => t.name === "get_signer_status")?.annotations?.readOnlyHint, true);
  assert.ok(client.getInstructions()?.includes(SIGNER_INSTRUCTIONS));
  assert.throws(() => createServer({ hosted: true, signer }), /never signs/);

  const status = parse(await client.callTool({ name: "get_signer_status", arguments: {} }));
  assert.equal(status.policy, null);
  assert.match(status.policyProblem, /No policy/);
});

test("execute_trade without a policy refuses before building anything", async () => {
  const client = await connect({ ...FAKE_OPTIONS, signer: new LocalSigner(Keypair.generate(), signerHome()) });
  const res = await client.callTool({
    name: "execute_trade",
    arguments: { mint: "EE3p42u2rACc3PEDcgVdqfg8JRxSYdvbn53rFoc3i1ix", side: "buy", sol: 0.01, max_slippage_bps: 200, max_sol: 5, confirm_trade: true },
  });
  assert.equal(res.isError, true);
  const out = parse(res);
  assert.equal(out.code, "no_policy");
  assert.match(out.next_step, /policy init/);
});

test("execute_trade builds what build_trade builds and, without live, only dry-runs it", async () => {
  const args = { mint: "EE3p42u2rACc3PEDcgVdqfg8JRxSYdvbn53rFoc3i1ix", side: "buy", sol: 0.01, max_slippage_bps: 200, max_sol: 5, confirm_trade: true };
  const paths = signerHome({ ...POLICY_TEMPLATE, cluster: "mainnet", actions: ["trade"], max_slippage_bps: 300 });
  const signer = new FixtureSigner(Keypair.generate(), paths);
  const client = await connect({ fetch: fixtureFetch("buy-curve"), retries: 0, signer });
  const out = parse(await client.callTool({ name: "execute_trade", arguments: args }));
  assert.equal(out.status, "dry_run", JSON.stringify(out).slice(0, 400));
  assert.match(out.note, /nothing was signed/);
  assert.deepEqual(out.transactions, []);
  assert.ok(out.summary[0].some((l: string) => l.includes("Buy coin EE3p42u2rACc3PEDcgVdqfg8JRxSYdvbn53rFoc3i1ix")));
  assert.equal(signer.audit.entries().at(-1)?.outcome, "dry_run");

  // Tighter slippage in the policy refuses the same trade, and the refusal is logged.
  writeFileSync(paths.policy, JSON.stringify({ ...POLICY_TEMPLATE, cluster: "mainnet", actions: ["trade"], max_slippage_bps: 100 }));
  const refused = await client.callTool({ name: "execute_trade", arguments: args });
  assert.equal(refused.isError, true);
  assert.equal(parse(refused).code, "policy_refused");
  assert.equal(signer.audit.entries().at(-1)?.outcome, "refused");
});

test("with a launch secret, built envelopes carry an attestation the sign page can verify; without one, none", async () => {
  const args = {
    wallet: "H4dxJQN6DRqCPva9yaX2Nt3mAkvgo7pyQZr93fLke1U5",
    mint: "EE3p42u2rACc3PEDcgVdqfg8JRxSYdvbn53rFoc3i1ix",
    side: "buy",
    sol: 0.01,
    max_slippage_bps: 200,
    max_sol: 5,
    confirm_trade: true,
  };
  const signed = parse(await (await connect({ fetch: fixtureFetch("buy-curve"), retries: 0, launchKeySecret: "test-secret" })).callTool({ name: "build_trade", arguments: args }));
  const key = attestationPublicKey(attestationSeed("test-secret"));
  assert.equal(signed.unsigned.attestation?.key, key);
  assert.equal(verifyAttestation(await decodeSignPayload(new URL(signed.sign_url).hash), key), "verified");
  const plain = parse(await (await connect({ fetch: fixtureFetch("buy-curve"), retries: 0 })).callTool({ name: "build_trade", arguments: args }));
  assert.equal(plain.unsigned.attestation, undefined);
});

test("get_coin_fees breaks one coin's fees down by recipient, measured and computed, with what's waiting", async () => {
  const client = await connect({ fetch: fixtureFetch("fees-coin"), retries: 0 });
  const out = parse(await client.callTool({ name: "get_coin_fees", arguments: { mint: "7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh" } }));
  assert.equal(out.feeMode, "rewards");
  assert.equal(out.status, "graduated");
  assert.ok(out.totalFeesSol > 0);
  assert.ok(out.lines.some((l: { basis: string; phase: string }) => l.basis === "measured" && l.phase === "curve"));
  assert.ok(out.lines.some((l: { basis: string; phase: string }) => l.basis === "computed" && l.phase === "pool"));
  assert.ok(out.pool.lockedLp.harvestedSol > 0);
  assert.match(out.feesPage, /\/fees\/7ymF66Z6/);
  assert.ok(out.namesNote);
});

test("get_creator_fees lists a creator's coins, what they earned, and what's waiting for them to claim", async () => {
  const client = await connect({ fetch: fixtureFetch("fees-creator"), retries: 0 });
  const out = parse(await client.callTool({ name: "get_creator_fees", arguments: { wallet: "3nG8WsVqotPWH74NRUpLwfQ1NMabdorWQ52YvbrVHA2E" } }));
  assert.ok(out.coins.length >= 1);
  assert.ok(out.coins.some((c: { mint: string }) => c.mint === "Ea5dBrJZN58yV1nm1Q4DybJNYKeTvwpb2GEkXyW64bUH"));
  assert.ok(out.earnedSol > 0);
  assert.equal(out.waitingToClaim.totalSol, Math.round((out.waitingToClaim.curveVaultSol + out.waitingToClaim.poolCreatorFeesSol) * 1e9) / 1e9);
  assert.match(out.page, /\/fees\/creator\/3nG8Ws/);
  assert.ok(out.higherFunPayouts);
});

test("execute_launch only uploads a real image, and never a file from the signer's folder", async () => {
  const paths = signerHome({ ...POLICY_TEMPLATE, cluster: "mainnet", actions: ["launch"] });
  const dir = mkdtempSync(join(tmpdir(), "highwire-img-"));
  const png = join(dir, "coin.png");
  writeFileSync(png, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
  const fake = join(dir, "id.png");
  writeFileSync(fake, "[12,34,56]");
  assert.equal(readCoinImage(png, { paths }, undefined).type, "image/png");
  assert.throws(() => readCoinImage(fake, { paths }, undefined), /isn't a PNG, JPEG, GIF or WebP/);
  assert.throws(() => readCoinImage(paths.policy, { paths }, undefined), /signer's folder/);
  assert.throws(() => readCoinImage(join(dir, "missing.png"), { paths }, undefined), /can be read/);
  const key = join(dir, "key.json");
  writeFileSync(key, "[1,2,3]");
  assert.throws(() => readCoinImage(key, { paths }, key), /signer's folder/);
});

test("the local server keeps its launch secret, so a launch retried after a restart gets the same coin", () => {
  const home = mkdtempSync(join(tmpdir(), "highwire-secret-"));
  const env = { HIGHWIRE_HOME: home };
  const first = localLaunchSecret(env);
  assert.ok(first.length >= 32);
  assert.equal(localLaunchSecret(env), first, "read back, not remade");
  assert.equal(statSync(join(home, "launch-secret")).mode & 0o077, 0, "readable only by the user");
  assert.equal(localLaunchSecret({ ...env, HIGHWIRE_LAUNCH_SECRET: "set-by-env" }), "set-by-env");
});

test("watch_market returns live events in SOL, and reports each as progress", async () => {
  const MINT = "ALBA7iVjFkQzxPQQCovkK7zQiaXUPmixt2dZxNstXiPp";
  const sent: string[] = [];
  const liveSocket = () => {
    const s = {
      onopen: null as ((ev: unknown) => void) | null,
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      onclose: null as ((ev: unknown) => void) | null,
      onerror: null as ((ev: unknown) => void) | null,
      readyState: 0,
      send: (data: string) => sent.push(data),
      close: () => s.onclose?.({}),
    };
    queueMicrotask(() => {
      s.readyState = 1;
      s.onopen?.({});
      for (const [side, lamports] of [["buy", "54258128"], ["sell", "2500000000"], ["buy", "1200000000"]]) {
        s.onmessage?.({
          data: JSON.stringify({
            type: "trade",
            channel: `trades:${MINT}`,
            trade: { signature: `sig${side}${lamports}`, mint: MINT, wallet: "L6zEMm9nQ2BK9V7NqaooHKJsEDxndNbjnTEDrKC8axF", side, quoteAmount: lamports, tokenAmount: "1063414202700", price: "0.00000005", blockTime: "2026-11-06T11:53:40.000Z" },
          }),
        });
      }
    });
    return s;
  };
  const client = await connect({ ...FAKE_OPTIONS, liveSocket });
  const progress: string[] = [];
  const res = await client.callTool(
    { name: "watch_market", arguments: { events: ["buy", "sell"], mints: [MINT], min_sol: 1, max_events: 2 } },
    undefined,
    { onprogress: (p) => progress.push(`${p.progress}/${p.total} ${p.message}`) },
  );
  assert.equal(res.isError, undefined);
  const out = parse(res);
  assert.deepEqual(sent, [JSON.stringify({ op: "subscribe", channel: `trades:${MINT}` })]);
  assert.equal(out.ended, "max_events");
  assert.deepEqual(out.events.map((e: { kind: string; sol: number }) => [e.kind, e.sol]), [["sell", 2.5], ["buy", 1.2]]);
  assert.deepEqual(progress, [`1/2 sell ${MINT}, 2.5 SOL`, `2/2 buy ${MINT}, 1.2 SOL`]);

  const tooLong = await client.callTool({ name: "watch_market", arguments: { wait_seconds: 51 } });
  assert.equal(tooLong.isError, true);
});

test("place_order needs the policy's orders section, and a placed order can be listed and cancelled", async () => {
  const policy = { ...POLICY_TEMPLATE, cluster: "mainnet", actions: ["trade"], max_slippage_bps: 300 };
  const paths = signerHome(policy);
  const signer = new FixtureSigner(Keypair.generate(), paths);
  const client = await connect({ fetch: fixtureFetch("buy-curve"), retries: 0, signer });
  const args = { kind: "recurring_buy", mint: "EE3p42u2rACc3PEDcgVdqfg8JRxSYdvbn53rFoc3i1ix", sol: 0.01, every_hours: 24, times: 3, max_slippage_bps: 200, confirm_order: true };

  const refused = await client.callTool({ name: "place_order", arguments: args });
  assert.equal(refused.isError, true);
  assert.equal(parse(refused).code, "policy_refused");
  assert.match(parse(refused).error, /doesn't allow recurring_buy orders/);

  writeFileSync(paths.policy, JSON.stringify({ ...policy, orders: { kinds: ["recurring_buy"], max_open: 1 } }));
  const tooLoose = await client.callTool({ name: "place_order", arguments: { ...args, max_slippage_bps: 400 } });
  assert.equal(parse(tooLoose).code, "policy_refused");
  const mixed = await client.callTool({ name: "place_order", arguments: { ...args, trigger_price_sol: 1 } });
  assert.equal(mixed.isError, true);

  const placed = parse(await client.callTool({ name: "place_order", arguments: args }));
  assert.equal(placed.order.status, "open");
  assert.equal(placed.order.kind, "recurring_buy");
  assert.match(placed.order.description, /Buy 0.01 SOL of EE3p.* every 24 hours, 3 times/);
  assert.equal(placed.now.totalSol, 0.03);
  assert.equal(placed.live, false);
  assert.equal(placed.runner.running, false);
  assert.match(placed.runner.note, /highwire orders run/);

  const second = await client.callTool({ name: "place_order", arguments: args });
  assert.match(parse(second).error, /allows 1 open orders/);

  const listed = parse(await client.callTool({ name: "list_orders", arguments: {} }));
  assert.deepEqual(listed.orders.map((o: { id: string }) => o.id), [placed.order.id]);
  assert.deepEqual(listed.policy.orders, { kinds: ["recurring_buy"], max_open: 1 });

  const cancelled = parse(await client.callTool({ name: "cancel_order", arguments: { id: placed.order.id } }));
  assert.equal(cancelled.order.status, "cancelled");
  assert.equal(parse(await client.callTool({ name: "list_orders", arguments: {} })).orders.length, 0);
  assert.equal(parse(await client.callTool({ name: "cancel_order", arguments: { id: placed.order.id } })).code, "order_closed");
  assert.deepEqual(signer.audit.entries().filter((e) => e.outcome === "order").map((e) => e.reason?.split(":")[0]), ["placed", "cancelled"]);

  const { tools } = await client.listTools();
  assert.equal(tools.find((t) => t.name === "place_order")?.annotations?.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === "cancel_order")?.annotations?.destructiveHint, false);
});

test("a fee_claim order needs claims in the policy, and trades too when it buys back", async () => {
  const policy = { ...POLICY_TEMPLATE, cluster: "mainnet", actions: ["trade"], max_slippage_bps: 300, orders: { kinds: ["fee_claim"] } };
  const paths = signerHome(policy);
  const signer = new FixtureSigner(Keypair.generate(), paths);
  const client = await connect({ fetch: fixtureFetch("buy-curve"), retries: 0, signer });
  const args = { kind: "fee_claim", every_hours: 6, max_slippage_bps: 200, confirm_order: true };

  const noClaims = parse(await client.callTool({ name: "place_order", arguments: args }));
  assert.equal(noClaims.code, "policy_refused");
  assert.match(noClaims.error, /claims/);

  writeFileSync(paths.policy, JSON.stringify({ ...policy, actions: ["claim"] }));
  const halfBuyback = await client.callTool({ name: "place_order", arguments: { ...args, buyback_pct: 50 } });
  assert.equal(halfBuyback.isError, true);
  assert.match(parse(halfBuyback).error, /both buyback_pct and mint/);
  const buybackNoTrades = parse(await client.callTool({ name: "place_order", arguments: { ...args, buyback_pct: 50, mint: "EE3p42u2rACc3PEDcgVdqfg8JRxSYdvbn53rFoc3i1ix" } }));
  assert.equal(buybackNoTrades.code, "policy_refused");
  assert.match(buybackNoTrades.error, /can't buy back/);
  const priceOrderNoMint = await client.callTool({ name: "place_order", arguments: { ...args, kind: "stop_loss", trigger_change_pct: -20, every_hours: undefined } });
  assert.equal(priceOrderNoMint.isError, true);
});

test("post_chat signs in and posts only inside the policy's posts section, and post_comment keeps to the wallet's own coins", async () => {
  const posts: Array<{ path: string; body: string }> = [];
  const nonce = "3173c33f4db122bf328e5cee03592751";
  // higher.fun's sign-in and posting routes, in front of the usual fake API.
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const json = (status: number, b: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
    if (url.pathname === "/auth/nonce") return json(200, { nonce, message: signInMessage(body.wallet, nonce, new Date().toISOString()) });
    if (url.pathname === "/auth/verify") return json(200, { wallet: body.wallet }, { "set-cookie": "hf_session=abc; Path=/" });
    if (init?.method === "POST" && (url.pathname === "/chat" || url.pathname.endsWith("/comments"))) {
      if (new Headers(init.headers).get("cookie") !== "hf_session=abc") return json(401, { error: "unauthorized", message: "sign in required" });
      posts.push({ path: url.pathname, body: body.body });
      return json(201, { id: "c1", wallet: "w", displayName: "agent", body: body.body, createdAt: new Date().toISOString() });
    }
    return FAKE_OPTIONS.fetch(input as string);
  }) as typeof globalThis.fetch;
  const base = { ...POLICY_TEMPLATE, cluster: "mainnet", actions: ["launch"], live: true };

  const none = await connect({ ...FAKE_OPTIONS, fetch, signer: new LocalSigner(Keypair.generate(), signerHome(base)) });
  const refused = parse(await none.callTool({ name: "post_chat", arguments: { text: "gm", confirm_post: true } }));
  assert.equal(refused.code, "policy_refused");
  assert.match(refused.error, /no posts section/);

  const devnet = await connect({ ...FAKE_OPTIONS, fetch, cluster: "devnet", signer: new LocalSigner(Keypair.generate(), signerHome({ ...base, posts: { chat: true } })) });
  const wrong = parse(await devnet.callTool({ name: "post_chat", arguments: { text: "gm", confirm_post: true } }));
  assert.equal(wrong.code, "wrong_cluster");
  assert.match(wrong.error, /HIGHWIRE_CLUSTER/);

  const client = await connect({ ...FAKE_OPTIONS, fetch, signer: new LocalSigner(Keypair.generate(), signerHome({ ...base, posts: { chat: true } })) });
  const link = await client.callTool({ name: "post_chat", arguments: { text: "free sol at claim-sol.com", confirm_post: true } });
  assert.equal(link.isError, true);
  assert.equal(parse(link).code, "bad_post");
  const ok = parse(await client.callTool({ name: "post_chat", arguments: { text: "gm higher", confirm_post: true } }));
  assert.equal(ok.status, "posted");
  assert.equal(ok.postsLeftToday, 9);
  // Someone else's coin (its creator can't be read here, so it isn't this wallet's): refused, nothing posted.
  const other = parse(await client.callTool({ name: "post_comment", arguments: { mint: "EE3p42u2rACc3PEDcgVdqfg8JRxSYdvbn53rFoc3i1ix", text: "nice", confirm_post: true } }));
  assert.equal(other.code, "policy_refused");
  assert.deepEqual(posts, [{ path: "/chat", body: "gm higher" }]);
});

test("a limit_buy needs sol and a trigger under the current price, and is placed with the policy's rules", async () => {
  const policy = { ...POLICY_TEMPLATE, cluster: "mainnet", actions: ["trade"], max_slippage_bps: 300, max_sol_per_tx: 0.05, orders: { kinds: ["limit_buy"] } };
  const client = await connect({ fetch: fixtureFetch("buy-curve"), retries: 0, signer: new FixtureSigner(Keypair.generate(), signerHome(policy)) });
  const args = { kind: "limit_buy", mint: "EE3p42u2rACc3PEDcgVdqfg8JRxSYdvbn53rFoc3i1ix", sol: 0.01, trigger_change_pct: -20, max_slippage_bps: 200, confirm_order: true };
  const noSol = parse(await client.callTool({ name: "place_order", arguments: { ...args, sol: undefined } }));
  assert.match(noSol.error, /takes sol/);
  const tooBig = parse(await client.callTool({ name: "place_order", arguments: { ...args, sol: 0.1 } }));
  assert.equal(tooBig.code, "policy_refused");
  const atOnce = parse(await client.callTool({ name: "place_order", arguments: { ...args, trigger_change_pct: 10 } }));
  assert.match(atOnce.error, /would fill at once/);
  const placed = parse(await client.callTool({ name: "place_order", arguments: args }));
  assert.equal(placed.order.kind, "limit_buy");
  assert.equal(placed.order.sol, 0.01);
  assert.equal(placed.now.dropToTriggerPct, -20);
  assert.ok(placed.order.triggerPriceSol < placed.now.spotPriceSol);
  assert.match(placed.order.description, /^Buy 0.01 SOL of EE3p.* if its price falls to .* SOL or below$/);
  assert.ok(placed.order.expiresAt);
});

test("the server reports the package's own version", async () => {
  const { VERSION } = await import("../src/server.ts");
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version, "bump VERSION in src/server.ts with the release");
});
