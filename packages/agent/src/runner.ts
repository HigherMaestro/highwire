import { HigherError, lamportsNumber, solToLamports, type Cluster, type LiveFeed, type Quote } from "highwire-core";
import { close, describeOrder, formatPrice, record, type Order, type OrderBook, type OrderRun } from "./orders.ts";
import type { ExecuteResult } from "./signer.ts";

// Runs the standing orders in the book for one wallet: `highwire orders run`. Price orders (stop-loss, take-profit and
// limit buys) are checked against the
// coin's spot price on-chain, from a fresh quote: every minute, and within seconds of a trade on the coin when the live
// feed reports one. The feed only says when to look, so a forged or stale message can't fire an order. Recurring buys
// and fee claims run on their schedule. Each fill is built and executed by `market.trade` or `market.claim`, which go
// through LocalSigner.execute: the user's policy, the kill switch, a fresh simulation and the audit log, exactly as
// execute_trade and execute_claim.

export interface OrderMarket {
  /** The wallet's balance in the coin, in base units. */
  balance(mint: string): Promise<bigint>;
  /** A quote from on-chain state. */
  quote(mint: string, side: "buy" | "sell", amountIn: bigint, slippageBps: number): Promise<Quote>;
  /** Builds the trade as execute_trade does and executes it through the local signer. */
  trade(req: { order: Order; side: "buy" | "sell"; amountIn: bigint; slippageBps: number }): Promise<ExecuteResult>;
  /**
   * Claims the wallet's creator fees as execute_claim does, through the local signer, when at least `minLamports` of SOL
   * is waiting. `lamports` is the SOL the claim collects (read before it's built); `result` is null when it wasn't made.
   */
  claim(req: { order: Order; minLamports: bigint }): Promise<{ result: ExecuteResult | null; lamports: bigint }>;
}

export interface RunnerOptions {
  book: OrderBook;
  wallet: string;
  cluster: Cluster;
  market: OrderMarket;
  /** For hints: a trade on a watched coin brings its next price check forward. */
  feed?: LiveFeed;
  /** The kill switch: while it's on, nothing is tried. */
  stopped?: () => boolean;
  now?: () => Date;
  log?: (line: string) => void;
  /** How often each order's coin is checked without a hint. Default a minute. */
  pollMs?: number;
  /** The least time between two checks of one coin, hints or not. Default 10 seconds. */
  hintMs?: number;
  /** How often the book is read. Default 5 seconds. */
  tickMs?: number;
}

/** Failures in a row (RPC, simulation) before an order is given up on. */
export const MAX_ORDER_FAILURES = 5;
/** A fee claim doesn't buy back with less than this: the trade's own fees would eat it. */
export const MIN_BUYBACK_LAMPORTS = 1_000_000n;

const isPriceOrder = (o: Order) => o.kind === "stop_loss" || o.kind === "take_profit" || o.kind === "limit_buy";
/** The live feed's per-socket channel budget, less room for nothing else. */
const MAX_HINTED_MINTS = 16;

const TRANSIENT_WAIT_MS = 60_000;

export class OrderRunner {
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly pollMs: number;
  private readonly hintMs: number;
  private readonly tickMs: number;
  private readonly lastCheck = new Map<string, number>();
  private readonly hinted = new Set<string>();
  private started = false;
  private wasStopped = false;

  constructor(private readonly o: RunnerOptions) {
    this.now = o.now ?? (() => new Date());
    this.log = o.log ?? (() => {});
    this.pollMs = o.pollMs ?? 60_000;
    this.hintMs = o.hintMs ?? 10_000;
    this.tickMs = o.tickMs ?? 5_000;
  }

  /** This wallet's open orders on this cluster. */
  private open(): Order[] {
    return this.o.book.list().filter((x) => x.status === "open" && x.wallet === this.o.wallet && x.cluster === this.o.cluster);
  }

  /** Coins with open price orders, which the feed watches for hints. */
  watchedMints(): string[] {
    return [...new Set(this.open().filter(isPriceOrder).map((x) => x.mint!))].slice(0, MAX_HINTED_MINTS);
  }

  /** A trade on `mint` was seen: check it at the next tick, if the last check was long enough ago. */
  hint(mint: string) {
    this.hinted.add(mint);
  }

  /** One pass over the book. Fills run one at a time. */
  async tick(): Promise<void> {
    const now = this.now();
    if (!this.started) {
      this.started = true;
      await this.recoverInterrupted(now);
    }
    if (this.o.stopped?.()) {
      if (!this.wasStopped) this.log("The kill switch is on (STOP file): no orders run until it's removed.");
      this.wasStopped = true;
      return;
    }
    if (this.wasStopped) this.log("The kill switch is off again: orders run.");
    this.wasStopped = false;

    const checked = new Set<string>();
    for (const order of this.open()) {
      if (order.expiresAt && Date.parse(order.expiresAt) <= now.getTime()) {
        await this.o.book.update(order.id, (x) => x.status === "open" && close(x, "expired", "reached its expiry without triggering", now));
        this.log(`order ${order.id} expired: ${describeOrder(order)}`);
        continue;
      }
      const due = order.nextRunAt !== undefined && Date.parse(order.nextRunAt) <= now.getTime();
      if (order.kind === "recurring_buy") {
        if (due) await this.fill(order, "buy", solToLamports(order.sol!), undefined);
      } else if (order.kind === "fee_claim") {
        if (due) await this.claimRun(order);
      } else if (checked.has(order.mint!) || this.due(order.mint!, now.getTime())) {
        checked.add(order.mint!);
        await this.checkPrice(order);
      }
    }
    for (const mint of checked) this.hinted.delete(mint);
  }

  private due(mint: string, at: number): boolean {
    const last = this.lastCheck.get(mint);
    if (last !== undefined && at - last < (this.hinted.has(mint) ? this.hintMs : this.pollMs)) return false;
    this.lastCheck.set(mint, at);
    return true;
  }

  /** A runner that stopped mid-fill may have sent it: never fill such an order again without the user looking. */
  private async recoverInterrupted(now: Date) {
    for (const order of this.open().filter((x) => x.fillingSince)) {
      await this.o.book.update(order.id, (x) => {
        if (x.status !== "open" || !x.fillingSince) return;
        record(x, { at: now.toISOString(), outcome: "failed", reason: "the runner stopped while filling it" });
        close(x, "failed", "the runner stopped while filling it, so it may have been sent: check the audit log for its signature before placing it again", now);
      });
      this.log(`order ${order.id} was being filled when the last runner stopped; closed it as failed so it can't fill twice`);
    }
  }

  private async checkPrice(order: Order) {
    if (order.kind === "limit_buy") return this.checkLimitBuy(order);
    let quote: Quote;
    let amount: bigint;
    try {
      const balance = await this.o.market.balance(order.mint!);
      amount = (balance * BigInt(Math.round(order.sellPct! * 100))) / 10_000n;
      // With nothing to sell, quote one token, just to read the price.
      quote = await this.o.market.quote(order.mint!, "sell", amount > 0n ? amount : 1_000_000n, order.maxSlippageBps);
    } catch (err) {
      this.log(`order ${order.id}: couldn't check the price (${err instanceof Error ? err.message : String(err)}); trying again later`);
      return;
    }
    const price = quote.spotPriceSol;
    if (price === null) return;
    const hit = order.kind === "stop_loss" ? price <= order.triggerPriceSol! : price >= order.triggerPriceSol!;
    if (!hit) return;
    if (amount === 0n) return this.note(order, { outcome: "skipped", reason: "it triggered, but the wallet holds none of the coin", priceSol: price });
    if (order.minSolOut !== undefined && lamportsNumber(quote.minOut) < order.minSolOut) {
      return this.note(order, { outcome: "skipped", reason: `it triggered, but the sale would bring as little as ${lamportsNumber(quote.minOut)} SOL, under its ${order.minSolOut} SOL floor`, priceSol: price });
    }
    this.log(`order ${order.id} triggered at ${formatPrice(price)} SOL: ${describeOrder(order)}`);
    await this.fill(order, "sell", amount, price);
  }

  /** A limit buy fills once the coin's on-chain price is at or below its trigger, with the quote's slippage cap. */
  private async checkLimitBuy(order: Order) {
    const lamports = solToLamports(order.sol!);
    let quote: Quote;
    try {
      quote = await this.o.market.quote(order.mint!, "buy", lamports, order.maxSlippageBps);
    } catch (err) {
      this.log(`order ${order.id}: couldn't check the price (${err instanceof Error ? err.message : String(err)}); trying again later`);
      return;
    }
    const price = quote.spotPriceSol;
    if (price === null || price > order.triggerPriceSol!) return;
    this.log(`order ${order.id} triggered at ${formatPrice(price)} SOL: ${describeOrder(order)}`);
    await this.fill(order, "buy", lamports, price);
  }

  /** Records a run unless it says the same as the last one, so a waiting order doesn't fill its history. */
  private async note(order: Order, run: Omit<OrderRun, "at">) {
    const last = order.history.at(-1);
    if (last && last.outcome === run.outcome && last.reason === run.reason) return;
    await this.o.book.update(order.id, (x) => record(x, { at: this.now().toISOString(), ...run }));
    this.log(`order ${order.id}: ${run.reason}`);
  }

  private async fill(order: Order, side: "buy" | "sell", amountIn: bigint, priceSol: number | undefined) {
    const startedAt = this.now();
    const claimed = await this.o.book.update(order.id, (x) => {
      if (x.status === "open" && !x.fillingSince) x.fillingSince = startedAt.toISOString();
    });
    // Cancelled, or taken, since the book was read.
    if (!claimed || claimed.status !== "open" || claimed.fillingSince !== startedAt.toISOString()) return;

    let result: ExecuteResult | undefined;
    let error: unknown;
    try {
      result = await this.o.market.trade({ order: claimed, side, amountIn, slippageBps: order.maxSlippageBps });
    } catch (err) {
      error = err;
    }
    const now = this.now();
    const at = now.toISOString();
    const price = priceSol !== undefined ? { priceSol } : {};
    await this.o.book.update(order.id, (x) => {
      delete x.fillingSince;
      // A fill that landed counts even if the order was cancelled meanwhile.
      if (result) {
        x.failures = 0;
        const signatures = result.transactions.map((t) => t.signature);
        if (result.status === "partly_sent") {
          record(x, { at, outcome: "partly_sent", signatures, reason: result.transactions.at(-1)?.error, ...price });
          close(x, "failed", "only part of it was sent: check the signatures before placing it again", now);
          return;
        }
        const dry = result.status === "dry_run";
        record(x, { at, outcome: dry ? "dry_run" : "sent", ...(signatures.length ? { signatures } : {}), ...(dry ? { reason: "dry run: the policy isn't live, so nothing was signed" } : {}), ...price });
        if (x.kind === "recurring_buy") {
          x.runsDone += 1;
          x.nextRunAt = new Date(now.getTime() + x.everyHours! * 3_600_000).toISOString();
          if (x.runsDone >= x.times!) close(x, "done", `all ${x.times} buys ran${dry ? " (dry runs)" : ""}`, now);
        } else if (x.status === "open") {
          close(x, "done", dry ? "triggered (dry run: nothing was sent)" : "filled", now);
        }
        return;
      }
      const code = error instanceof HigherError ? error.code : undefined;
      const reason = error instanceof Error ? error.message : String(error);
      if (code === "signer_stopped") return;
      if (code === "send_failed") {
        record(x, { at, outcome: "failed", reason, ...price });
        close(x, "failed", "the send's outcome is unknown: check the audit log's signature before placing it again", now);
        return;
      }
      if (code === "policy_refused" || code === "no_policy" || code === "policy_invalid") {
        // The policy said no. A recurring buy skips this run; a price order waits, and the user may fix the policy.
        const last = x.history.at(-1);
        if (!(last?.outcome === "refused" && last.reason === reason)) record(x, { at, outcome: "refused", reason, ...price });
        if (x.kind === "recurring_buy") x.nextRunAt = new Date(now.getTime() + x.everyHours! * 3_600_000).toISOString();
        return;
      }
      // Something that may pass: an RPC, a simulation, a migrating coin. Try again later, a few times.
      x.failures += 1;
      record(x, { at, outcome: "failed", reason, ...price });
      if (x.failures >= MAX_ORDER_FAILURES) close(x, "failed", `failed ${x.failures} times in a row; last: ${reason}`, now);
      else if (x.kind === "recurring_buy") x.nextRunAt = new Date(now.getTime() + TRANSIENT_WAIT_MS * x.failures).toISOString();
    });
    const after = this.o.book.get(order.id);
    this.log(`order ${order.id}: ${after?.history.at(-1)?.outcome ?? "?"}${after?.history.at(-1)?.signatures ? ` ${after.history.at(-1)!.signatures!.join(", ")}` : ""}${after?.status !== "open" ? ` (now ${after?.status}: ${after?.closeReason})` : ""}${error && !result ? ` (${error instanceof Error ? error.message : String(error)})` : ""}`);
  }

  /**
   * One fee-claim run: claim the creator fees if enough is waiting, then buy back `mint` with `buybackPct` of what came
   * in, then schedule the next run. A claim whose send went unanswered is safe to try again (a second claim finds
   * nothing), so it waits for the next run; a buyback whose send went unanswered closes the order, like any fill.
   */
  private async claimRun(order: Order) {
    const startedAt = this.now();
    const taken = await this.o.book.update(order.id, (x) => {
      if (x.status === "open" && !x.fillingSince) x.fillingSince = startedAt.toISOString();
    });
    if (!taken || taken.status !== "open" || taken.fillingSince !== startedAt.toISOString()) return;

    let claim: { result: ExecuteResult | null; lamports: bigint } | undefined;
    let claimError: unknown;
    try {
      claim = await this.o.market.claim({ order: taken, minLamports: solToLamports(order.minClaimSol ?? 0) });
    } catch (err) {
      claimError = err;
    }
    const claimed = claim?.result && (claim.result.status === "sent" || claim.result.status === "dry_run") ? claim.lamports : 0n;
    const buyLamports = order.buybackPct && order.mint ? (claimed * BigInt(Math.round(order.buybackPct * 100))) / 10_000n : 0n;
    let buy: ExecuteResult | undefined;
    let buyError: unknown;
    if (buyLamports >= MIN_BUYBACK_LAMPORTS) {
      try {
        buy = await this.o.market.trade({ order: taken, side: "buy", amountIn: buyLamports, slippageBps: order.maxSlippageBps });
      } catch (err) {
        buyError = err;
      }
    }

    const now = this.now();
    const at = now.toISOString();
    const nextRun = new Date(now.getTime() + order.everyHours! * 3_600_000).toISOString();
    const codeOf = (err: unknown) => (err instanceof HigherError ? err.code : undefined);
    const why = (err: unknown) => (err instanceof Error ? err.message : String(err));
    const refusedCodes = new Set(["policy_refused", "no_policy", "policy_invalid"]);
    await this.o.book.update(order.id, (x) => {
      delete x.fillingSince;
      const quiet = (run: Omit<OrderRun, "at">) => {
        const last = x.history.at(-1);
        if (!(last && last.outcome === run.outcome && last.reason === run.reason)) record(x, { at, ...run });
      };
      if (claimError !== undefined) {
        const code = codeOf(claimError);
        if (code === "signer_stopped") return;
        if (code && refusedCodes.has(code)) {
          quiet({ outcome: "refused", reason: why(claimError), step: "claim" });
          x.nextRunAt = nextRun;
          return;
        }
        x.failures += 1;
        record(x, { at, outcome: "failed", reason: why(claimError), step: "claim" });
        if (code !== "send_failed" && x.failures >= MAX_ORDER_FAILURES) close(x, "failed", `failed ${x.failures} times in a row; last: ${why(claimError)}`, now);
        else x.nextRunAt = code === "send_failed" ? nextRun : new Date(now.getTime() + TRANSIENT_WAIT_MS * x.failures).toISOString();
        return;
      }
      x.failures = 0;
      x.nextRunAt = nextRun;
      if (!claim?.result) {
        const reason = !claim || claim.lamports === 0n ? "nothing to claim" : `only ${lamportsNumber(claim.lamports)} SOL to claim, under its ${x.minClaimSol} SOL minimum`;
        quiet({ outcome: "skipped", reason, step: "claim" });
        return;
      }
      const r = claim.result;
      const dry = r.status === "dry_run";
      const sigs = r.transactions.map((t) => t.signature);
      record(x, {
        at,
        outcome: r.status === "partly_sent" ? "partly_sent" : dry ? "dry_run" : "sent",
        ...(sigs.length ? { signatures: sigs } : {}),
        reason: `${dry ? "would claim" : "claimed"} about ${lamportsNumber(claim.lamports)} SOL${r.status === "partly_sent" ? `; only part was sent (${r.transactions.at(-1)?.error ?? "see the audit log"}), and the next run claims the rest` : ""}`,
        step: "claim",
      });
      x.runsDone += 1;
      if (!(x.buybackPct && x.mint) || r.status === "partly_sent") return;
      if (buyLamports < MIN_BUYBACK_LAMPORTS) {
        record(x, { at, outcome: "skipped", reason: `${lamportsNumber(buyLamports)} SOL is too little to buy back`, step: "buyback" });
        return;
      }
      if (buy) {
        const bs = buy.transactions.map((t) => t.signature);
        if (buy.status === "partly_sent") {
          record(x, { at, outcome: "partly_sent", signatures: bs, reason: buy.transactions.at(-1)?.error, step: "buyback" });
          close(x, "failed", "only part of a buyback was sent: check the signatures before placing it again", now);
          return;
        }
        record(x, { at, outcome: buy.status === "dry_run" ? "dry_run" : "sent", ...(bs.length ? { signatures: bs } : {}), reason: `bought back with ${lamportsNumber(buyLamports)} SOL`, step: "buyback" });
        return;
      }
      const code = codeOf(buyError);
      if (code === "signer_stopped") return;
      if (code === "send_failed") {
        record(x, { at, outcome: "failed", reason: why(buyError), step: "buyback" });
        close(x, "failed", "a buyback's send outcome is unknown: check the audit log's signature before placing it again", now);
        return;
      }
      // Refused or failed: the SOL stays in the wallet, and the next run buys back with what it claims then.
      record(x, { at, outcome: code && refusedCodes.has(code) ? "refused" : "failed", reason: why(buyError), step: "buyback" });
    });
    const after = this.o.book.get(order.id);
    const lastTwo = after?.history.slice(-2).map((h) => `${h.step ?? ""} ${h.outcome}${h.reason ? ` (${h.reason})` : ""}`).join("; ");
    this.log(`order ${order.id}: ${lastTwo ?? "?"}${after?.status !== "open" ? ` (now ${after?.status}: ${after?.closeReason})` : ""}`);
  }

  /**
   * Runs until `signal` aborts: a tick every few seconds, and the live feed watching the coins with price orders.
   * The caller holds the runner lock.
   */
  async run(signal: AbortSignal): Promise<void> {
    // Reassigned inside rewatch(), which TypeScript doesn't follow.
    let feedCtl = null as AbortController | null;
    let watching = "";
    const rewatch = () => {
      if (!this.o.feed) return;
      const mints = this.watchedMints();
      const key = mints.join(",");
      if (key === watching) return;
      watching = key;
      feedCtl?.abort();
      feedCtl = null;
      if (!mints.length) return;
      const ctl = new AbortController();
      feedCtl = ctl;
      this.o.feed.watch({ kinds: ["buy", "sell"], mints }, (e) => this.hint(e.mint), { signal: ctl.signal }).catch((err) => {
        this.log(`The live feed isn't available (${err instanceof Error ? err.message : String(err)}); checking prices every ${this.pollMs / 1000} s instead.`);
      });
    };
    signal.addEventListener("abort", () => feedCtl?.abort(), { once: true });
    while (!signal.aborted) {
      try {
        await this.tick();
        rewatch();
      } catch (err) {
        this.log(`orders: ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.tickMs);
        signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
    }
    feedCtl?.abort();
  }
}
