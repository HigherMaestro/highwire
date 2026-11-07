import { parseArgs } from "node:util";
import { lstatSync } from "node:fs";
import { agentPaths, AuditLog, describeOrder, formatPrice, holdProcessLock, lockHolder, loadPolicy, OrderBook, OrderRunner, type Order } from "highwire-agent";
import { serverOptionsFromEnv } from "./env.ts";
import { createDeps } from "./server.ts";
import { signerFromEnv } from "./signer-env.ts";
import { orderMarket } from "./tools/orders.ts";
import { callTool } from "./launch-cli.ts";

// `highwire orders run|list|cancel`: the standing orders in ~/.highwire/orders.json. `run` fills them for the wallet
// in HIGHWIRE_KEYPAIR_PATH until Ctrl-C, inside the policy, one runner at a time.

export const ORDERS_USAGE = `highwire orders: standing orders for the local signer (stop-loss, take-profit, limit buys, recurring buys, fee claims)

  highwire orders run           fill open orders for HIGHWIRE_KEYPAIR_PATH's wallet until Ctrl-C
  highwire orders list [--all]  open orders (or every order) in the book
  highwire orders cancel <id>   cancel an open order
  highwire orders claim --every-hours <h> [--min-sol <sol>] [--buyback-pct <pct> --mint <mint>] [--slippage-bps <bps>]
                                claim the wallet's creator fees every <h> hours (when at least --min-sol is waiting,
                                default 0.001), and buy back --mint with that share of each claim
  highwire orders limit-buy --mint <mint> --sol <sol> (--price <sol> | --drop-pct <pct>) [--slippage-bps <bps>] [--expires-days <d>]
                                buy --sol of the coin once its price falls to --price SOL a token, or --drop-pct below now

Agents place orders with the place_order tool (or \`orders claim\`), and only kinds the policy's "orders" section allows. Every fill is
checked against the whole policy, simulated and written to the audit log, like execute_trade.`;

type Env = Record<string, string | undefined>;

export interface OrdersIo {
  out: (line: string) => void;
  err: (line: string) => void;
  signal: AbortSignal;
  env?: Env;
}

const line = (o: Order) =>
  `${o.id}  ${o.status.padEnd(9)}  ${describeOrder(o)}${(o.kind === "recurring_buy" || o.kind === "fee_claim") && o.status === "open" ? ` (${o.runsDone} done, next ${o.nextRunAt})` : ""}${o.closeReason ? `: ${o.closeReason}` : ""}`;

export async function runOrders(argv: string[], io: OrdersIo): Promise<number> {
  const env = io.env ?? process.env;
  const paths = agentPaths(env);
  const book = new OrderBook(paths.orders);
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "list") {
      const all = rest.includes("--all");
      const orders = book.list().filter((o) => all || o.status === "open");
      const pid = lockHolder(paths.ordersRunner);
      io.err(pid !== null ? `A runner is filling orders (pid ${pid}).` : "No runner is running: open orders wait until `highwire orders run`.");
      if (!orders.length) io.out(all ? "No orders." : "No open orders.");
      for (const o of orders) io.out(line(o));
      return 0;
    }
    if (cmd === "cancel") {
      const id = rest[0];
      if (!id || !/^[0-9a-f]{8}$/.test(id)) {
        io.err(`highwire orders cancel: give an order id from \`highwire orders list\`\n\n${ORDERS_USAGE}`);
        return 2;
      }
      const o = await book.cancel(id, "cancelled from the command line");
      new AuditLog(paths.audit).append({ tool: "highwire orders cancel", action: o.kind === "fee_claim" ? "claim" : "trade", cluster: o.cluster, wallet: o.wallet, outcome: "order", sol: "0", lamports: "0", ...(o.mint ? { mint: o.mint } : {}), order: o.id, reason: `cancelled: ${describeOrder(o)}` });
      io.out(line(o));
      return 0;
    }
    if (cmd === "run") return await runRunner(env, paths, book, io);
    if (cmd === "claim") return await placeClaim(rest, env, io);
    if (cmd === "limit-buy") return await placeLimitBuy(rest, env, io);
  } catch (err) {
    io.err(`highwire orders: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  io.out(ORDERS_USAGE);
  return cmd === undefined || cmd === "--help" ? 0 : 2;
}

/** `highwire orders claim`: a fee_claim order, placed through place_order with the CLI's signer. */
async function placeClaim(argv: string[], env: Env, io: OrdersIo): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { "every-hours": { type: "string" }, "min-sol": { type: "string" }, "buyback-pct": { type: "string" }, mint: { type: "string" }, "slippage-bps": { type: "string" }, json: { type: "boolean" } },
      strict: true,
    }));
  } catch (err) {
    io.err(`highwire orders claim: ${(err as Error).message}\n\n${ORDERS_USAGE}`);
    return 2;
  }
  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  const args: Record<string, unknown> = {
    kind: "fee_claim",
    every_hours: num(values["every-hours"]),
    max_slippage_bps: num(values["slippage-bps"]) ?? 500,
    confirm_order: true,
    ...(values["min-sol"] !== undefined ? { min_claim_sol: num(values["min-sol"]) } : {}),
    ...(values["buyback-pct"] !== undefined ? { buyback_pct: num(values["buyback-pct"]) } : {}),
    ...(values.mint !== undefined ? { mint: values.mint } : {}),
  };
  if (args.every_hours === undefined || Object.values(args).some((v) => typeof v === "number" && !Number.isFinite(v))) {
    io.err(`highwire orders claim: give --every-hours, and numbers for the other flags\n\n${ORDERS_USAGE}`);
    return 2;
  }
  const r = await callTool(env, { out: io.out, err: io.err }, "place_order", args);
  if (!r) return 1;
  if (values.json) io.out(JSON.stringify(r.body, null, 2));
  else if (!r.ok) io.err(`highwire orders claim: ${String(r.body.error)}${r.body.next_step ? `\n${String(r.body.next_step)}` : ""}`);
  else {
    const o = r.body.order as Order & { description: string };
    io.out(`${o.id}  ${o.description}. Waiting now: ${String((r.body.now as { claimableSol?: number })?.claimableSol ?? "?")} SOL.`);
    io.out((r.body.runner as { running: boolean }).running ? "A runner is filling orders." : "It runs while `highwire orders run` is running.");
  }
  return r.ok ? 0 : 1;
}

/** `highwire orders limit-buy`: a limit_buy order, placed through place_order with the CLI's signer. */
async function placeLimitBuy(argv: string[], env: Env, io: OrdersIo): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { mint: { type: "string" }, sol: { type: "string" }, price: { type: "string" }, "drop-pct": { type: "string" }, "slippage-bps": { type: "string" }, "expires-days": { type: "string" }, json: { type: "boolean" } },
      strict: true,
    }));
  } catch (err) {
    io.err(`highwire orders limit-buy: ${(err as Error).message}\n\n${ORDERS_USAGE}`);
    return 2;
  }
  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  const drop = num(values["drop-pct"]);
  const args: Record<string, unknown> = {
    kind: "limit_buy",
    mint: values.mint,
    sol: num(values.sol),
    max_slippage_bps: num(values["slippage-bps"]) ?? 300,
    confirm_order: true,
    ...(values.price !== undefined ? { trigger_price_sol: num(values.price) } : {}),
    ...(drop !== undefined ? { trigger_change_pct: -Math.abs(drop) } : {}),
    ...(values["expires-days"] !== undefined ? { expires_in_days: num(values["expires-days"]) } : {}),
  };
  if (!values.mint || args.sol === undefined || (values.price === undefined) === (drop === undefined) || Object.values(args).some((v) => typeof v === "number" && !Number.isFinite(v))) {
    io.err(`highwire orders limit-buy: give --mint, --sol, and --price or --drop-pct, as numbers\n\n${ORDERS_USAGE}`);
    return 2;
  }
  const r = await callTool(env, { out: io.out, err: io.err }, "place_order", args);
  if (!r) return 1;
  if (values.json) io.out(JSON.stringify(r.body, null, 2));
  else if (!r.ok) io.err(`highwire orders limit-buy: ${String(r.body.error)}${r.body.next_step ? `\n${String(r.body.next_step)}` : ""}`);
  else {
    const o = r.body.order as Order & { description: string };
    io.out(`${o.id}  ${o.description}. Now: ${formatPrice((r.body.now as { spotPriceSol?: number } | undefined)?.spotPriceSol)} SOL.`);
    io.out((r.body.runner as { running: boolean }).running ? "A runner is filling orders." : "It fills while `highwire orders run` is running.");
  }
  return r.ok ? 0 : 1;
}

async function runRunner(env: Env, paths: ReturnType<typeof agentPaths>, book: OrderBook, io: OrdersIo): Promise<number> {
  const signer = signerFromEnv(env, io.err);
  if (!signer) {
    io.err("highwire orders run: set HIGHWIRE_KEYPAIR_PATH to the signer's keypair file, as for the MCP server.");
    return 2;
  }
  const deps = createDeps({ ...serverOptionsFromEnv(env), signer });
  const release = holdProcessLock(paths.ordersRunner, "highwire orders run");
  try {
    const policy = loadPolicy(paths.policy);
    const open = book.list().filter((o) => o.status === "open" && o.wallet === signer.wallet && o.cluster === deps.chain.cluster);
    io.err(
      `Filling orders for ${signer.wallet} on ${deps.chain.cluster}, ${policy.live ? "live" : 'dry run ("live": false: nothing is sent)'}; ` +
        `${open.length} open. The policy ${policy.orders ? `allows ${policy.orders.kinds.join(", ")}` : "has no orders section, so every fill will be refused"}. Ctrl-C to stop.`,
    );
    const stopped = () => {
      try {
        lstatSync(paths.stop);
        return true;
      } catch {
        return false;
      }
    };
    const runner = new OrderRunner({
      book,
      wallet: signer.wallet,
      cluster: deps.chain.cluster,
      market: orderMarket(deps, signer),
      feed: deps.live,
      stopped,
      live: () => {
        try {
          return loadPolicy(paths.policy).live;
        } catch {
          return false;
        }
      },
      log: (l) => io.err(`${new Date().toISOString().slice(11, 19)}  ${l}`),
    });
    await runner.run(io.signal);
    return 0;
  } finally {
    release();
  }
}
