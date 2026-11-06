import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { ADDRESSES, type Cluster } from "../src/higher/constants.ts";
import { HigherError } from "../src/lib/errors.ts";
import type { Chain } from "../src/tx/chain.ts";
import { applyEvents, coinPnl, emptyBook, pnlTotals, summarizeCoinPnl, txEffect, type CoinPnl, type PnlEvent } from "../src/tx/pnl.ts";

// Real transactions, saved from mainnet and devnet on 2026-11-06 (instructions left out; txEffect reads only balances
// and logs). The devnet pair is the standing-orders trial: a 0.005 SOL buy, then a sell of half.
interface Saved {
  cluster: Cluster;
  wallet: string;
  mint: string;
  signature: string;
  tx: ParsedTransactionWithMeta & { transaction: { message: { accountKeys: { pubkey: string | PublicKey }[] } } };
}
const SAVED: Saved[] = JSON.parse(readFileSync(new URL("./fixtures/pnl-transactions.json", import.meta.url), "utf8"));
for (const s of SAVED) s.tx.transaction.message.accountKeys = s.tx.transaction.message.accountKeys.map((k) => ({ ...k, pubkey: new PublicKey(k.pubkey) }));

const effect = (prefix: string) => {
  const s = SAVED.find((x) => x.signature.startsWith(prefix))!;
  return txEffect(s.tx, s.signature, s.wallet, s.mint, ADDRESSES[s.cluster].launchLabProgram);
};

test("reads buys and sells paid in SOL: network fee in, the new token account's rent out", () => {
  const buy = effect("2m8a3a")!;
  assert.equal(buy.kind, "buy");
  assert.equal(buy.tokens, 233298611299n);
  // 0.005 SOL plus the 0.00002 network fee; the 0.00148844 SOL of rent stays the wallet's.
  assert.equal(buy.lamports, -5020000n);
  assert.equal(buy.feeLamports, 20000n);
  assert.equal(buy.before, 0n);

  const sell = effect("4jX6T9")!;
  assert.equal(sell.kind, "sell");
  assert.equal(sell.tokens, -116649305649n);
  assert.equal(sell.lamports, 2430539n);

  // A mainnet pool buy through a router: what the wallet's SOL fell by, fee included.
  const pool = effect("51GxtG")!;
  assert.equal(pool.kind, "buy");
  assert.equal(pool.lamports, -10255087n);
  assert.equal(pool.otherToken, undefined);
});

test("values a trade paid in another token at its pool's SOL leg", () => {
  // 111 USDC for the coin, with another wallet paying the network fee: the pool took in 1.2087 SOL.
  const usdc = effect("5e9s2d")!;
  assert.equal(usdc.kind, "buy");
  assert.equal(usdc.otherToken, true);
  assert.equal(usdc.lamports, -1208747909n);
  assert.equal(usdc.feeLamports, 0n);
  // Sold for USDC through Jupiter on the curve: the pool paid out 0.7632 SOL, before the curve's fees.
  const jup = effect("487qwc")!;
  assert.equal(jup.kind, "sell");
  assert.equal(jup.lamports, 763232098n);
  // Sold through two CPMM pools under one authority: the coin's pool paid out 106,899 lamports, less the wallet's fee.
  const route = effect("5wYDzv")!;
  assert.equal(route.kind, "sell");
  assert.equal(route.lamports, 106899n - 15001n);
});

test("skips failed transactions and ones that don't touch the coin", () => {
  const s = SAVED[0]!;
  assert.equal(txEffect(s.tx, s.signature, s.wallet, "So11111111111111111111111111111111111111112", ADDRESSES.mainnet.launchLabProgram), null);
  const failed = { ...s.tx, meta: { ...s.tx.meta!, err: { InstructionError: [0, "Custom"] } } } as ParsedTransactionWithMeta;
  assert.equal(txEffect(failed, s.signature, s.wallet, s.mint, ADDRESSES.mainnet.launchLabProgram), null);
});

const ev = (kind: PnlEvent["kind"], tokens: bigint, lamports: bigint, before: bigint, extra: Partial<PnlEvent> = {}): PnlEvent => ({
  signature: `${kind}${before}`,
  slot: 1,
  time: 1_793_980_000,
  kind,
  tokens,
  lamports,
  feeLamports: 0n,
  before,
  ...extra,
});

test("average cost: a sell realizes its proceeds less the average cost of what it sold", () => {
  const trial = ["2m8a3a", "4jX6T9"].map((p) => effect(p)!);
  const b = applyEvents(emptyBook(), trial);
  assert.equal(b.held, 116649305650n);
  assert.equal(b.spentLamports, 5020000);
  assert.equal(b.receivedLamports, 2430539);
  assert.ok(Math.abs(b.realizedLamports - (2430539 - 2510000)) < 1);
  assert.ok(Math.abs(b.costLamports - 2510000) < 1);
  assert.equal(b.gaps, 0);
  assert.equal(b.feeLamports, 40000);

  // Two buys at different prices, then half sold: cost comes out at the average.
  const two = applyEvents(emptyBook(), [ev("buy", 100n, -1000n, 0n), ev("buy", 100n, -3000n, 100n), ev("sell", -100n, 2500n, 200n)]);
  assert.equal(two.held, 100n);
  assert.equal(two.costLamports, 2000);
  assert.equal(two.realizedLamports, 500);
});

test("tokens with no known cost count at zero, and gaps are reconciled", () => {
  const b = applyEvents(emptyBook(), [
    ev("transfer_in", 50n, 0n, 0n),
    ev("buy", 50n, -1000n, 50n),
    // 20 tokens arrived unseen before this sell.
    ev("sell", -60n, 1200n, 120n),
    ev("transfer_out", -30n, -5000n, 60n),
  ]);
  assert.equal(b.uncosted, 70n);
  assert.equal(b.gaps, 1);
  assert.equal(b.counts.transfer_in, 1);
  assert.equal(b.counts.transfer_out, 1);
  // The sell took half of 120 tokens costing 1000: 500 of cost against 1200.
  assert.equal(b.realizedLamports, 700);
  // A transfer out takes its share of cost without realizing anything, and its SOL isn't spent on the coin.
  assert.equal(b.held, 30n);
  assert.equal(b.costLamports, 250);
  assert.equal(b.spentLamports, 1000);
});

const pnl = (book = emptyBook(), extra: Partial<CoinPnl> = {}): CoinPnl => ({
  mint: SAVED[6]!.mint,
  events: [],
  book,
  balance: book.held,
  valueLamports: 0n,
  spotPriceSol: null,
  stage: "curve",
  truncated: false,
  missing: 0,
  ...extra,
});

test("summaries are in SOL and whole tokens, with notes on what's estimated", () => {
  const trial = ["2m8a3a", "4jX6T9"].map((p) => effect(p)!);
  const book = applyEvents(emptyBook(), trial);
  const s = summarizeCoinPnl(pnl(book, { events: trial, valueLamports: 2450000n }), { ticker: "TEST", history: 1 });
  assert.equal(s.tokensHeld, 116649.30565);
  assert.equal(s.stage, "bonding curve");
  assert.equal(s.solSpent, 0.00502);
  assert.equal(s.costBasisSol, 0.00251);
  assert.equal(s.valueSol, 0.00245);
  assert.equal(s.unrealizedSol, -0.00006);
  assert.equal(s.realizedSol, -0.000079);
  assert.equal(s.totalSol, -0.000139);
  assert.equal(s.historyComplete, true);
  assert.equal(s.history?.length, 1);
  assert.deepEqual(s.history?.[0], { signature: trial[1]!.signature, at: "2026-11-06T16:04:04.000Z", kind: "sell", tokens: 116649.305649, sol: 0.002430539 });
  assert.equal(s.notes, undefined);

  const rough = applyEvents(emptyBook(), [ev("buy", 10n ** 9n, -2n * 10n ** 9n, 0n, { otherToken: true }), ev("transfer_in", 10n ** 6n, 0n, 10n ** 9n)]);
  const r = summarizeCoinPnl(pnl(rough, { truncated: true, valueLamports: null, valueError: "the coin is migrating" }));
  assert.equal(r.historyComplete, false);
  assert.equal(r.valueSol, null);
  assert.equal(r.totalSol, null);
  assert.match(r.notes!.join(" "), /latest transactions/);
  assert.match(r.notes!.join(" "), /1 tokens came in with no known cost/);
  assert.match(r.notes!.join(" "), /paid in another token/);
  assert.match(r.notes!.join(" "), /migrating/);

  const totals = pnlTotals([s, r]);
  assert.equal(totals.solSpent, 2.00502);
  assert.equal(totals.realizedSol, -0.000079);
  assert.ok(totals.incomplete);
});

/** A chain whose connection answers from `answers`; the quote fails, since there's no market. */
function fakeChain(answers: { signatures: () => Promise<unknown>; tx?: (sig: string) => unknown; balance?: bigint }): Chain {
  return {
    cluster: "devnet",
    key: () => new PublicKey(ADDRESSES.devnet.launchLabProgram),
    connection: {
      getParsedTokenAccountsByOwner: async () => ({
        value: answers.balance ? [{ pubkey: new PublicKey(SAVED[6]!.wallet), account: { data: { parsed: { info: { tokenAmount: { amount: String(answers.balance) } } } } } }] : [],
      }),
      getSignaturesForAddress: answers.signatures,
      getParsedTransaction: async (sig: string) => answers.tx?.(sig) ?? null,
    },
  } as unknown as Chain;
}

test("coinPnl reads the newest transactions, oldest first, and says when it stopped short", async () => {
  const [buy, sell] = [SAVED[6]!, SAVED[7]!];
  const chain = fakeChain({
    // Newest first, as the RPC returns them, one more than the limit of 2.
    signatures: async () => [
      { signature: sell.signature, slot: sell.tx.slot, err: null },
      { signature: buy.signature, slot: buy.tx.slot, err: null },
      { signature: "old", slot: 1, err: null },
    ],
    tx: (sig) => SAVED.find((s) => s.signature === sig)?.tx,
    balance: 116649305650n,
  });
  const p = await coinPnl(chain, new PublicKey(buy.wallet), new PublicKey(buy.mint), 2);
  assert.equal(p.truncated, true);
  assert.deepEqual(p.events.map((e) => e.kind), ["buy", "sell"]);
  assert.equal(p.book.gaps, 0);
  // The test chain has no market, so the holding can't be valued; that's a note, not a failure.
  assert.equal(p.valueLamports, null);
  assert.ok(p.valueError);
});

test("an RPC that times out searching history gives history_unavailable", async () => {
  const chain = fakeChain({
    signatures: async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    },
  });
  await assert.rejects(coinPnl(chain, new PublicKey(SAVED[6]!.wallet), new PublicKey(SAVED[6]!.mint), 10), (e: unknown) => e instanceof HigherError && e.code === "history_unavailable");
});
