import { PublicKey, type ConfirmedSignatureInfo, type VersionedTransactionResponse } from "@solana/web3.js";
import bs58 from "bs58";
import { ValidationError } from "../lib/errors.ts";
import type { Chain } from "./chain.ts";
import { closingEvent, readWagerConfig, type SeriesOutcome } from "./wager.ts";
import { decodeWager, FALLBACK_KINDS, seriesAddress, wagerConfigAddress, wagerProgram, type WagerConfig } from "./wager-codec.ts";

// The wager program's history, read back from the chain for the practice pages (docs/wager-mode.md 7.5): which series
// opened and how each closed, from the config account's transactions (open, accept and every close write it, moves
// don't); and one series' every move, from its own account's. Nothing here is trusted: a replay checks every
// commitment against the TypeScript twin of the rules (arena/series.ts), in the browser.
//
// Wager instructions are read wherever they run, at the top level or called from another program, in execution order:
// the program doesn't care how it's called, so neither may the reader. A history that can't be read whole (a missing
// transaction, more than the cap) throws rather than returning part of it: a partial history would replay as a false
// failure, and be cached.

/** One of the program's instructions for a series, from a transaction that succeeded, in the chain's order. */
export type SeriesEvent = { at: number; sig: string } & (
  | { kind: "open"; playerA: string; playerB: string; fallbackHash: string }
  | { kind: "accept"; playerB: string; fallbackHash: string }
  | { kind: "commit"; player: string; round: number; hash: string }
  | { kind: "reveal"; player: string; pull: number; nonce: string }
  | { kind: "revealFallback"; player: string; fallback: { kind: (typeof FALLBACK_KINDS)[number]; pull: number }; salt: string }
  | { kind: "timeout" }
  | { kind: "retire"; player: string }
  | { kind: "closed"; outcome: ClosedOutcome }
);

/**
 * How a series closed: the program's closing event, or "unread" when a close instruction ran but its log was cut short
 * (anyone may settle, through a program that logs enough to truncate it), so the event can't be read.
 */
export type ClosedOutcome = Extract<SeriesOutcome, { state: "closed" }> | { state: "closed"; how: "unread" };

export interface SeriesHistory {
  seriesId: string;
  /** The program's config: the rules and the reveal window every series plays under. */
  rules: WagerConfig["rules"];
  revealSeconds: number;
  events: SeriesEvent[];
}

/** A series as the config's history shows it: who, when, and how it closed. */
export interface SeriesSummary {
  seriesId: string;
  playerA: string;
  playerB: string;
  openedAt: number;
  acceptedAt: number | null;
  closed: { at: number; outcome: ClosedOutcome } | null;
}

function program(chain: Chain): PublicKey {
  const p = wagerProgram(chain.cluster);
  if (!p) throw new ValidationError(`Wagering on The Line isn't deployed on ${chain.cluster}.`);
  return p;
}

/**
 * An address's successful transactions, oldest first: all of them, or with `newest`, only that many of the newest.
 * Throws past `cap` in all: anyone can add transactions that name an account, so a history that long is read as
 * unreadable rather than cut short.
 */
async function signatures(chain: Chain, address: PublicKey, { cap, newest }: { cap: number; newest?: number }): Promise<ConfirmedSignatureInfo[]> {
  const out: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await patiently(() => chain.connection.getSignaturesForAddress(address, { limit: 1000, before }, "confirmed"));
    out.push(...page);
    if (newest !== undefined && out.length >= newest) return out.slice(0, newest).filter((s) => !s.err).reverse();
    if (page.length < 1000) break;
    if (out.length >= cap) throw new Error(`more than ${cap} transactions name ${address.toBase58()}: too long a history to read`);
    before = page[page.length - 1]!.signature;
  }
  return out.filter((s) => !s.err).reverse();
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const throttled = (err: unknown) => /429|too many requests/i.test(err instanceof Error ? err.message : String(err));

/** Retries a read the RPC throttled, backing off: public RPCs limit each method per second. */
async function patiently<T>(read: () => Promise<T>): Promise<T> {
  for (let wait = 500; ; wait *= 2) {
    try {
      return await read();
    } catch (err) {
      if (!throttled(err) || wait > 8_000) throw err;
      await sleep(wait);
    }
  }
}

/**
 * Transactions by signature: twenty to a batch where the RPC takes batches, else one at a time (devnet's public RPC
 * refuses batches of getTransaction), each retried while it's throttled.
 */
async function transactions(chain: Chain, sigs: string[]): Promise<(VersionedTransactionResponse | null)[]> {
  const opts = { maxSupportedTransactionVersion: 0, commitment: "confirmed" } as const;
  const out: (VersionedTransactionResponse | null)[] = [];
  let batches = true;
  for (let i = 0; i < sigs.length; i += 20) {
    const chunk = sigs.slice(i, i + 20);
    if (batches) {
      try {
        out.push(...(await chain.connection.getTransactions(chunk, opts)));
        continue;
      } catch (err) {
        if (!throttled(err)) throw err;
        batches = false;
      }
    }
    for (const sig of chunk) out.push(await patiently(() => chain.connection.getTransaction(sig, opts)));
  }
  const missing = out.findIndex((t) => t === null);
  if (missing >= 0) throw new Error(`the RPC returned no transaction for ${sigs[missing]}: try again later`);
  return out;
}

/** A transaction's instructions in execution order: each top-level one, then those it called. */
function executed(tx: VersionedTransactionResponse): { programIdIndex: number; accounts: number[]; data: Buffer }[] {
  const inner = new Map<number, { programIdIndex: number; accounts: number[]; data: string }[]>();
  for (const set of tx.meta?.innerInstructions ?? []) inner.set(set.index, set.instructions);
  return tx.transaction.message.compiledInstructions.flatMap((ix, i) => [
    { programIdIndex: ix.programIdIndex, accounts: ix.accountKeyIndexes, data: Buffer.from(ix.data) },
    ...(inner.get(i) ?? []).map((x) => ({ programIdIndex: x.programIdIndex, accounts: x.accounts, data: Buffer.from(bs58.decode(x.data)) })),
  ]);
}

/**
 * The wager instructions in one transaction, each with the series account it names. Closes (cancel, settle, the
 * refunds) carry no event of their own: how a series closed is read from the program's closing event.
 */
function wagerEvents(tx: VersionedTransactionResponse, p: PublicKey): { series: string | null; event: SeriesEvent | null; seriesId?: string; closes?: boolean }[] {
  if (tx.meta?.err || tx.blockTime == null) return [];
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
  const key = (i: number | undefined) => (i === undefined ? null : keys.get(i)?.toBase58() ?? null);
  const at = tx.blockTime;
  const sig = tx.transaction.signatures[0]!;
  const out: { series: string | null; event: SeriesEvent | null; seriesId?: string; closes?: boolean }[] = [];
  for (const ix of executed(tx)) {
    if (!keys.get(ix.programIdIndex)?.equals(p)) continue;
    const wg = decodeWager(ix.data);
    if (!wg) continue;
    const acc = (n: number) => key(ix.accounts[n]);
    switch (wg.kind) {
      case "open":
        out.push({ series: acc(2), seriesId: wg.seriesId, event: { at, sig, kind: "open", playerA: acc(0)!, playerB: wg.playerB, fallbackHash: wg.fallbackHash } });
        break;
      case "accept":
        out.push({ series: acc(2), event: { at, sig, kind: "accept", playerB: acc(0)!, fallbackHash: wg.fallbackHash } });
        break;
      case "commit":
        out.push({ series: acc(1), event: { at, sig, kind: "commit", player: acc(0)!, round: wg.round, hash: wg.hash } });
        break;
      case "reveal":
        out.push({ series: acc(1), event: { at, sig, kind: "reveal", player: acc(0)!, pull: wg.pull, nonce: wg.nonce } });
        break;
      case "revealFallback": {
        const kind = FALLBACK_KINDS[wg.fallbackKind];
        if (kind) out.push({ series: acc(1), event: { at, sig, kind: "revealFallback", player: acc(0)!, fallback: { kind, pull: wg.pull }, salt: wg.salt } });
        break;
      }
      case "timeout":
        out.push({ series: acc(0), event: { at, sig, kind: "timeout" } });
        break;
      case "retire":
        out.push({ series: acc(1), event: { at, sig, kind: "retire", player: acc(0)! } });
        break;
      case "cancel":
      case "freezeAndRefund":
        out.push({ series: acc(2), event: null, closes: true });
        break;
      case "settle":
      case "emergencyRefund":
        out.push({ series: acc(0), event: null, closes: true });
        break;
      default:
        out.push({ series: null, event: null });
    }
  }
  return out;
}

/** How this transaction closed the series, if it did: its closing event, or "unread" when a close ran but the log was cut. */
function closedBy(tx: VersionedTransactionResponse, p: PublicKey, seriesId: string, events: ReturnType<typeof wagerEvents>): ClosedOutcome | null {
  const found = closingEvent(tx.meta?.logMessages ?? [], p.toBase58(), seriesId);
  if (found) return found;
  const address = seriesAddress(p, seriesId).toBase58();
  return events.some((e) => e.closes && e.series === address) ? { state: "closed", how: "unread" } : null;
}

/** A series' history is read whole or not at all: past this many transactions naming its account, it's unreadable. */
export const HISTORY_CAP = 5000;

/** Every move in one series, from its account's transactions, with how it closed. Throws when it can't be read whole. */
export async function seriesHistory(chain: Chain, seriesId: string): Promise<SeriesHistory> {
  const p = program(chain);
  const config = await patiently(() => readWagerConfig(chain));
  const address = seriesAddress(p, seriesId);
  const sigs = await signatures(chain, address, { cap: HISTORY_CAP });
  const txs = await transactions(chain, sigs.map((s) => s.signature));
  const events: SeriesEvent[] = [];
  for (const tx of txs) {
    if (!tx || tx.meta?.err || tx.blockTime == null) continue;
    const found = wagerEvents(tx, p);
    for (const e of found) if (e.event && e.series === address.toBase58()) events.push(e.event);
    const closed = closedBy(tx, p, seriesId, found);
    if (closed) events.push({ at: tx.blockTime, sig: tx.transaction.signatures[0]!, kind: "closed", outcome: closed });
  }
  if (!events.some((e) => e.kind === "open")) throw new Error(`no opening transaction found for series ${seriesId}`);
  return { seriesId, rules: config.rules, revealSeconds: config.revealSeconds, events };
}

/** The newest series, from the config account's history: opens, accepts and closes. Newest first. */
export async function recentSeries(chain: Chain, max = 300): Promise<SeriesSummary[]> {
  const p = program(chain);
  const sigs = await signatures(chain, wagerConfigAddress(p), { cap: max, newest: max });
  const txs = await transactions(chain, sigs.map((s) => s.signature));
  const byId = new Map<string, SeriesSummary>();
  const byAddress = new Map<string, SeriesSummary>();
  for (const tx of txs) {
    if (!tx || tx.meta?.err || tx.blockTime == null) continue;
    const found = wagerEvents(tx, p);
    for (const e of found) {
      if (e.event?.kind === "open" && e.seriesId && e.series) {
        const s: SeriesSummary = { seriesId: e.seriesId, playerA: e.event.playerA, playerB: e.event.playerB, openedAt: e.event.at, acceptedAt: null, closed: null };
        byId.set(e.seriesId, s);
        byAddress.set(e.series, s);
      } else if (e.event?.kind === "accept" && e.series) {
        const s = byAddress.get(e.series);
        if (s) s.acceptedAt = e.event.at;
      }
    }
    for (const s of byId.values()) {
      if (s.closed) continue;
      const outcome = closedBy(tx, p, s.seriesId, found);
      if (outcome) s.closed = { at: tx.blockTime, outcome };
    }
  }
  return [...byId.values()].sort((x, y) => y.openedAt - x.openedAt);
}
