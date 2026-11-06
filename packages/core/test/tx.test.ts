import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createHttpConfig } from "../src/lib/http.ts";
import { HigherApi } from "../src/higher/api.ts";
import { MAINNET } from "../src/higher/constants.ts";
import { Chain } from "../src/tx/chain.ts";
import { assertSafe, describeTransaction, UnsafeTransactionError } from "../src/tx/decode.ts";
import { ENVELOPE_FORMAT, type Envelope } from "../src/tx/envelope.ts";
import { buildLaunch, LaunchKeys, launchFingerprint, validateLaunch, type LaunchInput } from "../src/tx/launch.ts";
import { MAX_LISTING_BYTES, walletPositions } from "../src/tx/positions.ts";
import { reviewEnvelope } from "../src/tx/review.ts";
import { signUrl } from "../src/tx/sign-link.ts";
import type { Finished } from "../src/tx/envelope.ts";
import { formatLamports, formatTokens, solToLamports, tokensToBase } from "../src/tx/units.ts";
import { replayFetch, type Recording } from "./replay.ts";
import { runScenario } from "./run-scenario.ts";
import { CLAIM_COIN, CREATOR, CURVE_COIN, GRADUATED_COIN, GRADUATED_HOLDER, LAUNCH_MINT, LAUNCH_URI, TRADER, type Scenario } from "./scenarios.ts";

const fixture = (name: Scenario): Recording => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const replay = (name: Scenario) => runScenario(name, replayFetch(fixture(name)));

function envelopeOf(result: unknown): Envelope {
  const env = (result as { envelope?: Envelope }).envelope;
  assert.ok(env, "expected an envelope");
  return env;
}

function checkEnvelope(env: Envelope, wallet: PublicKey) {
  assert.equal(env.format, ENVELOPE_FORMAT);
  assert.equal(env.cluster, "mainnet");
  assert.equal(env.wallet, wallet.toBase58());
  for (const t of env.transactions) {
    const tx = VersionedTransaction.deserialize(Buffer.from(t.base64, "base64"));
    assert.equal(tx.version, 0);
    assert.equal(tx.message.staticAccountKeys[0]!.toBase58(), wallet.toBase58(), "the wallet pays");
    assert.equal(t.walletSigner, wallet.toBase58());
    assert.equal(t.fullyDecoded, true, t.summary.join("\n"));
    // The wallet's signature slot is empty: Highwire never signs for it.
    assert.ok(tx.signatures[0]!.every((b) => b === 0));
  }
}

test("units convert exactly, without floats", () => {
  assert.equal(solToLamports(0.1), 100_000_000n);
  assert.equal(solToLamports("1.000000001"), 1_000_000_001n);
  assert.equal(tokensToBase(1_000_000), 1_000_000_000_000n);
  assert.equal(formatLamports(20_000_000n), "0.02");
  assert.equal(formatTokens(1_234_500_000n), "1,234.5");
  assert.throws(() => solToLamports(-1));
});

test("a curve buy matches the quote, passes the checks and simulated", async () => {
  const r = await replay("buy-curve");
  assert.ok(r && "quote" in r);
  assert.equal(r.quote.stage, "curve");
  assert.equal(r.quote.mode, "rewards");
  assert.equal(r.quote.amountInUsed, solToLamports(0.01));
  // New school: 1% in fees, split Raydium 0.25 / higher.fun 0.5 / creator 0.25.
  assert.equal(r.quote.feeTotalLamports, 100_000n);
  assert.deepEqual(r.quote.fees.map((f) => f.lamports), [25_000n, 50_000n, 25_000n]);
  assert.equal(r.quote.minOut, (r.quote.amountOut * 9_800n) / 10_000n);
  const env = envelopeOf(r);
  checkEnvelope(env, TRADER);
  assert.equal(env.kind, "trade");
  const t = env.transactions[0]!;
  assert.equal(t.simulation.ok, true);
  assert.ok(t.summary.some((l) => l.includes(`Buy coin ${CURVE_COIN.toBase58()} on the LaunchLab curve`) && l.includes("pay 0.01 SOL")));
  assert.equal(r.decoded[0]!.trades[0]!.minOut, r.quote.minOut);
});

test("a curve sell builds and simulated", async () => {
  const r = await replay("sell-curve");
  assert.ok(r && "quote" in r);
  assert.equal(r.quote.side, "sell");
  assert.equal(r.quote.amountIn, tokensToBase(100_000));
  const env = envelopeOf(r);
  checkEnvelope(env, TRADER);
  assert.equal(env.transactions[0]!.simulation.ok, true);
  assert.equal(r.decoded[0]!.trades[0]!.kind, "curve-sell");
});

test("a graduated coin trades in its CPMM pool, with the pool creator fee", async () => {
  for (const name of ["buy-graduated", "sell-graduated"] as const) {
    const r = await replay(name);
    assert.ok(r && "quote" in r);
    assert.equal(r.quote.stage, "graduated");
    assert.equal(r.quote.mode, "classic");
    assert.ok(r.quote.fees.some((f) => f.to.includes("creator") && f.lamports > 0n));
    const env = envelopeOf(r);
    assert.equal(env.transactions[0]!.simulation.ok, true, name);
    const trade = r.decoded[0]!.trades[0]!;
    assert.equal(trade.kind, "cpmm-swap");
    assert.equal(name === "buy-graduated" ? trade.outputMint : trade.inputMint, GRADUATED_COIN.toBase58());
  }
});

test("a New school launch with a creator lock and a first buy", async () => {
  const r = await replay("launch-rewards");
  assert.ok(r && "status" in r && r.status === "built");
  assert.equal(r.mint, LAUNCH_MINT.publicKey.toBase58());
  assert.equal(r.platformId, MAINNET.rewardsPlatform);
  assert.equal(r.launchFee?.sol, 0.02);
  assert.equal(r.launchFee?.treasury, "7j6tyzmUbb7K1J178ciwuvrTEd6VnK6fwan7tycM6g1Q");
  assert.equal(r.creatorLock?.tokens, 50_000_000_000_000n);
  const env = r.envelope;
  checkEnvelope(env, TRADER);
  assert.equal(env.transactions.length, 2);
  const [create, lock] = env.transactions;
  assert.equal(create!.simulation.ok, true);
  assert.deepEqual(create!.presigned, [LAUNCH_MINT.publicKey.toBase58()]);
  assert.ok(create!.summary.some((l) => l.includes(`metadata ${LAUNCH_URI}`)));
  assert.ok(create!.summary.some((l) => l.includes("Send 0.02 SOL") && l.includes("7j6tyzmUbb7K1J178ciwuvrTEd6VnK6fwan7tycM6g1Q")));
  // The mint's signature is in place; it's checked against the message.
  const tx = VersionedTransaction.deserialize(Buffer.from(create!.base64, "base64"));
  const mintIndex = tx.message.staticAccountKeys.findIndex((k) => k.equals(LAUNCH_MINT.publicKey));
  assert.ok(tx.signatures[mintIndex]!.some((b) => b !== 0));
  assert.deepEqual(lock!.dependsOn, [0]);
  assert.ok(lock!.simulation.skipped);
  assert.ok(lock!.summary.some((l) => l.includes("Assign 50,000,000 locked tokens")));
});

test("a launch refuses a launch fee that isn't going to higher.fun's fee wallet", async () => {
  const fetch = replayFetch(fixture("launch-rewards"), {
    "get:https://api.higher.fun/launch-fee": { lamports: "20000000", treasury: "Stranger11111111111111111111111111111111111" },
  });
  const chain = new Chain({ fetch });
  const api = new HigherApi(createHttpConfig({ baseUrl: "https://api.higher.fun", fetch, retries: 0 }));
  await assert.rejects(
    buildLaunch(chain, api, { ...launchInput(), metadataUri: LAUNCH_URI }),
    (e: unknown) => e instanceof UnsafeTransactionError && /fee wallet/.test(e.message),
  );
});

test("a launch refuses a fee above the cap", async () => {
  const fetch = replayFetch(fixture("launch-rewards"), {
    "get:https://api.higher.fun/launch-fee": { lamports: "60000000", treasury: "7j6tyzmUbb7K1J178ciwuvrTEd6VnK6fwan7tycM6g1Q" },
  });
  const chain = new Chain({ fetch });
  const api = new HigherApi(createHttpConfig({ baseUrl: "https://api.higher.fun", fetch, retries: 0 }));
  await assert.rejects(buildLaunch(chain, api, { ...launchInput(), metadataUri: LAUNCH_URI }), /above higher.fun's cap/);
});

function launchInput(): LaunchInput {
  return {
    wallet: TRADER,
    name: "Highwire Sim",
    ticker: "HWSIMX",
    mode: "rewards",
    creatorLockPct: 5,
    devBuyLamports: solToLamports(0.05),
    slippageBps: 500,
    mint: LAUNCH_MINT,
  };
}

test("without a metadata URI, a launch returns the metadata to host", async () => {
  const r = await buildLaunch(new Chain({ fetch: replayFetch({}) }), null, {
    ...launchInput(),
    imageUrl: "https://example.com/coin.png",
    x: "https://x.com/highwire",
  });
  assert.equal(r.status, "needs_metadata");
  assert.ok(r.status === "needs_metadata" && r.metadata.image === "https://example.com/coin.png");
  assert.ok(r.status === "needs_metadata" && r.metadata.extensions.twitter === "https://x.com/highwire");
});

test("launch inputs are checked like higher.fun's form", () => {
  assert.throws(() => validateLaunch({ ...launchInput(), mode: "classic" }), /creator lock needs New school/);
  assert.throws(() => validateLaunch({ ...launchInput(), creatorLockPct: 11 }), /1-10%/);
  assert.throws(() => validateLaunch({ ...launchInput(), ticker: "$HIGH" }), /ticker/);
  assert.throws(() => validateLaunch({ ...launchInput(), x: "https://evil.example/x" }), /x must be on/);
  assert.throws(() => validateLaunch({ ...launchInput(), name: "Official​" }), /invisible/);
});

test("an idempotency key keeps its mint, and refuses a different coin", () => {
  const keys = new LaunchKeys();
  const fp = launchFingerprint("mainnet", launchInput());
  const a = keys.get("launch-123", fp);
  assert.ok(keys.get("launch-123", fp).publicKey.equals(a.publicKey));
  assert.throws(() => keys.get("launch-123", launchFingerprint("mainnet", { ...launchInput(), ticker: "OTHER" })), /different launch/);
  assert.ok(!keys.get("launch-456", fp).publicKey.equals(a.publicKey));
});

test("creator fee claims cover the curve vault and the graduated pool", async () => {
  const r = await replay("claim");
  assert.ok(r && "claimable" in r);
  assert.ok(r.claimable.curveSol > 0);
  assert.ok(r.claimable.pools.some((p) => p.mint === CLAIM_COIN.toBase58() && p.sol > 0));
  const env = envelopeOf(r);
  checkEnvelope(env, CREATOR);
  assert.ok(env.transactions.every((t) => t.simulation.ok));
  assert.ok(env.transactions.some((t) => t.summary.some((l) => l.includes("Claim curve creator fees"))));
  assert.ok(env.transactions.some((t) => t.summary.some((l) => l.includes("Collect the pool creator fees"))));
});

test("positions keep only higher.fun coins, recognised on-chain", async () => {
  const r = await replay("positions");
  assert.ok(r && "positions" in r);
  const fischer = r.positions.find((p) => p.mint === GRADUATED_COIN.toBase58());
  assert.ok(fischer, "holds $Fischer");
  assert.equal(fischer.feeMode, "classic");
  assert.equal(fischer.stage, "graduated");
  assert.ok(fischer.priceSol && fischer.priceSol > 0);
});

test("positions for named coins read only those coins' accounts", async () => {
  const r = await replay("positions-mints");
  assert.ok(r && "positions" in r);
  const fischer = r.positions.find((p) => p.mint === GRADUATED_COIN.toBase58());
  assert.ok(fischer, "holds $Fischer");
  assert.equal(fischer.stage, "graduated");
  assert.ok(fischer.priceSol && fischer.priceSol > 0);
  assert.ok(r.solBalance > 0);
  await assert.rejects(walletPositions(new Chain({ fetch: replayFetch({}) }), null, TRADER, { mints: Array(51).fill(CURVE_COIN) }), /at most 50/);
});

test("a wallet with too many token accounts to list gets a clear error, not a hang", async () => {
  const huge = Buffer.alloc(MAX_LISTING_BYTES + 1024, " ");
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const { method, id } = JSON.parse(String(init?.body));
    if (method === "getTokenAccountsByOwner") return new Response(huge, { headers: { "content-type": "application/json" } });
    if (method === "getBalance") return Response.json({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: 1 } });
    throw new Error(`unexpected ${method}`);
  }) as typeof globalThis.fetch;
  await assert.rejects(walletPositions(new Chain({ fetch }), null, TRADER), (e: { code?: string }) => e.code === "too_many_tokens");
});

test("a SOL transfer sends exactly the amount to exactly the recipient, and gets no sign link", async () => {
  const { transfer: r } = (await replay("transfer-sol")) as { transfer: Finished };
  const env = envelopeOf(r);
  checkEnvelope(env, TRADER);
  assert.equal(env.kind, "transfer");
  const t = env.transactions[0]!;
  assert.ok(t.simulation.ok);
  assert.ok(t.summary.some((l) => l.includes(`Send 0.01 SOL from ${TRADER.toBase58()} to ${CREATOR.toBase58()}`)), t.summary.join("\n"));
  await assert.rejects(signUrl(env), /no sign link/);
  // The sign page's review refuses it: its expectations never allow SOL to leave for another wallet.
  assert.ok(reviewEnvelope(env).problems.some((p) => p.includes("not the wallet's own")), "the sign page refuses transfers");

  const tx = VersionedTransaction.deserialize(Buffer.from(t.base64, "base64"));
  const ok = { wallet: TRADER, allowLaunchLab: false, allowCpmm: false, transfer: { to: CREATOR, lamports: solToLamports(0.01) } };
  assert.doesNotThrow(() => assertSafe(tx, "mainnet", ok));
  assert.throws(() => assertSafe(tx, "mainnet", { ...ok, transfer: { to: CREATOR, lamports: solToLamports(0.02) } }), /different amount/);
  assert.throws(() => assertSafe(tx, "mainnet", { ...ok, transfer: { to: GRADUATED_HOLDER, lamports: solToLamports(0.01) } }), UnsafeTransactionError);
});

test("a coin transfer goes from the wallet's account to the recipient's, which it may open", async () => {
  const { transfer: r } = (await replay("transfer-coin")) as { transfer: Finished };
  const env = envelopeOf(r);
  checkEnvelope(env, GRADUATED_HOLDER);
  const t = env.transactions[0]!;
  assert.ok(t.simulation.ok);
  assert.ok(t.summary.some((l) => l.includes(`Send 1,000 tokens of ${GRADUATED_COIN.toBase58()}`)), t.summary.join("\n"));
  assert.ok(t.summary.some((l) => l.includes(`owned by ${TRADER.toBase58()}`)), "opens the recipient's account");
  assert.equal(r.decoded[0]!.tokenTransfers[0]!.amount, tokensToBase(1_000));
  assert.ok(reviewEnvelope(env).problems.length > 0, "the sign page refuses transfers");

  const tx = VersionedTransaction.deserialize(Buffer.from(t.base64, "base64"));
  const ok = { wallet: GRADUATED_HOLDER, allowLaunchLab: false, allowCpmm: false, transfer: { to: TRADER, mint: GRADUATED_COIN, amount: tokensToBase(1_000) } };
  assert.doesNotThrow(() => assertSafe(tx, "mainnet", ok));
  assert.throws(() => assertSafe(tx, "mainnet", { ...ok, transfer: { ...ok.transfer, amount: tokensToBase(999) } }), /different amount/);
  assert.throws(() => assertSafe(tx, "mainnet", { ...ok, transfer: { ...ok.transfer, mint: CURVE_COIN } }), UnsafeTransactionError);
  assert.throws(() => assertSafe(tx, "mainnet", { ...ok, transfer: { ...ok.transfer, to: CREATOR } }), UnsafeTransactionError);
  assert.throws(() => assertSafe(tx, "mainnet", { wallet: GRADUATED_HOLDER }), /never makes|someone else/);
});

// Safety checks on hand-built transactions.

const wallet = Keypair.generate().publicKey;
const stranger = Keypair.generate().publicKey;
function txOf(payer: PublicKey, ...ixs: Parameters<typeof SystemProgram.transfer>[0][]) {
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: ixs.map((i) => SystemProgram.transfer(i)),
    }).compileToV0Message(),
  );
}

test("the checker refuses SOL sent to someone else", () => {
  const tx = txOf(wallet, { fromPubkey: wallet, toPubkey: stranger, lamports: 1 });
  assert.throws(() => assertSafe(tx, "mainnet", { wallet }), /not the wallet's own wrapped-SOL account/);
});

test("the checker refuses a different fee payer", () => {
  const tx = txOf(stranger, { fromPubkey: stranger, toPubkey: wallet, lamports: 1 });
  assert.throws(() => assertSafe(tx, "mainnet", { wallet }), /paid by a different wallet/);
});

test("the checker allows exactly one launch fee, at or under the quote", () => {
  const fee = { to: stranger, maxLamports: 20_000_000n };
  assertSafe(txOf(wallet, { fromPubkey: wallet, toPubkey: stranger, lamports: 20_000_000 }), "mainnet", { wallet, launchFee: fee });
  assert.throws(
    () => assertSafe(txOf(wallet, { fromPubkey: wallet, toPubkey: stranger, lamports: 20_000_001 }), "mainnet", { wallet, launchFee: fee }),
    /above the quoted amount/,
  );
  const twice = txOf(wallet, { fromPubkey: wallet, toPubkey: stranger, lamports: 1 }, { fromPubkey: wallet, toPubkey: stranger, lamports: 1 });
  assert.throws(() => assertSafe(twice, "mainnet", { wallet, launchFee: fee }), /more than one launch fee/);
});

test("a recorded trade fails the checks for another platform", async () => {
  const r = await replay("buy-curve");
  const tx = VersionedTransaction.deserialize(Buffer.from(envelopeOf(r).transactions[0]!.base64, "base64"));
  assert.throws(() => assertSafe(tx, "mainnet", { wallet: TRADER, platformId: new PublicKey(MAINNET.classicPlatform) }), /platform other than/);
  assert.equal(describeTransaction(tx, "mainnet").trades.length, 1);
});

test("no build, and no positions read for named coins, lists every token account a wallet owns (a busy wallet's list runs to hundreds of megabytes)", async () => {
  for (const name of ["buy-curve", "sell-curve", "buy-graduated", "sell-graduated", "launch-rewards", "claim", "positions-mints"] as const) {
    const methods: string[] = [];
    const inner = replayFetch(fixture(name));
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === "string" && init.body.startsWith("{")) methods.push(JSON.parse(init.body).method);
      return inner(input, init);
    }) as typeof globalThis.fetch;
    await runScenario(name, fetch);
    assert.ok(methods.length > 0, name);
    for (const m of ["getTokenAccountsByOwner", "getParsedTokenAccountsByOwner", "getProgramAccounts"]) assert.ok(!methods.includes(m), `${name} called ${m}`);
  }
});
