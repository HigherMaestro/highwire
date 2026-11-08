import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OrderBook, type Order, type OrderRun } from "highwire-agent";
import { HOME, highwire } from "./highwire.ts";

// The receipts module (modules/receipts.md): a post on the coin's page, in the agent's own voice, for each thing its
// standing orders did with real SOL: fee claims and their buybacks, filled limit buys, recurring buys. Amounts come from
// the orders' history, as Highwire's order runner recorded them; a run whose amounts can't be read gets no post. Call
// postReceipts(coin) from the agent's loop on every wake-up.

export interface Coin {
  mint: string;
  ticker: string;
}

export interface Receipt {
  /** The run's time: the module remembers the last one it posted, so a restart never posts it twice. */
  at: string;
  text: string;
}

const CLAIMED = /^(?:claimed|would claim) about ([\d.]+) SOL/;
const BOUGHT = /^bought back with ([\d.]+) SOL$/;

/** 1.2324 → "1.232", 0.0041 → "0.0041". */
export function sol(n: number): string {
  if (n >= 0.01) return n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return String(Number(n.toPrecision(2)));
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** A fee claim's runs: the claim and its buyback share a time. */
function claimReceipts(o: Order, coin: Coin, runs: OrderRun[], counts: (r: OrderRun | undefined) => boolean): Receipt[] {
  const byAt = new Map<string, OrderRun[]>();
  for (const h of runs) byAt.set(h.at, [...(byAt.get(h.at) ?? []), h]);
  const out: Receipt[] = [];
  for (const [at, steps] of byAt) {
    const claim = steps.find((s) => s.step === "claim");
    const claimed = counts(claim) ? CLAIMED.exec(claim!.reason ?? "") : null;
    if (!claimed) continue;
    const got = `I claimed ${sol(Number(claimed[1]))} SOL of my ${o.mint === coin.mint ? `$${coin.ticker} ` : ""}creator fees`;
    const buy = steps.find((s) => s.step === "buyback");
    if (!buy) out.push({ at, text: `${got}.` });
    else if (counts(buy)) {
      const spent = BOUGHT.exec(buy.reason ?? "");
      if (spent) out.push({ at, text: `${got} and spent ${sol(Number(spent[1]))} SOL buying $${coin.ticker} back.` });
    } else if (buy.outcome === "skipped") out.push({ at, text: `${got}, too little to buy back this time.` });
    else out.push({ at, text: `${got}. My buyback didn't go through this time, so the SOL waits in my wallet for the next one.` });
  }
  return out;
}

/**
 * The receipts for runs after `since`, oldest first. Dry runs are left out unless `dryRuns` is set, which is how the
 * loop shows what it would post while the policy isn't live.
 */
export function receiptsFor(orders: Order[], coin: Coin, since?: string, opts: { dryRuns?: boolean } = {}): Receipt[] {
  const counts = (r: OrderRun | undefined) => r !== undefined && (r.outcome === "sent" || (opts.dryRuns === true && r.outcome === "dry_run"));
  const out: Receipt[] = [];
  for (const o of orders) {
    const runs = o.history.filter((h) => !since || h.at > since);
    if (o.kind === "fee_claim" && (o.mint === coin.mint || o.mint === undefined)) out.push(...claimReceipts(o, coin, runs, counts));
    if (o.mint !== coin.mint || o.sol === undefined) continue;
    for (const h of runs.filter((r) => counts(r))) {
      if (o.kind === "limit_buy") out.push({ at: h.at, text: `$${coin.ticker} fell to the price I'd set, so I bought it with ${sol(o.sol)} SOL.` });
      if (o.kind === "recurring_buy" && o.everyHours) out.push({ at: h.at, text: `I bought $${coin.ticker} with ${sol(o.sol)} SOL, as I do every ${plural(o.everyHours, "hour")}.` });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

interface State {
  lastPostedAt?: string;
}

/**
 * Posts each new receipt for `coin` on its page, oldest first, and returns what it did. The first call only starts the
 * record from now, so adding the module never posts old news. While the policy isn't live it posts nothing and returns
 * what it would post. A refused post (the day's posts used up, say) waits for the next wake-up.
 */
export async function postReceipts(coin: Coin, opts: { stateFile?: string; now?: Date } = {}): Promise<string[]> {
  const stateFile = opts.stateFile ?? join(HOME, "receipts-state.json");
  const orders = new OrderBook(join(HOME, "orders.json")).list();
  let live = false;
  try {
    live = (JSON.parse(readFileSync(join(HOME, "policy.json"), "utf8")) as { live?: boolean }).live === true;
  } catch {
    /* no policy: a dry run */
  }
  if (!live) return receiptsFor(orders, coin, undefined, { dryRuns: true }).map((r) => `Dry run, nothing posted. For ${r.at} it would post: ${r.text}`);

  const save = (s: State) => writeFileSync(stateFile, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  if (!existsSync(stateFile)) {
    const from = (opts.now ?? new Date()).toISOString();
    save({ lastPostedAt: from });
    return [`Receipts start from ${from}: what happened before isn't posted.`];
  }
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as State;
  const said: string[] = [];
  for (const r of receiptsFor(orders, coin, state.lastPostedAt)) {
    const p = await highwire(["post", "--mint", coin.mint, r.text]);
    if (!p.ok) {
      said.push(`Didn't post the receipt for ${r.at}, so it waits: ${p.err || p.out}`);
      break;
    }
    said.push(p.out);
    save({ lastPostedAt: r.at });
  }
  return said;
}
