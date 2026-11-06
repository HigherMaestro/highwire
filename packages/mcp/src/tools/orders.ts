import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PublicKey } from "@solana/web3.js";
import { HigherError, lamportsNumber, MAX_SLIPPAGE_BPS, quoteTrade, solToLamports, tokensNumber, ValidationError } from "highwire-core";
import { checkPolicy, describeOrder, lockHolder, ORDER_KINDS, OrderBook, type NewOrder, type Order, type OrderMarket } from "highwire-agent";
import { run } from "../result.ts";
import { EXECUTE, mint, READ_ONLY, type Deps, type ExecutionSigner } from "./shared.ts";
import { creatorOf, executeTrade } from "./execute.ts";
import { buildClaimFor } from "./transactions.ts";

// Standing orders for the local signer: stop-loss, take-profit, recurring buys and fee claims. The tools place, list
// and cancel them in ~/.highwire/orders.json; `highwire orders run` fills them. Placing one needs the policy's `orders` section
// to allow that kind, and each fill is checked against the whole policy again when it runs.

const ORDER_EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const refused = (rule: string, reason: string) => new HigherError(`The policy refused this: ${reason}.`, { code: "policy_refused", body: { rule } });

/** The wallet's balance in a coin, in base units, summed over its token accounts. */
export async function tokenBalance(chain: Deps["chain"], owner: PublicKey, mintAddress: string): Promise<bigint> {
  const res = await chain.connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mintAddress) }, "confirmed");
  let total = 0n;
  for (const a of res.value) {
    const amount = (a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount;
    if (amount) total += BigInt(amount);
  }
  return total;
}

/** What the runner needs, from the chain and the signer: the same build and execute as execute_trade. */
export function orderMarket(deps: Deps, signer: ExecutionSigner): OrderMarket {
  const { chain } = deps;
  return {
    balance: (m) => tokenBalance(chain, signer.publicKey, m),
    quote: (m, side, amountIn, slippageBps) => quoteTrade(chain, { mint: new PublicKey(m), side, amountIn, slippageBps }),
    trade: async ({ order, side, amountIn, slippageBps }) => {
      // A buy spends the order's SOL (a buyback, what the runner worked out from the claim); a sell may return up to
      // HIGHWIRE_MAX_SOL_PER_TX, like any built trade.
      const maxLamports = side === "buy" ? (order.kind === "fee_claim" ? amountIn : solToLamports(order.sol!)) : solToLamports(deps.maxSolPerTx);
      const { result } = await executeTrade(deps, signer, `order ${order.kind}`, { mint: order.mint!, side, amountIn, slippageBps, maxLamports }, order.id);
      return result;
    },
    claim: async ({ order, minLamports }) => {
      // The same claim build_claim_creator_fees and execute_claim make, and the SOL it collects.
      const { result: r } = await buildClaimFor(deps, signer.publicKey);
      const lamports = solToLamports(r.claimable.curveSol) + r.claimable.pools.reduce((n, p) => n + solToLamports(p.sol), 0n);
      if (!r.envelope || lamports === 0n || lamports < minLamports) return { result: null, lamports };
      const result = await signer.execute(chain.connection, { tool: `order ${order.kind}`, intent: { action: "claim", cluster: chain.cluster, solOut: 0n }, envelope: r.envelope, order: order.id });
      return { result, lamports };
    },
  };
}

export function viewOrder(o: Order) {
  return {
    id: o.id,
    kind: o.kind,
    status: o.status,
    description: describeOrder(o),
    mint: o.mint,
    ...(o.triggerPriceSol !== undefined ? { triggerPriceSol: o.triggerPriceSol, sellPct: o.sellPct } : {}),
    ...(o.minSolOut !== undefined ? { minSolOut: o.minSolOut } : {}),
    ...(o.kind === "recurring_buy" ? { sol: o.sol, everyHours: o.everyHours, times: o.times, runsDone: o.runsDone, nextRunAt: o.nextRunAt } : {}),
    ...(o.kind === "fee_claim" ? { everyHours: o.everyHours, minClaimSol: o.minClaimSol, ...(o.buybackPct ? { buybackPct: o.buybackPct } : {}), runsDone: o.runsDone, nextRunAt: o.nextRunAt } : {}),
    createdAt: o.createdAt,
    ...(o.expiresAt ? { expiresAt: o.expiresAt } : {}),
    ...(o.closedAt ? { closedAt: o.closedAt, closeReason: o.closeReason } : {}),
    recent: o.history.slice(-5),
  };
}

function runnerState(signer: ExecutionSigner) {
  const pid = lockHolder(signer.paths.ordersRunner);
  return pid !== null
    ? { running: true, pid }
    : { running: false, note: "Orders fill only while `highwire orders run` is running on this machine. Ask the user to start it in a terminal, with the same HIGHWIRE_KEYPAIR_PATH." };
}

export function registerOrderTools(server: McpServer, deps: Deps, signer: ExecutionSigner) {
  const { chain } = deps;
  const cluster = chain.cluster;
  const book = new OrderBook(signer.paths.orders);

  server.registerTool(
    "place_order",
    {
      title: "Place a standing order (local signer)",
      description:
        "Place a stop-loss, take-profit, recurring buy or fee claim that the local signer runs later, without asking " +
        "again, while `highwire orders run` is running. stop_loss sells sell_pct of the wallet's coin once its on-chain " +
        "price falls to the trigger; take_profit once it rises to it (give trigger_price_sol, or trigger_change_pct from the " +
        "current price). recurring_buy buys `sol` every every_hours, `times` times. fee_claim claims the wallet's creator " +
        "fees every every_hours when at least min_claim_sol is waiting, and with buyback_pct spends that share of the SOL " +
        "claimed buying `mint` (say the wallet's own coin). Each run passes the whole policy again; buys and sells are trades " +
        "like execute_trade's, with Highwire's 0.3% trade fee, and claims are free. Needs the policy's `orders` section to " +
        "allow the kind. Explain the order to the user and set confirm_order only after they approve it.",
      inputSchema: {
        kind: z.enum(ORDER_KINDS),
        mint: mint.optional().describe("The coin. fee_claim takes one only with buyback_pct: the coin to buy back."),
        trigger_price_sol: z.number().positive().optional().describe("Price orders: the trigger, in SOL per whole token."),
        trigger_change_pct: z
          .number()
          .min(-99)
          .max(10_000)
          .optional()
          .describe("Price orders, instead of trigger_price_sol: the trigger as a change from the current price, such as -20 or 50."),
        sell_pct: z.number().min(1).max(100).default(100).describe("Price orders: the share of the wallet's balance to sell."),
        min_sol_out: z.number().positive().optional().describe("Price orders: never sell for less than this much SOL in all; it waits instead."),
        sol: z.number().positive().max(deps.maxSolPerTx).optional().describe("recurring_buy: SOL to spend each time."),
        every_hours: z.number().min(1).max(720).optional().describe("recurring_buy and fee_claim: hours between runs."),
        times: z.number().int().min(1).max(1000).optional().describe("recurring_buy: how many buys in all."),
        min_claim_sol: z.number().min(0).max(10).default(0.001).describe("fee_claim: skip a run when less than this much SOL is waiting."),
        buyback_pct: z.number().min(1).max(100).optional().describe("fee_claim: the share of the SOL claimed to spend buying `mint`."),
        max_slippage_bps: z.number().int().min(0).max(MAX_SLIPPAGE_BPS).describe("Slippage for each fill, within the policy's."),
        expires_in_days: z.number().min(1).max(90).default(30).describe("Price orders and fee claims: close it after this many days."),
        confirm_order: z.literal(true).describe("Set to true only after the user approved this exact order."),
      },
      // Destructive like the execute tools: it commits the wallet to trades no one confirms again.
      annotations: { title: "Place a standing order (local signer)", ...EXECUTE },
    },
    (args) =>
      run(async () => {
        const feeClaim = args.kind === "fee_claim";
        const policy = signer.precheck(feeClaim ? "claim" : "trade", cluster, "place_order");
        if (!policy.orders?.kinds.includes(args.kind)) {
          throw refused("orders.kinds", `the policy doesn't allow ${args.kind} orders (its "orders" section lists the kinds an agent may place)`);
        }
        if (args.max_slippage_bps > policy.max_slippage_bps) {
          throw refused("max_slippage_bps", `${args.max_slippage_bps} bps of slippage is over the policy's ${policy.max_slippage_bps}`);
        }
        const recurring = args.kind === "recurring_buy";
        if (feeClaim && (args.buyback_pct === undefined) !== (args.mint === undefined)) {
          throw new ValidationError("A fee_claim buys back only with both buyback_pct and mint (the coin to buy); give both or neither.");
        }
        if (!feeClaim && args.mint === undefined) throw new ValidationError(`A ${args.kind} order takes mint.`);
        if (feeClaim && args.mint !== undefined && !policy.actions.includes("trade")) {
          throw refused("actions", "the policy doesn't allow trades, so a fee claim can't buy back");
        }
        if (args.mint !== undefined) {
          const creator = policy.creators ? await creatorOf(chain, args.mint) : null;
          const solOut = recurring && args.sol !== undefined ? solToLamports(args.sol) : 0n;
          // The coin, creator, slippage and per-transaction rules now; the daily limit is checked at each fill.
          const refusal = checkPolicy(policy, { action: "trade", cluster, solOut, slippageBps: args.max_slippage_bps, mint: args.mint, creator }, 0n);
          if (refusal && refusal.rule !== "max_sol_per_day") throw refused(refusal.rule, refusal.reason);
        }
        const now = new Date();
        let order: NewOrder;
        let current: Record<string, unknown>;

        if (feeClaim) {
          if (args.every_hours === undefined) throw new ValidationError("A fee_claim takes every_hours.");
          if (args.sol !== undefined || args.times !== undefined || args.trigger_price_sol !== undefined || args.trigger_change_pct !== undefined || args.min_sol_out !== undefined) {
            throw new ValidationError("A fee_claim takes every_hours, min_claim_sol, and optionally buyback_pct with mint; nothing else.");
          }
          if (args.mint !== undefined) {
            // Quote a small buy now, so a coin that can't be bought fails here rather than at the first buyback.
            await quoteTrade(chain, { mint: new PublicKey(args.mint), side: "buy", amountIn: 10_000_000n, slippageBps: args.max_slippage_bps });
          }
          const { result: c } = await buildClaimFor(deps, signer.publicKey);
          current = { claimableSol: Math.round((c.claimable.curveSol + c.claimable.pools.reduce((n, p) => n + p.sol, 0)) * 1e9) / 1e9 };
          order = {
            kind: "fee_claim",
            cluster,
            wallet: signer.wallet,
            ...(args.mint !== undefined ? { mint: args.mint, buybackPct: args.buyback_pct } : {}),
            maxSlippageBps: args.max_slippage_bps,
            everyHours: args.every_hours,
            minClaimSol: args.min_claim_sol,
            nextRunAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + args.expires_in_days * 86_400_000).toISOString(),
          };
        } else if (recurring) {
          if (args.sol === undefined || args.every_hours === undefined || args.times === undefined) throw new ValidationError("A recurring_buy takes sol, every_hours and times.");
          if (args.trigger_price_sol !== undefined || args.trigger_change_pct !== undefined || args.min_sol_out !== undefined) {
            throw new ValidationError("A recurring_buy has no trigger or min_sol_out.");
          }
          // Quote it now, so a coin that can't be bought fails here rather than at the first run.
          const q = await quoteTrade(chain, { mint: new PublicKey(args.mint!), side: "buy", amountIn: solToLamports(args.sol), slippageBps: args.max_slippage_bps });
          current = { spotPriceSol: q.spotPriceSol, eachBuyGetsTokens: tokensNumber(q.amountOut), totalSol: Math.round(args.sol * args.times * 1e9) / 1e9 };
          order = { kind: "recurring_buy", cluster, wallet: signer.wallet, mint: args.mint, maxSlippageBps: args.max_slippage_bps, sol: args.sol, everyHours: args.every_hours, times: args.times, nextRunAt: now.toISOString() };
        } else {
          if ((args.trigger_price_sol === undefined) === (args.trigger_change_pct === undefined)) throw new ValidationError("Give trigger_price_sol or trigger_change_pct, not both.");
          if (args.sol !== undefined || args.every_hours !== undefined || args.times !== undefined) throw new ValidationError("A price order sells; sol, every_hours and times are for recurring_buy.");
          const balance = await tokenBalance(chain, signer.publicKey, args.mint!);
          const amount = (balance * BigInt(Math.round(args.sell_pct * 100))) / 10_000n;
          if (amount === 0n) throw new ValidationError(`The signer's wallet holds none of ${args.mint}, so there's nothing to sell.`);
          const q = await quoteTrade(chain, { mint: new PublicKey(args.mint!), side: "sell", amountIn: amount, slippageBps: args.max_slippage_bps });
          const spot = q.spotPriceSol;
          if (spot === null) throw new ValidationError("The coin's price can't be read on-chain right now.");
          const trigger = args.trigger_price_sol ?? Number((spot * (1 + args.trigger_change_pct! / 100)).toPrecision(6));
          const stopLoss = args.kind === "stop_loss";
          if (stopLoss ? trigger >= spot : trigger <= spot) {
            throw new ValidationError(`The trigger ${trigger} SOL is ${stopLoss ? "at or above" : "at or below"} the current price ${spot} SOL, so it would fill at once. Use execute_trade to sell now.`);
          }
          // A sale may return at most HIGHWIRE_MAX_SOL_PER_TX, so an order worth more could never fill.
          const worth = tokensNumber(amount) * Math.max(spot, trigger);
          if (worth > deps.maxSolPerTx) {
            throw new ValidationError(`Selling ${tokensNumber(amount)} tokens could bring about ${Math.round(worth * 1e4) / 1e4} SOL, over the ${deps.maxSolPerTx} SOL a built trade may return (HIGHWIRE_MAX_SOL_PER_TX). Lower sell_pct.`);
          }
          current = { spotPriceSol: spot, sellTokens: tokensNumber(amount), wouldGetSolNow: lamportsNumber(q.amountOut) };
          order = {
            kind: args.kind,
            cluster,
            wallet: signer.wallet,
            mint: args.mint,
            maxSlippageBps: args.max_slippage_bps,
            triggerPriceSol: trigger,
            sellPct: args.sell_pct,
            ...(args.min_sol_out !== undefined ? { minSolOut: args.min_sol_out } : {}),
            expiresAt: new Date(now.getTime() + args.expires_in_days * 86_400_000).toISOString(),
          };
        }

        const placed = await book.place(order, policy.orders.max_open);
        signer.logOrder("place_order", placed, `placed: ${describeOrder(placed)}`);
        return {
          order: viewOrder(placed),
          now: current,
          live: policy.live,
          ...(policy.live ? {} : { note: 'The policy is a dry run ("live": false): when this triggers it is checked and simulated, and nothing is sent.' }),
          runner: runnerState(signer),
        };
      }),
  );

  server.registerTool(
    "list_orders",
    {
      title: "List standing orders (local signer)",
      description:
        "The local signer's standing orders (stop-loss, take-profit, recurring buys): what each does, its status and its " +
        "recent runs, whether `highwire orders run` is running to fill them, and what the policy allows.",
      inputSchema: { status: z.enum(["open", "all"]).default("open") },
      annotations: { title: "List standing orders (local signer)", ...READ_ONLY, openWorldHint: false },
    },
    ({ status }) =>
      run(async () => {
        const mine = book.list().filter((o) => o.wallet === signer.wallet && o.cluster === cluster && (status === "all" || o.status === "open"));
        const s = signer.status();
        return { runner: runnerState(signer), policy: s.policy ? { live: s.policy.live, orders: s.policy.orders ?? null } : { problem: s.policyProblem }, orders: mine.map(viewOrder) };
      }),
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel a standing order (local signer)",
      description: "Cancel one of the local signer's open standing orders by its id, from list_orders. A fill already under way still lands.",
      inputSchema: { id: z.string().regex(/^[0-9a-f]{8}$/).describe("The order's id.") },
      annotations: { title: "Cancel a standing order (local signer)", ...ORDER_EDIT },
    },
    ({ id }) =>
      run(async () => {
        const o = book.get(id);
        if (!o || o.wallet !== signer.wallet) throw new HigherError(`No order ${id} for this signer's wallet.`, { code: "not_found" });
        const cancelled = await book.cancel(id, "cancelled through cancel_order");
        signer.logOrder("cancel_order", cancelled, `cancelled: ${describeOrder(cancelled)}`);
        return { order: viewOrder(cancelled) };
      }),
  );
}
