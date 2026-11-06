import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import { coinUrl } from "../higher/constants.ts";
import { round } from "../higher/format.ts";
import { HigherError, ValidationError } from "../lib/errors.ts";
import { pooled } from "../lib/pool.ts";
import { WSOL, type Chain } from "./chain.ts";
import { quoteTrade } from "./quote.ts";
import { lamportsNumber, tokensNumber } from "./units.ts";

// get_wallet_pnl: profit and loss on higher.fun coins, from the wallet's own transactions on-chain. higher.fun's
// trades list has no per-wallet view and can't be paged past its first 50 (docs/higher-reference.md), so the cost
// basis comes from the history of the wallet's token accounts for each coin. In each transaction we take the change
// in the wallet's balance of the coin and in its SOL, counting SOL that moved into or out of its own token accounts
// (rent, wrapped SOL) as still the wallet's. That treats a trade the same whichever app or router made it. Average
// cost: a sell realizes its proceeds less the average cost of the tokens sold. What's still held is valued at what
// selling it all would return now, from an on-chain quote, fees and price impact included.

export const PNL_EVENT_KINDS = ["buy", "sell", "launch", "transfer_in", "transfer_out", "other"] as const;
export type PnlEventKind = (typeof PNL_EVENT_KINDS)[number];

export interface PnlEvent {
  signature: string;
  slot: number;
  /** Unix seconds, when the RPC knows it. */
  time: number | null;
  kind: PnlEventKind;
  /** The change in the wallet's balance of the coin, in base units. */
  tokens: bigint;
  /** The change in the wallet's SOL in lamports: the network fee in, rent in its own token accounts out. */
  lamports: bigint;
  /** The network fee, when the wallet paid it. */
  feeLamports: bigint;
  /** The wallet's balance of the coin before this transaction. */
  before: bigint;
  /** Paid, or paid out, in another token (USDC, say): `lamports` is then the SOL the coin's pool took in or paid out. */
  otherToken?: true;
}

/** The most coins one call reads. */
export const MAX_PNL_MINTS = 5;
/** The most transactions one call fetches, shared between its coins. */
export const MAX_PNL_TRANSACTIONS = 200;

type TokenBalance = NonNullable<NonNullable<ParsedTransactionWithMeta["meta"]>["preTokenBalances"]>[number];

/**
 * For a trade paid in another token: the SOL the coin's pool took in (positive, a buy) or paid out (a sell), before
 * trading fees. The pool is the owner whose coin balance moved against the wallet's; its SOL leg is its wrapped-SOL
 * account that moved the other way the most. One account, not the owner's net: Raydium's pools share an authority, so a
 * route through two of them moves SOL in and out under one owner. Null when there's no such owner.
 */
function poolSolLeg(meta: NonNullable<ParsedTransactionWithMeta["meta"]>, wallet: string, mint: string, tokens: bigint): bigint | null {
  const coin = new Map<string, bigint>();
  const sol = new Map<number, { owner: string; amount: bigint }>();
  const add = (list: TokenBalance[] | null | undefined, sign: bigint) => {
    for (const b of list ?? []) {
      if (!b.owner || b.owner === wallet) continue;
      const amount = sign * BigInt(b.uiTokenAmount.amount);
      if (b.mint === mint) coin.set(b.owner, (coin.get(b.owner) ?? 0n) + amount);
      else if (b.mint === WSOL.toBase58()) {
        const a = sol.get(b.accountIndex) ?? { owner: b.owner, amount: 0n };
        a.amount += amount;
        sol.set(b.accountIndex, a);
      }
    }
  };
  add(meta.preTokenBalances, -1n);
  add(meta.postTokenBalances, 1n);
  const buying = tokens > 0n;
  let best: { size: bigint; leg: bigint } | null = null;
  for (const [owner, c] of coin) {
    if (buying ? c >= 0n : c <= 0n) continue;
    const legs = [...sol.values()].filter((a) => a.owner === owner && (buying ? a.amount > 0n : a.amount < 0n)).map((a) => a.amount);
    if (!legs.length) continue;
    const leg = legs.reduce((x, y) => (buying ? (y > x ? y : x) : y < x ? y : x));
    const size = c < 0n ? -c : c;
    if (!best || size > best.size) best = { size, leg };
  }
  return best ? best.leg : null;
}

const LAUNCH_LOGS = new Set(["Program log: Instruction: InitializeV2", "Program log: Instruction: Initialize"]);

/** What one transaction did to the wallet's holding of `mint`, or null when it didn't change it (or failed). */
export function txEffect(tx: ParsedTransactionWithMeta, signature: string, wallet: string, mint: string, launchLab: string): PnlEvent | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;
  const owned = (list: TokenBalance[] | null | undefined) => (list ?? []).filter((b) => b.owner === wallet);
  const pre = owned(meta.preTokenBalances);
  const post = owned(meta.postTokenBalances);
  const sum = (list: TokenBalance[], m: string) => list.filter((b) => b.mint === m).reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
  const before = sum(pre, mint);
  const tokens = sum(post, mint) - before;
  if (tokens === 0n) return null;

  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const delta = (i: number) => BigInt((meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0));
  const w = keys.indexOf(wallet);
  let lamports = w >= 0 ? delta(w) : 0n;
  const accounts = new Set([...pre, ...post].map((b) => b.accountIndex));
  for (const i of accounts) lamports += delta(i);
  const feeLamports = w === 0 ? BigInt(meta.fee) : 0n;

  // Paid, or paid out, in some other token: its SOL flow says nothing about this coin's price.
  const mints = new Set([...pre, ...post].map((b) => b.mint));
  const otherToken = [...mints].some((m) => m !== mint && m !== WSOL.toBase58() && sum(post, m) !== sum(pre, m));
  const logs = meta.logMessages ?? [];
  const launched = logs.some((l) => l.startsWith(`Program ${launchLab} invoke`)) && logs.some((l) => LAUNCH_LOGS.has(l));

  if (otherToken) {
    const leg = poolSolLeg(meta, wallet, mint, tokens);
    const base = { signature, slot: tx.slot, time: tx.blockTime ?? null, tokens, feeLamports, before };
    if (leg === null) return { ...base, kind: "other", lamports };
    return { ...base, kind: tokens > 0n ? "buy" : "sell", lamports: -leg - feeLamports, otherToken: true };
  }
  let kind: PnlEventKind;
  if (tokens > 0n) kind = lamports + feeLamports < 0n ? (launched ? "launch" : "buy") : "transfer_in";
  else kind = lamports + feeLamports > 0n ? "sell" : "transfer_out";
  return { signature, slot: tx.slot, time: tx.blockTime ?? null, kind, tokens, lamports, feeLamports, before };
}

export interface PnlBook {
  /** Tokens held after the last event. */
  held: bigint;
  /** What the tokens held cost, in lamports. */
  costLamports: number;
  realizedLamports: number;
  spentLamports: number;
  receivedLamports: number;
  feeLamports: number;
  counts: Record<PnlEventKind, number>;
  /** Tokens that came in with no known cost (transfers, another token, or before the history read), at zero cost. */
  uncosted: bigint;
  /** Times the balance changed between events we saw: accounts or transactions outside what was read. */
  gaps: number;
  /** Trades paid in another token, valued by their pool's SOL leg. */
  otherToken: number;
}

export function emptyBook(): PnlBook {
  return {
    held: 0n,
    costLamports: 0,
    realizedLamports: 0,
    spentLamports: 0,
    receivedLamports: 0,
    feeLamports: 0,
    counts: Object.fromEntries(PNL_EVENT_KINDS.map((k) => [k, 0])) as Record<PnlEventKind, number>,
    uncosted: 0n,
    gaps: 0,
    otherToken: 0,
  };
}

/** Takes tokens out at their average cost, and returns that cost. */
function takeOut(book: PnlBook, tokens: bigint): number {
  if (book.held <= 0n) return 0;
  const share = tokens >= book.held ? 1 : Number(tokens) / Number(book.held);
  const cost = book.costLamports * share;
  book.costLamports -= cost;
  book.held = tokens >= book.held ? 0n : book.held - tokens;
  return cost;
}

/** Brings the book's balance to `balance` when it moved without an event we saw. */
export function reconcile(book: PnlBook, balance: bigint, counted = true) {
  if (balance === book.held) return;
  if (counted) book.gaps++;
  if (balance > book.held) {
    book.uncosted += balance - book.held;
    book.held = balance;
  } else takeOut(book, book.held - balance);
}

/** Applies events, oldest first, with average cost. */
export function applyEvents(book: PnlBook, events: PnlEvent[]): PnlBook {
  for (const [i, e] of events.entries()) {
    // The first event's opening balance is where the history read starts; later ones should match.
    reconcile(book, e.before, i > 0 || book.held !== 0n);
    book.counts[e.kind]++;
    if (e.otherToken) book.otherToken++;
    book.feeLamports += Number(e.feeLamports);
    if (e.tokens > 0n) {
      book.held += e.tokens;
      if (e.kind === "buy" || e.kind === "launch") {
        book.costLamports += Number(-e.lamports);
        book.spentLamports += Number(-e.lamports);
      } else book.uncosted += e.tokens;
    } else {
      const cost = takeOut(book, -e.tokens);
      if (e.kind === "sell") {
        book.realizedLamports += Number(e.lamports) - cost;
        book.receivedLamports += Number(e.lamports);
      }
    }
  }
  return book;
}

export interface CoinPnl {
  mint: string;
  events: PnlEvent[];
  book: PnlBook;
  /** The balance on-chain now. */
  balance: bigint;
  /** What selling the whole balance would return now, after fees; null when it couldn't be quoted. */
  valueLamports: bigint | null;
  spotPriceSol: number | null;
  stage: "curve" | "graduated" | null;
  /** True when the history had more transactions than were read; the oldest were left out. */
  truncated: boolean;
  /** Transactions the RPC didn't return. */
  missing: number;
  valueError?: string;
}

const timedOut = (err: unknown) => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError" || /timed? ?out/i.test(err.message));

/** One coin's profit and loss for a wallet, from at most `maxTransactions` of its latest transactions. */
export async function coinPnl(chain: Chain, wallet: PublicKey, mint: PublicKey, maxTransactions: number): Promise<CoinPnl> {
  if (maxTransactions < 1) throw new ValidationError("maxTransactions must be at least 1");
  const owner = wallet.toBase58();
  const accounts = await chain.connection.getParsedTokenAccountsByOwner(wallet, { mint });
  const balance = accounts.value.reduce((n, a) => n + BigInt(a.account.data.parsed?.info?.tokenAmount?.amount ?? 0), 0n);
  const addresses = new Map<string, PublicKey>();
  const ata = getAssociatedTokenAddressSync(mint, wallet, true, TOKEN_PROGRAM_ID);
  addresses.set(ata.toBase58(), ata);
  for (const a of accounts.value) addresses.set(a.pubkey.toBase58(), a.pubkey);

  // Every address's latest signatures, newest first; past the limit the oldest are dropped.
  const seen = new Map<string, number>();
  let truncated = false;
  for (const address of addresses.values()) {
    const sigs = await chain.connection.getSignaturesForAddress(address, { limit: maxTransactions + 1 }).catch((err: unknown) => {
      throw timedOut(err)
        ? new HigherError(
            "The Solana RPC timed out searching this wallet's history for the coin. Solana's public RPC often can't answer " +
              "history searches in time; an RPC provider's URL can.",
            { code: "history_unavailable" },
          )
        : err;
    });
    if (sigs.length > maxTransactions) truncated = true;
    for (const s of sigs) if (!s.err) seen.set(s.signature, s.slot);
  }
  const ordered = [...seen.entries()].sort((a, b) => b[1] - a[1]);
  if (ordered.length > maxTransactions) truncated = true;
  const signatures = ordered.slice(0, maxTransactions).map(([s]) => s);

  const launchLab = chain.key("launchLabProgram").toBase58();
  let missing = 0;
  const txs = await pooled(signatures, 4, (s) => chain.connection.getParsedTransaction(s, { maxSupportedTransactionVersion: 1 }));
  const events: PnlEvent[] = [];
  txs.forEach((tx, i) => {
    if (!tx) return void missing++;
    const e = txEffect(tx, signatures[i]!, owner, mint.toBase58(), launchLab);
    if (e) events.push(e);
  });
  // Oldest first. Signatures within a slot come newest first, so reverse their order too.
  const index = new Map(signatures.map((s, i) => [s, i]));
  events.sort((a, b) => a.slot - b.slot || index.get(b.signature)! - index.get(a.signature)!);

  const book = applyEvents(emptyBook(), events);
  // With the whole history read, the first transaction should start from nothing.
  if (!truncated && (events[0]?.before ?? 0n) > 0n) book.gaps++;
  reconcile(book, balance);

  let valueLamports: bigint | null = balance === 0n ? 0n : null;
  let spotPriceSol: number | null = null;
  let stage: CoinPnl["stage"] = null;
  let valueError: string | undefined;
  try {
    const q = await quoteTrade(chain, { mint, side: "sell", amountIn: balance > 0n ? balance : 1_000_000n, slippageBps: 0 });
    if (balance > 0n) valueLamports = q.amountOut;
    spotPriceSol = q.spotPriceSol;
    stage = q.stage;
  } catch (err) {
    if (balance > 0n) valueError = err instanceof Error ? err.message : String(err);
  }
  return { mint: mint.toBase58(), events, book, balance, valueLamports, spotPriceSol, stage, truncated, missing, ...(valueError ? { valueError } : {}) };
}

const sol = (lamports: number) => round(lamports / 1e9, 6);
const iso = (t: number | null | undefined) => (t ? new Date(t * 1000).toISOString() : null);

/** One coin's profit and loss in tool units. */
export function summarizeCoinPnl(p: CoinPnl, opts: { ticker?: string | null; history?: number } = {}) {
  const b = p.book;
  const value = p.valueLamports === null ? null : Number(p.valueLamports);
  const unrealized = value === null ? null : value - b.costLamports;
  const total = unrealized === null ? null : b.realizedLamports + unrealized;
  const tokensHeld = tokensNumber(p.balance);
  const notes: string[] = [];
  if (p.truncated) notes.push("Only the latest transactions were read; tokens held before them count as costing nothing.");
  if (b.uncosted > 0n) {
    notes.push(
      `${tokensNumber(b.uncosted)} tokens came in with no known cost (a transfer, a payment in another token, or before the history read) and count as costing nothing, so profit on them is overstated.`,
    );
  }
  if (b.counts.launch) notes.push("The launch transaction's cost includes the launch fee and rent for the new coin, not only the first buy.");
  if (b.otherToken) notes.push(`${b.otherToken} trade(s) were paid in another token (such as USDC) and are valued at the SOL the coin's pool took in or paid out, before trading fees (about 1% on the curve).`);
  if (b.counts.other) notes.push(`${b.counts.other} transaction(s) paid or were paid in another token; their SOL isn't counted.`);
  if (p.missing) notes.push(`${p.missing} transaction(s) couldn't be fetched from the RPC.`);
  if (p.valueError) notes.push(`Couldn't value the holding: ${p.valueError}`);
  const first = p.events[0];
  const last = p.events.at(-1);
  return {
    mint: p.mint,
    ...(opts.ticker !== undefined ? { ticker: opts.ticker } : {}),
    url: coinUrl(p.mint),
    stage: p.stage === "curve" ? "bonding curve" : p.stage,
    tokensHeld,
    spotPriceSol: p.spotPriceSol,
    valueSol: value === null ? null : sol(value),
    costBasisSol: sol(b.costLamports),
    avgCostSol: tokensHeld > 0 && b.costLamports > 0 ? Number((b.costLamports / 1e9 / tokensHeld).toPrecision(6)) : null,
    unrealizedSol: unrealized === null ? null : sol(unrealized),
    realizedSol: sol(b.realizedLamports),
    totalSol: total === null ? null : sol(total),
    returnPct: total !== null && b.spentLamports > 0 ? round((total / b.spentLamports) * 100, 2) : null,
    solSpent: sol(b.spentLamports),
    solReceived: sol(b.receivedLamports),
    networkFeesSol: sol(b.feeLamports),
    transactions: {
      buys: b.counts.buy,
      sells: b.counts.sell,
      ...(b.counts.launch ? { launches: b.counts.launch } : {}),
      ...(b.counts.transfer_in ? { transfersIn: b.counts.transfer_in } : {}),
      ...(b.counts.transfer_out ? { transfersOut: b.counts.transfer_out } : {}),
      ...(b.counts.other ? { other: b.counts.other } : {}),
    },
    firstAt: iso(first?.time),
    lastAt: iso(last?.time),
    historyComplete: !p.truncated && !p.missing && b.gaps === 0,
    ...(opts.history
      ? {
          history: p.events.slice(-opts.history).map((e) => ({
            signature: e.signature,
            at: iso(e.time),
            kind: e.kind,
            tokens: tokensNumber(e.tokens < 0n ? -e.tokens : e.tokens),
            sol: lamportsNumber(e.lamports < 0n ? -e.lamports : e.lamports),
          })),
        }
      : {}),
    ...(notes.length ? { notes } : {}),
  };
}

/** Totals across coins, in SOL; null parts stay out of the sums and are flagged. */
export function pnlTotals(coins: ReturnType<typeof summarizeCoinPnl>[]) {
  const add = (f: (c: (typeof coins)[number]) => number | null) => round(coins.reduce((n, c) => n + (f(c) ?? 0), 0), 6);
  return {
    realizedSol: add((c) => c.realizedSol),
    unrealizedSol: add((c) => c.unrealizedSol),
    totalSol: add((c) => c.totalSol),
    solSpent: add((c) => c.solSpent),
    solReceived: add((c) => c.solReceived),
    valueSol: add((c) => c.valueSol),
    ...(coins.some((c) => c.valueSol === null) ? { incomplete: "Some holdings couldn't be valued and are left out of the totals." } : {}),
  };
}
