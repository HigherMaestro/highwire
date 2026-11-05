import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { Chain } from "../src/tx/chain.ts";
import { ENVELOPE_FORMATS, type Envelope } from "../src/tx/format.ts";
import {
  assertSameExceptBlockhash,
  canRefresh,
  isRefreshable,
  linkAgeSeconds,
  REFRESH_MAX_AGE_SECONDS,
  refreshableIndexes,
  refreshEnvelope,
  sameExceptBlockhash,
  withBlockhash,
} from "../src/tx/refresh.ts";
import { lookupTableAddresses, reviewEnvelope } from "../src/tx/review.ts";
import { decodeSignPayload, encodeSignPayload } from "../src/tx/sign-link.ts";
import { replayFetch, type Recording } from "./replay.ts";
import { runScenario } from "./run-scenario.ts";
import type { Scenario } from "./scenarios.ts";

const fixture = (name: Scenario): Recording => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
async function envelope(name: Scenario): Promise<{ env: Envelope; chain: Chain }> {
  const fetch = replayFetch(fixture(name));
  const r = (await runScenario(name, fetch)) as { envelope?: Envelope };
  assert.ok(r.envelope);
  return { env: r.envelope, chain: new Chain({ fetch }) };
}
const txOf = (base64: string) => VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
const FRESH = { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 999_999_999 };

test("a trade is refreshable: only its blockhash and expiry change, and it still passes the review", async () => {
  const { env } = await envelope("buy-curve");
  assert.equal(typeof env.builtAt, "number");
  assert.equal(env.format, ENVELOPE_FORMATS[1]);
  assert.deepEqual(refreshableIndexes(env), [0]);
  const { env: next, refreshed } = refreshEnvelope(env, FRESH, env.builtAt! + 120);
  assert.deepEqual(refreshed, [0]);
  const [a, b] = [txOf(env.transactions[0]!.base64), txOf(next.transactions[0]!.base64)];
  assert.equal(b.message.recentBlockhash, FRESH.blockhash);
  assert.equal(next.transactions[0]!.recentBlockhash, FRESH.blockhash);
  assert.equal(next.transactions[0]!.lastValidBlockHeight, FRESH.lastValidBlockHeight);
  assert.ok(sameExceptBlockhash(a, b));
  assert.deepEqual(a.message.compiledInstructions, b.message.compiledInstructions);
  const review = reviewEnvelope(next);
  assert.deepEqual(review.problems, []);
  assert.equal(review.transactions[0]!.summaryMatches, true, "the summary doesn't mention the blockhash");
});

test("a launch's presigned create stays strict; its unsigned lock assignment may refresh", async () => {
  const { env, chain } = await envelope("launch-rewards");
  const [create, lock] = env.transactions.map((t) => txOf(t.base64));
  assert.equal(isRefreshable(create!, env.wallet), false);
  assert.throws(() => withBlockhash(create!, env.wallet, FRESH.blockhash), /another signer's signature/);
  assert.equal(isRefreshable(lock!, env.wallet), true);
  const { env: next, refreshed } = refreshEnvelope(env, FRESH, env.builtAt! + 30);
  assert.deepEqual(refreshed, [1]);
  assert.equal(next.transactions[0]!.base64, env.transactions[0]!.base64, "the create's bytes are untouched");
  const tables = await Promise.all(lookupTableAddresses(next).map(async (a) => (await chain.connection.getAddressLookupTable(new PublicKey(a))).value!));
  assert.deepEqual(reviewEnvelope(next, { launchFeeWallet: "7j6tyzmUbb7K1J178ciwuvrTEd6VnK6fwan7tycM6g1Q", lookupTables: tables }).problems, []);
});

test("anything but the blockhash changing is refused", async () => {
  const { env } = await envelope("buy-curve");
  const original = txOf(env.transactions[0]!.base64);
  const refreshed = withBlockhash(original, env.wallet, FRESH.blockhash);

  // A changed amount in the trade instruction.
  const bumped = VersionedMessage.deserialize(refreshed.message.serialize());
  const ix = bumped.compiledInstructions.find((c) => c.data.length >= 24)!;
  ix.data = Uint8Array.from(ix.data);
  ix.data[8] = (ix.data[8]! + 1) & 0xff;
  assert.equal(sameExceptBlockhash(original, new VersionedTransaction(bumped)), false);
  assert.throws(() => assertSameExceptBlockhash(original, new VersionedTransaction(bumped)), /more than its blockhash/);

  // A swapped account.
  const moved = VersionedMessage.deserialize(refreshed.message.serialize());
  moved.staticAccountKeys[moved.staticAccountKeys.length - 1] = Keypair.generate().publicKey;
  assert.throws(() => assertSameExceptBlockhash(original, new VersionedTransaction(moved)), /more than its blockhash/);

  // The untouched refresh passes.
  assertSameExceptBlockhash(original, refreshed);
});

test("refresh only while the link is at most 10 minutes old, and never for a v1 link", async () => {
  const { env } = await envelope("buy-curve");
  const built = env.builtAt!;
  assert.equal(linkAgeSeconds(env, built + 61), 61);
  assert.equal(canRefresh(env, built + REFRESH_MAX_AGE_SECONDS), true);
  assert.equal(canRefresh(env, built + REFRESH_MAX_AGE_SECONDS + 1), false);
  assert.deepEqual(refreshEnvelope(env, FRESH, built + REFRESH_MAX_AGE_SECONDS + 1).refreshed, []);

  const { builtAt: _drop, ...rest } = env;
  const v1: Envelope = { ...rest, format: ENVELOPE_FORMATS[0] };
  const decoded = await decodeSignPayload(await encodeSignPayload(v1));
  assert.equal(decoded.format, ENVELOPE_FORMATS[0], "old links still decode");
  assert.equal(decoded.builtAt, undefined);
  assert.equal(linkAgeSeconds(decoded, built), null);
  assert.deepEqual(refreshEnvelope(decoded, FRESH, built).refreshed, [], "a link with no builtAt is strict");

  // A v2 link must say when it was built.
  await assert.rejects(decodeSignPayload(await encodeSignPayload({ ...rest } as Envelope)), /builtAt/);
});
