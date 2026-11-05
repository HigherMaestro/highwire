import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { HIGHWIRE_MEMO, MAINNET, MEMO_PROGRAM_ID } from "../src/higher/constants.ts";
import { Chain } from "../src/tx/chain.ts";
import { assertSafe, MEMO_LINE } from "../src/tx/decode.ts";
import { highwireMemo } from "../src/tx/envelope.ts";
import type { Envelope } from "../src/tx/format.ts";
import { DerivedLaunchKeys, launchFingerprint } from "../src/tx/launch.ts";
import { lookupTableAddresses, platformClaimFeeWallet, reviewEnvelope } from "../src/tx/review.ts";
import {
  decodeSignPayload,
  encodeSignPayload,
  fromBase64Url,
  GZIP_PREFIX,
  parseEnvelope,
  SIGN_URL_GZIP_THRESHOLD,
  signUrl,
  toBase64Url,
} from "../src/tx/sign-link.ts";
import { replayFetch, type Recording } from "./replay.ts";
import { runScenario } from "./run-scenario.ts";
import { TRADER, type Scenario } from "./scenarios.ts";

const FEE_WALLET = "7j6tyzmUbb7K1J178ciwuvrTEd6VnK6fwan7tycM6g1Q";
const fixture = (name: Scenario): Recording => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

async function envelope(name: Scenario): Promise<{ env: Envelope; chain: Chain }> {
  const fetch = replayFetch(fixture(name));
  const r = (await runScenario(name, fetch)) as { envelope?: Envelope };
  assert.ok(r.envelope);
  return { env: r.envelope, chain: new Chain({ fetch }) };
}

const reb64 = (tx: VersionedTransaction) => Buffer.from(tx.serialize()).toString("base64");

/** The envelope with transaction `i` swapped for `tx`. */
function swap(env: Envelope, i: number, tx: VersionedTransaction): Envelope {
  return { ...env, transactions: env.transactions.map((t, j) => (j === i ? { ...t, base64: reb64(tx) } : t)) };
}

/** Recompiles the transaction with extra instructions appended. */
function withExtra(base64: string, ...extra: TransactionInstruction[]): VersionedTransaction {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
  const msg = TransactionMessage.decompile(tx.message);
  msg.instructions.push(...extra);
  return new VersionedTransaction(msg.compileToV0Message());
}

test("base64url round-trips any bytes", () => {
  const bytes = new Uint8Array(70_000).map((_, i) => (i * 31) & 0xff);
  assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes);
  assert.doesNotMatch(toBase64Url(bytes), /[+/=]/);
  assert.throws(() => fromBase64Url("not base64!"), /base64url/);
});

test("a buy's sign link round-trips, unzipped and under 8 KB", async () => {
  const { env } = await envelope("buy-curve");
  const url = await signUrl(env);
  assert.ok(url.startsWith("https://highwire.fun/sign#ey"), url.slice(0, 40));
  assert.ok(url.length <= SIGN_URL_GZIP_THRESHOLD, `${url.length}`);
  assert.deepEqual(await decodeSignPayload(new URL(url).hash), env);
  assert.ok((await signUrl(env, "http://localhost:3000/")).startsWith("http://localhost:3000/sign#"));
});

test("gzipped payloads round-trip, and a long envelope switches to gzip", async () => {
  const { env } = await envelope("launch-rewards");
  const zipped = await encodeSignPayload(env, { compress: true });
  assert.ok(zipped.startsWith(GZIP_PREFIX));
  assert.deepEqual(await decodeSignPayload(zipped), env);
  // Pad the summaries until the plain URL would pass the threshold.
  const big: Envelope = { ...env, transactions: env.transactions.map((t) => ({ ...t, summary: [...t.summary, "x".repeat(900), "y".repeat(900)] })) };
  const url = await signUrl(big);
  assert.ok(new URL(url).hash.startsWith(`#${GZIP_PREFIX}`));
  assert.deepEqual(await decodeSignPayload(new URL(url).hash), big);
});

test("decoding refuses junk, other formats and bombs", async () => {
  const { env } = await envelope("buy-curve");
  await assert.rejects(decodeSignPayload(""), /no transaction/);
  await assert.rejects(decodeSignPayload("#!!!"), /base64url/);
  await assert.rejects(decodeSignPayload(toBase64Url(new TextEncoder().encode("[1,2]"))), /not a Highwire envelope/);
  await assert.rejects(decodeSignPayload(toBase64Url(new TextEncoder().encode(JSON.stringify({ ...env, format: "other/v9" })))), /format/);
  await assert.rejects(decodeSignPayload(toBase64Url(new TextEncoder().encode(JSON.stringify({ ...env, cluster: "testnet" })))), /cluster/);
  await assert.rejects(decodeSignPayload(`${GZIP_PREFIX}AAAA`), /decompress/);
  const bomb = await encodeSignPayload({ ...env, howToSign: "z".repeat(400_000) }, { compress: true });
  await assert.rejects(decodeSignPayload(bomb), /too large/);
  assert.throws(() => parseEnvelope({ ...env, transactions: [{ ...env.transactions[0], dependsOn: [3] }] }), /later one/);
});

test("every built transaction carries the Highwire memo, described in its summary", async () => {
  for (const name of ["buy-curve", "sell-graduated", "launch-rewards", "claim"] as const) {
    const { env } = await envelope(name);
    for (const t of env.transactions) {
      assert.ok(t.summary.includes(`${t.summary.length - 1}. ${MEMO_LINE}`), `${name}: ${t.summary.at(-1)}`);
      const tx = VersionedTransaction.deserialize(Buffer.from(t.base64, "base64"));
      const memo = tx.message.compiledInstructions.filter((ix) => tx.message.staticAccountKeys[ix.programIdIndex]?.toBase58() === MEMO_PROGRAM_ID);
      assert.equal(memo.length, 1, name);
      assert.equal(Buffer.from(memo[0]!.data).toString("utf8"), HIGHWIRE_MEMO);
      assert.equal(memo[0]!.accountKeyIndexes.length, 0);
    }
  }
});

test("the checker allows only the Highwire memo, once", () => {
  const wallet = Keypair.generate().publicKey;
  const tx = (...ixs: TransactionInstruction[]) =>
    new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message());
  assertSafe(tx(highwireMemo()), "mainnet", { wallet });
  const other = new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from("claim your airdrop") });
  assert.throws(() => assertSafe(tx(other), "mainnet", { wallet }), /memo other than Highwire's/);
  assert.throws(() => assertSafe(tx(highwireMemo(), highwireMemo()), "mainnet", { wallet }), /more than one memo/);
});

test("the review passes recorded builds and rebuilds their summaries from the bytes", async () => {
  for (const name of ["buy-curve", "sell-curve", "buy-graduated", "sell-graduated", "claim"] as const) {
    const { env } = await envelope(name);
    const r = reviewEnvelope(env);
    assert.deepEqual(r.problems, [], name);
    for (const t of r.transactions) assert.equal(t.summaryMatches, true, name);
  }
  const buy = reviewEnvelope((await envelope("buy-curve")).env);
  const t = buy.transactions[0]!;
  assert.equal(t.effects[0]!.kind, "spend");
  assert.equal(t.effects[0]!.text, "0.01 SOL");
  assert.match(t.effects[1]!.text, /^at least [\d,.]+ tokens of EE3p/);
  assert.equal(t.networkFeeLamports, 5_000n);
  assert.ok(t.priorityFeeLamports > 0n);
});

test("the review of a launch needs the on-chain fee wallet and its lookup tables", async () => {
  const { env, chain } = await envelope("launch-rewards");
  const tables = await Promise.all(lookupTableAddresses(env).map(async (a) => (await chain.connection.getAddressLookupTable(new PublicKey(a))).value!));
  const ok = reviewEnvelope(env, { launchFeeWallet: FEE_WALLET, lookupTables: tables });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.launches.length, 1);
  assert.ok(ok.transactions[0]!.effects.some((e) => e.kind === "spend" && e.text.includes("launch fee")));
  assert.ok(ok.transactions[1]!.effects.some((e) => e.text.startsWith("Lock 50,000,000 tokens")));
  assert.equal(ok.transactions[0]!.networkFeeLamports, 10_000n, "the wallet and the presigned mint");
  // Without the fee wallet, the fee is a transfer to a stranger.
  const blind = reviewEnvelope(env, { lookupTables: tables });
  assert.ok(blind.problems.some((p) => /not the wallet's own token account/.test(p)));
  // A different fee wallet fails the same way.
  assert.ok(reviewEnvelope(env, { launchFeeWallet: TRADER.toBase58(), lookupTables: tables }).problems.length > 0);
});

test("the review refuses a tampered link", async () => {
  const { env } = await envelope("buy-curve");
  const t = env.transactions[0]!;
  const stranger = Keypair.generate().publicKey;
  const drain = SystemProgram.transfer({ fromPubkey: TRADER, toPubkey: stranger, lamports: 1_000_000_000 });
  const drained = reviewEnvelope(swap(env, 0, withExtra(t.base64, drain)));
  assert.ok(drained.problems.some((p) => /not the wallet's own token account/.test(p)), drained.problems.join("; "));
  assert.equal(drained.transactions[0]!.summaryMatches, false);

  const unknownProgram = new TransactionInstruction({ programId: stranger, keys: [], data: Buffer.from([1]) });
  const odd = reviewEnvelope(swap(env, 0, withExtra(t.base64, unknownProgram)));
  assert.ok(odd.problems.some((p) => /outside the allow-list/.test(p)));
  assert.ok(odd.problems.some((p) => /isn't one Highwire builds/.test(p)));

  const foreign = reviewEnvelope({ ...env, wallet: stranger.toBase58(), transactions: [{ ...t, walletSigner: stranger.toBase58(), feePayer: stranger.toBase58() }] });
  assert.ok(foreign.problems.some((p) => /fee payer isn't the envelope's wallet/.test(p)));

  const extraSigner = withExtra(t.base64, SystemProgram.transfer({ fromPubkey: stranger, toPubkey: TRADER, lamports: 1 }));
  assert.ok(reviewEnvelope(swap(env, 0, extraSigner)).problems.some((p) => /needs a signature from/.test(p)));

  assert.ok(reviewEnvelope({ ...env, transactions: [{ ...t, base64: "AAAA" }] }).problems.some((p) => /v0 Solana transaction/.test(p)));
});

test("the review refuses a trade on another LaunchLab platform", async () => {
  const { env } = await envelope("buy-curve");
  const tx = VersionedTransaction.deserialize(Buffer.from(env.transactions[0]!.base64, "base64"));
  const keys = tx.message.staticAccountKeys;
  const i = keys.findIndex((k) => k.toBase58() === MAINNET.rewardsPlatform);
  assert.ok(i > 0);
  keys[i] = Keypair.generate().publicKey;
  const r = reviewEnvelope(swap(env, 0, tx));
  assert.ok(r.problems.some((p) => /isn't higher.fun's/.test(p)), r.problems.join("; "));
});

test("the fee wallet is read from a platform config account", () => {
  const data = new Uint8Array(200);
  data.set(new PublicKey(FEE_WALLET).toBytes(), 16);
  assert.equal(platformClaimFeeWallet(data), FEE_WALLET);
  assert.throws(() => platformClaimFeeWallet(new Uint8Array(20)), /too short/);
});

test("derived launch mints are stable across instances and differ per coin and secret", () => {
  const fp = launchFingerprint("mainnet", { wallet: TRADER, name: "Cat", ticker: "CAT", mode: "rewards" });
  const a = new DerivedLaunchKeys("s3cret").get("key-123456", fp);
  assert.ok(new DerivedLaunchKeys("s3cret").get("key-123456", fp).publicKey.equals(a.publicKey), "a fresh instance agrees");
  assert.ok(!new DerivedLaunchKeys("other").get("key-123456", fp).publicKey.equals(a.publicKey));
  assert.ok(!new DerivedLaunchKeys("s3cret").get("key-654321", fp).publicKey.equals(a.publicKey));
  const other = launchFingerprint("mainnet", { wallet: TRADER, name: "Cat", ticker: "DOG", mode: "rewards" });
  assert.ok(!new DerivedLaunchKeys("s3cret").get("key-123456", other).publicKey.equals(a.publicKey));
});

test("the browser entry never reaches Node built-ins or Raydium's SDK", () => {
  const seen = new Set<string>();
  const banned: string[] = [];
  const visit = (url: URL) => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const src = readFileSync(url, "utf8");
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gms)) {
      const spec = m[1]!;
      if (spec.startsWith(".")) visit(new URL(spec, url));
      else if (spec.startsWith("node:") || spec.startsWith("@raydium-io/") || spec === "@solana/spl-token" || spec === "bn.js") banned.push(`${url.pathname.split("/src/")[1]}: ${spec}`);
    }
  };
  visit(new URL("../src/browser.ts", import.meta.url));
  assert.deepEqual(banned, []);
  assert.ok(seen.size >= 7);
});
