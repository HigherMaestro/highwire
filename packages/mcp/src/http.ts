import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer, type ServerOptions } from "./server.ts";
import { BUILD_TOOL_NAMES } from "./tools/transactions.ts";

// Stateless by design: a fresh server and transport per POST, no session IDs,
// JSON responses instead of SSE, and 405 for GET and DELETE. Nothing is shared
// between requests, so it scales out on serverless. build_launch derives its
// mint from the idempotency key (DerivedLaunchKeys), so a retry that lands on
// another instance still gets the same coin.

/**
 * Whether the public hosted endpoint serves the transaction tools. They only ever return unsigned transactions and a
 * sign link; the user's own wallet signs on highwire.fun/sign. This is the one switch for the hosted endpoint.
 */
export const HOSTED_TRANSACTION_TOOLS = true;

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export interface RateLimit {
  /** Units each client IP may spend in each window. A build tool call costs BUILD_COST, anything else 1. */
  limit: number;
  windowMs: number;
}

export interface HttpHandlerOptions {
  /** Passed to createServer() for every request. */
  server?: ServerOptions;
  /** Per-IP budget on POSTs. Defaults to 60 units a minute; false turns it off. */
  rateLimit?: RateLimit | false;
  /** Picks the client's IP. Defaults to the first X-Forwarded-For entry, then X-Real-IP. */
  clientIp?: (req: Request) => string | undefined;
  /** Largest POST body accepted, in bytes. Defaults to 256 KiB. */
  maxBodyBytes?: number;
}

export const DEFAULT_RATE_LIMIT: RateLimit = { limit: 60, windowMs: 60_000 };
/** What one build tool call costs against the rate limit. Every other request costs 1, unless TOOL_COSTS says more. */
export const BUILD_COST = 5;
/**
 * Read tools that do a lot of upstream work per call, weighed by it. A wallet listing reads every token account a
 * wallet holds and prices up to dozens of coins; with `mints` it reads only those.
 */
export const TOOL_COSTS: Record<string, (args: Record<string, unknown>) => number> = {
  get_wallet_positions: (args) => (Array.isArray(args.mints) && args.mints.length ? 3 : 10),
  quote_trade: () => 2,
  rug_check: () => 2,
};
/** Most JSON-RPC messages one POST may batch. An agent sends one at a time; a batch only multiplies the work. */
export const MAX_BATCH = 10;

/**
 * The client's IP from the proxy's headers. Only trust this behind a proxy that overwrites them (Vercel does); a
 * self-hosted server reachable directly should pass its own `clientIp`.
 */
function defaultClientIp(req: Request): string | undefined {
  const forwarded = req.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip")?.trim() || undefined;
}

/** The rate-limit key for an IP: IPv6 addresses by their /64, since one client usually holds a whole /64. */
export function rateLimitKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** The body, read up to `max` bytes: a chunked body has no Content-Length to check first. Null when it's longer. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * A fixed-window budget per IP, held in memory. On serverless hosts each
 * instance keeps its own counts, so treat it as a brake, not a guarantee.
 */
export function createRateLimiter({ limit, windowMs }: RateLimit, now: () => number = Date.now) {
  const windows = new Map<string, { spent: number; resetAt: number }>();
  return (key: string, cost = 1): { ok: true } | { ok: false; retryAfterSec: number } => {
    const t = now();
    if (windows.size > 10_000) {
      for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
    }
    let w = windows.get(key);
    if (!w || w.resetAt <= t) {
      w = { spent: 0, resetAt: t + windowMs };
      windows.set(key, w);
    }
    if (w.spent + cost > limit) return { ok: false, retryAfterSec: Math.ceil((w.resetAt - t) / 1000) };
    w.spent += cost;
    return { ok: true };
  };
}

const BUILD_TOOLS = new Set<string>(BUILD_TOOL_NAMES);

/** How many JSON-RPC messages a body holds (1 when it isn't JSON). */
export function batchSize(body: string): number {
  try {
    const msg: unknown = JSON.parse(body);
    return Array.isArray(msg) ? msg.length : 1;
  } catch {
    return 1;
  }
}

/** What a JSON-RPC body costs: BUILD_COST per build tool call, TOOL_COSTS for heavy reads, 1 for anything else. */
export function requestCost(body: string): number {
  let msg: unknown;
  try {
    msg = JSON.parse(body);
  } catch {
    return 1;
  }
  const msgs = Array.isArray(msg) ? msg : [msg];
  let cost = 0;
  for (const m of msgs) {
    const r = m as { method?: unknown; params?: { name?: unknown; arguments?: unknown } } | null;
    const name = r?.method === "tools/call" && typeof r.params?.name === "string" ? r.params.name : null;
    const args = r?.params?.arguments && typeof r.params.arguments === "object" ? (r.params.arguments as Record<string, unknown>) : {};
    cost += name === null ? 1 : BUILD_TOOLS.has(name) ? BUILD_COST : (TOOL_COSTS[name]?.(args) ?? 1);
  }
  return Math.max(1, cost);
}

function rpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...headers },
  });
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * A stateless Streamable HTTP endpoint for the public hosted server, as a fetch-style handler:
 * `(Request) => Promise<Response>`. It serves the read tools and, per HOSTED_TRANSACTION_TOOLS, the transaction tools,
 * which only return unsigned transactions. Mount it on one path for every method (Next.js route handlers, Hono, Bun,
 * Deno, workers).
 */
export function createHttpHandler(opts: HttpHandlerOptions = {}): (req: Request) => Promise<Response> {
  const limiter = opts.rateLimit === false ? undefined : createRateLimiter(opts.rateLimit ?? DEFAULT_RATE_LIMIT);
  const clientIp = opts.clientIp ?? defaultClientIp;
  const maxBodyBytes = opts.maxBodyBytes ?? 256 * 1024;

  return async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== "POST") {
      return rpcError(405, -32000, "Method not allowed. This server is stateless: POST JSON-RPC messages to this URL.", {
        Allow: "POST, OPTIONS",
      });
    }

    // Read the body once, to weigh it for the rate limit, then hand the transport a copy.
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > maxBodyBytes) return rpcError(413, -32000, "Request body too large.");
    const body = await readCapped(req, maxBodyBytes);
    if (body === null) return rpcError(413, -32000, "Request body too large.");
    if (batchSize(body) > MAX_BATCH) return rpcError(413, -32600, `At most ${MAX_BATCH} messages per request.`);

    if (limiter) {
      const ip = clientIp(req);
      const verdict = limiter(ip ? rateLimitKey(ip) : "unknown", requestCost(body));
      if (!verdict.ok) {
        return rpcError(429, -32000, `Rate limited. Retry in ${verdict.retryAfterSec}s.`, {
          "Retry-After": String(verdict.retryAfterSec),
        });
      }
    }

    // Public and unauthenticated: build tools return unsigned transactions only, and launch mints are derived, not
    // stored, so nothing depends on this instance surviving until the retry.
    const server = createServer({
      ...opts.server,
      transactionTools: HOSTED_TRANSACTION_TOOLS,
      hosted: true,
      signer: undefined,
      launchKeySecret: opts.server?.launchKeySecret ?? "",
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: maxBodyBytes,
    });
    try {
      await server.connect(transport);
      const copy = new Request(req.url, { method: "POST", headers: req.headers, body });
      return withCors(await transport.handleRequest(copy));
    } catch (err) {
      console.error("[highwire] MCP request failed:", err);
      return rpcError(500, -32603, "Internal error");
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  };
}
