import { lstatSync } from "node:fs";
import { agentPaths, AuditLog, describeOrder, holdProcessLock, lockHolder, loadPolicy, OrderBook, OrderRunner, type Order } from "highwire-agent";
import { serverOptionsFromEnv } from "./env.ts";
import { createDeps } from "./server.ts";
import { signerFromEnv } from "./signer-env.ts";
import { orderMarket } from "./tools/orders.ts";

// `highwire orders run|list|cancel`: the standing orders in ~/.highwire/orders.json. `run` fills them for the wallet
// in HIGHWIRE_KEYPAIR_PATH until Ctrl-C, inside the policy, one runner at a time.

export const ORDERS_USAGE = `highwire orders: standing orders for the local signer (stop-loss, take-profit, recurring buys)

  highwire orders run           fill open orders for HIGHWIRE_KEYPAIR_PATH's wallet until Ctrl-C
  highwire orders list [--all]  open orders (or every order) in the book
  highwire orders cancel <id>   cancel an open order

Agents place orders with the place_order tool, and only kinds the policy's "orders" section allows. Every fill is
checked against the whole policy, simulated and written to the audit log, like execute_trade.`;

type Env = Record<string, string | undefined>;

export interface OrdersIo {
  out: (line: string) => void;
  err: (line: string) => void;
  signal: AbortSignal;
  env?: Env;
}

const line = (o: Order) =>
  `${o.id}  ${o.status.padEnd(9)}  ${describeOrder(o)}${o.kind === "recurring_buy" && o.status === "open" ? ` (${o.runsDone} done, next ${o.nextRunAt})` : ""}${o.closeReason ? `: ${o.closeReason}` : ""}`;

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
      new AuditLog(paths.audit).append({ tool: "highwire orders cancel", action: "trade", cluster: o.cluster, wallet: o.wallet, outcome: "order", sol: "0", lamports: "0", mint: o.mint, order: o.id, reason: `cancelled: ${describeOrder(o)}` });
      io.out(line(o));
      return 0;
    }
    if (cmd === "run") return await runRunner(env, paths, book, io);
  } catch (err) {
    io.err(`highwire orders: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  io.out(ORDERS_USAGE);
  return cmd === undefined || cmd === "--help" ? 0 : 2;
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
      log: (l) => io.err(`${new Date().toISOString().slice(11, 19)}  ${l}`),
    });
    await runner.run(io.signal);
    return 0;
  } finally {
    release();
  }
}
