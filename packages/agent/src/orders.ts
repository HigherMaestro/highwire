import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { CLUSTERS, HigherError, MAX_SLIPPAGE_BPS } from "highwire-core";
import { withFileLock } from "./lock.ts";

// Standing orders the local signer runs while `highwire orders run` is up: stop-loss and take-profit sells, limit buys,
// recurring buys, and fee claims that collect the wallet's creator fees on a schedule and can buy back a coin with them.
// They're kept in ~/.highwire/orders.json. An agent may place and cancel them, but only when the
// user's policy has an `orders` section allowing that kind, and every fill goes through LocalSigner.execute like any
// other trade: the same policy check, kill switch, simulation and audit log. Writes take a lock and replace the file
// whole, so the tools and the runner can't lose each other's changes.

export const ORDER_KINDS = ["stop_loss", "take_profit", "limit_buy", "recurring_buy", "fee_claim"] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

export const ORDER_STATUSES = ["open", "done", "cancelled", "expired", "failed"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** How many runs an order keeps in its history; older ones are in the audit log. */
export const ORDER_HISTORY = 20;

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

export const OrderRunSchema = z.object({
  at: z.string(),
  outcome: z.enum(["sent", "partly_sent", "dry_run", "refused", "failed", "skipped"]),
  reason: z.string().optional(),
  signatures: z.array(z.string()).optional(),
  /** The on-chain spot price that triggered it, in SOL per token. */
  priceSol: z.number().optional(),
  /** A fee claim's run has two steps: the claim, then the buyback. */
  step: z.enum(["claim", "buyback"]).optional(),
});
export type OrderRun = z.infer<typeof OrderRunSchema>;

export const OrderSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{8}$/),
  kind: z.enum(ORDER_KINDS),
  cluster: z.enum(CLUSTERS),
  /** The signer wallet it was placed for: a runner for another wallet leaves it alone. */
  wallet: address,
  /** The coin traded. A fee claim has one only when it buys back: claims cover every coin the wallet created. */
  mint: address.optional(),
  status: z.enum(ORDER_STATUSES),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  closedAt: z.string().optional(),
  closeReason: z.string().optional(),
  maxSlippageBps: z.number().int().min(0).max(MAX_SLIPPAGE_BPS),
  /** Stop-loss and limit buy: fill once the spot price is at or below this. Take-profit: at or above. SOL per whole token. */
  triggerPriceSol: z.number().positive().optional(),
  /** The share of the wallet's balance in the coin to sell when it triggers. */
  sellPct: z.number().min(1).max(100).optional(),
  /** Don't sell for less than this much SOL in all (a stop-limit). */
  minSolOut: z.number().positive().optional(),
  /** Recurring buy: SOL each time, every so many hours, so many times. Limit buy: the SOL it spends, once. */
  sol: z.number().positive().optional(),
  everyHours: z.number().min(1).max(720).optional(),
  times: z.number().int().min(1).max(1000).optional(),
  /** Fee claim: skip a run when less than this much SOL is waiting, so network fees don't eat a dusting. */
  minClaimSol: z.number().min(0).optional(),
  /** Fee claim: the share of the SOL just claimed to spend buying `mint`. */
  buybackPct: z.number().min(1).max(100).optional(),
  runsDone: z.number().int().min(0).default(0),
  nextRunAt: z.string().optional(),
  /** Set while the runner is filling it. Still set on start-up means a runner stopped mid-fill. */
  fillingSince: z.string().optional(),
  /** Failures in a row that may pass on their own (an RPC, a failed simulation). */
  failures: z.number().int().min(0).default(0),
  history: z.array(OrderRunSchema).default([]),
});
export type Order = z.infer<typeof OrderSchema>;

const BookSchema = z.object({ version: z.literal(1), orders: z.array(OrderSchema) });

export type NewOrder = Omit<Order, "id" | "status" | "createdAt" | "runsDone" | "failures" | "history" | "closedAt" | "closeReason" | "fillingSince">;

/** A price in plain decimals, never exponent notation: 0.0000000278698, not 2.78698e-8. */
export const formatPrice = (n: number | undefined) => (n === undefined ? "?" : n.toLocaleString("en-US", { maximumSignificantDigits: 6, useGrouping: false }));

/** A one-line description of an order, in tool units. */
const every = (h: number | undefined) => (h === 1 ? "every hour" : `every ${h} hours`);

export function describeOrder(o: Pick<Order, "kind" | "mint" | "triggerPriceSol" | "sellPct" | "minSolOut" | "sol" | "everyHours" | "times" | "minClaimSol" | "buybackPct">): string {
  switch (o.kind) {
    case "stop_loss":
      return `Sell ${o.sellPct}% of ${o.mint} if its price falls to ${formatPrice(o.triggerPriceSol)} SOL or below${o.minSolOut ? `, for at least ${o.minSolOut} SOL` : ""}`;
    case "take_profit":
      return `Sell ${o.sellPct}% of ${o.mint} if its price rises to ${formatPrice(o.triggerPriceSol)} SOL or above${o.minSolOut ? `, for at least ${o.minSolOut} SOL` : ""}`;
    case "limit_buy":
      return `Buy ${o.sol} SOL of ${o.mint} if its price falls to ${formatPrice(o.triggerPriceSol)} SOL or below`;
    case "recurring_buy":
      return `Buy ${o.sol} SOL of ${o.mint} ${every(o.everyHours)}, ${o.times === 1 ? "once" : `${o.times} times`}`;
    case "fee_claim":
      return `Claim creator fees ${every(o.everyHours)}${o.minClaimSol ? ` when at least ${o.minClaimSol} SOL is waiting` : ""}${o.buybackPct && o.mint ? `, then spend ${o.buybackPct}% of what came in buying ${o.mint}` : ""}`;
  }
}

export class OrderBook {
  constructor(
    readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get lock() {
    return `${this.path}.lock`;
  }

  /** Every order, newest first. A missing file is an empty book; a damaged one is an error, never overwritten. */
  list(): Order[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HigherError(`The orders file at ${this.path} isn't valid JSON; fix or remove it.`, { code: "orders_invalid" });
    }
    const parsed = BookSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "orders"}: ${i.message}`).join("; ");
      throw new HigherError(`The orders file at ${this.path} isn't usable: ${issues}`, { code: "orders_invalid" });
    }
    return parsed.data.orders;
  }

  get(id: string): Order | undefined {
    return this.list().find((o) => o.id === id);
  }

  private write(orders: Order[]) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, orders }, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  /** Read, change and write the book under its lock. */
  async change<T>(fn: (orders: Order[]) => T): Promise<T> {
    return withFileLock(this.lock, async () => {
      const orders = this.list();
      const out = fn(orders);
      this.write(orders);
      return out;
    }, 10_000);
  }

  /** Adds an order, unless the policy's `max_open` would be passed. */
  async place(order: NewOrder, maxOpen: number): Promise<Order> {
    return this.change((orders) => {
      const open = orders.filter((o) => o.status === "open" && o.wallet === order.wallet && o.cluster === order.cluster).length;
      if (open >= maxOpen) {
        throw new HigherError(`The policy allows ${maxOpen} open orders, and there are ${open}. Cancel one first.`, { code: "policy_refused", body: { rule: "orders.max_open" } });
      }
      let id: string;
      do id = randomBytes(4).toString("hex");
      while (orders.some((o) => o.id === id));
      const full = OrderSchema.parse({ ...order, id, status: "open", createdAt: this.now().toISOString(), runsDone: 0, failures: 0, history: [] });
      orders.unshift(full);
      return full;
    });
  }

  /** Cancels an open order. Returns it, or throws when there's no such open order. */
  async cancel(id: string, reason = "cancelled"): Promise<Order> {
    return this.change((orders) => {
      const o = orders.find((x) => x.id === id);
      if (!o) throw new HigherError(`No order ${id}.`, { code: "not_found" });
      if (o.status !== "open") throw new HigherError(`Order ${id} is already ${o.status}.`, { code: "order_closed" });
      close(o, "cancelled", reason, this.now());
      return o;
    });
  }

  /** Applies `fn` to one order under the lock; a missing order is skipped. */
  async update(id: string, fn: (o: Order) => void): Promise<Order | undefined> {
    return this.change((orders) => {
      const o = orders.find((x) => x.id === id);
      if (o) fn(o);
      return o;
    });
  }
}

export function close(o: Order, status: Exclude<OrderStatus, "open">, reason: string, now: Date) {
  o.status = status;
  o.closedAt = now.toISOString();
  o.closeReason = reason;
  delete o.fillingSince;
}

export function record(o: Order, run: OrderRun) {
  o.history.push(run);
  if (o.history.length > ORDER_HISTORY) o.history.splice(0, o.history.length - ORDER_HISTORY);
}
