import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatPrice, OrderBook, type Order } from "highwire-agent";
import { HOME, highwire } from "./highwire.ts";
import { Highwire } from "./tools.ts";

// The dip-buys module (modules/dip-buys.md): one limit buy of a coin at a time, buy_sol of it once its on-chain price
// falls drop_pct under the price when the buy was set. After a fill it waits cooldown_hours and sets the next one under
// the price then, so a falling price is bought step by step, never all at once. If the price instead rises
// reset_rise_pct over where the buy was set, the buy moves up under the new price. A buy is set only while the wallet
// would still hold keep_sol after it. Highwire's order runner fills it, inside the policy: limit buys need "limit_buy"
// in the policy's orders.kinds. Call tendDips(mint) from the agent's loop on every wake-up.

export interface DipRules {
  buy_sol: number;
  drop_pct: number;
  keep_sol: number;
  cooldown_hours: number;
  reset_rise_pct: number;
  expires_days: number;
  slippage_bps: number;
}

const RANGES: Record<keyof DipRules, [number, number]> = {
  buy_sol: [0.001, 10],
  drop_pct: [1, 90],
  keep_sol: [0, 100],
  cooldown_hours: [0, 720],
  reset_rise_pct: [1, 1000],
  expires_days: [1, 90],
  slippage_bps: [0, 1000],
};

export function readDipRules(path: URL | string = new URL("../dips.json", import.meta.url)): DipRules {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    const v = raw[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`dips.json: ${k} must be a number from ${lo} to ${hi}`);
  }
  return raw as unknown as DipRules;
}

/** About what a buy costs beyond its SOL: Highwire's 0.3% fee and the network fee, with room to spare. */
const OVERHEAD_SOL = 0.005;

/** 1.2324 → "1.232", 0.0041 → "0.0041". */
const sol = (n: number) => (n >= 0.01 ? n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : String(Number(n.toPrecision(2))));

export type DipStep = { do: "wait"; reason: string } | { do: "place"; reason: string } | { do: "reset"; cancel: string; reason: string };

export interface DipFacts {
  rules: DipRules;
  /** Open limit buys of the coin for this wallet. */
  open: Pick<Order, "id" | "triggerPriceSol">[];
  /** When the last limit buy of the coin filled, or failed in a way that may have sent it. */
  lastFillAt?: string;
  /** The wallet's SOL, read only when no buy is open. */
  balanceSol?: number;
  /** The coin's spot price, read only while a buy is open. */
  priceSol?: number | null;
  now: Date;
}

const wait = (reason: string): DipStep => ({ do: "wait", reason });

/** What to do now. Pure: everything it needs is in `f`. */
export function planDips(f: DipFacts): DipStep {
  const r = f.rules;
  if (f.open.length > 1) return wait(`${f.open.length} dip buys are open, so they're left as they are`);
  const [o] = f.open;
  if (o) {
    if (f.priceSol == null || o.triggerPriceSol === undefined) return wait("couldn't read the price; trying again later");
    const setAt = o.triggerPriceSol / (1 - r.drop_pct / 100);
    const rise = (f.priceSol / setAt - 1) * 100;
    if (rise >= r.reset_rise_pct) {
      return { do: "reset", cancel: o.id, reason: `the price rose ${Math.round(rise)}% since the dip buy was set, so it moves up under the new price` };
    }
    return wait(`waiting to buy ${r.buy_sol} SOL once the price is ${formatPrice(o.triggerPriceSol)} SOL or below (now ${formatPrice(f.priceSol)})`);
  }
  if (f.lastFillAt) {
    const next = new Date(Date.parse(f.lastFillAt) + r.cooldown_hours * 3_600_000);
    if (next > f.now) return wait(`the last dip buy was at ${f.lastFillAt}, so the next one is set after ${next.toISOString()}`);
  }
  if (f.balanceSol === undefined) return wait("couldn't read the wallet's balance; trying again later");
  if (f.balanceSol - r.keep_sol < r.buy_sol + OVERHEAD_SOL) {
    return wait(`the wallet holds ${sol(f.balanceSol)} SOL, and a ${r.buy_sol} SOL buy would leave less than the ${r.keep_sol} SOL it keeps`);
  }
  return { do: "place", reason: `setting a ${r.buy_sol} SOL buy ${r.drop_pct}% under the price now` };
}

/** When the last limit buy of `mint` filled or failed: those close with closedAt. Cancelled and expired ones don't count. */
export function lastFill(orders: Order[], mint: string): string | undefined {
  return orders
    .filter((o) => o.kind === "limit_buy" && o.mint === mint && (o.status === "done" || o.status === "failed") && o.closedAt)
    .map((o) => o.closedAt!)
    .sort()
    .at(-1);
}

async function balanceSol(wallet: string): Promise<number | undefined> {
  try {
    const res = await fetch(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [wallet, { commitment: "confirmed" }] }),
    });
    const body = (await res.json()) as { result?: { value?: number } };
    return typeof body.result?.value === "number" ? body.result.value / 1e9 : undefined;
  } catch {
    return undefined;
  }
}

async function spotPrice(mint: string, buySol: number): Promise<number | null> {
  const hw = await Highwire.connect();
  try {
    const q = await hw.call<{ spotPriceSol?: number | null }>("quote_trade", { mint, side: "buy", sol: buySol });
    return q.ok ? (q.body.spotPriceSol ?? null) : null;
  } finally {
    await hw.close();
  }
}

/** One look at the dip buys of `mint`: sets, moves or leaves the one limit buy, and says what it did. */
export async function tendDips(mint: string, opts: { rules?: DipRules; now?: Date } = {}): Promise<string> {
  const rules = opts.rules ?? readDipRules();
  const policyPath = join(HOME, "policy.json");
  let policy: { live?: boolean; orders?: { kinds?: string[] } };
  try {
    policy = JSON.parse(readFileSync(policyPath, "utf8")) as typeof policy;
  } catch {
    return `No policy at ${policyPath}, so no dip buys.`;
  }
  if (policy.live !== true) return "The policy is a dry run, so no dip buys.";
  if (!policy.orders?.kinds?.includes("limit_buy")) {
    return `No dip buys: the policy doesn't allow limit buys. Add "limit_buy" to "orders" → "kinds" (and room for it in "max_open") in ${policyPath}.`;
  }
  const address = await highwire(["wallet", "address"]);
  if (!address.ok) return `Couldn't read the wallet's address: ${address.err || address.out}`;
  const wallet = address.out;

  const book = new OrderBook(join(HOME, "orders.json"));
  const mine = book.list().filter((o) => o.kind === "limit_buy" && o.mint === mint && o.wallet === wallet);
  const open = mine.filter((o) => o.status === "open");
  const facts: DipFacts = { rules, open, lastFillAt: lastFill(mine, mint), now: opts.now ?? new Date() };
  if (open.length === 1) facts.priceSol = await spotPrice(mint, rules.buy_sol);
  else if (!open.length) facts.balanceSol = await balanceSol(wallet);

  let step = planDips(facts);
  let said = "";
  if (step.do === "reset") {
    await book.cancel(step.cancel, step.reason);
    said = `Cancelled dip buy ${step.cancel}: ${step.reason}. `;
    step = planDips({ ...facts, open: [], priceSol: undefined, balanceSol: await balanceSol(wallet) });
  }
  if (step.do !== "place") return `${said}${step.reason[0]!.toUpperCase()}${step.reason.slice(1)}.`;
  const r = await highwire([
    "orders", "limit-buy",
    "--mint", mint,
    "--sol", String(rules.buy_sol),
    "--drop-pct", String(rules.drop_pct),
    "--slippage-bps", String(rules.slippage_bps),
    "--expires-days", String(rules.expires_days),
  ]);
  return r.ok ? `${said}Set a dip buy: ${r.out}` : `${said}Couldn't set the dip buy: ${r.err || r.out}`;
}
