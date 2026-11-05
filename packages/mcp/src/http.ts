import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer, type ServerOptions } from "./server.ts";

// Stateless by design: a fresh server and transport per POST, no session IDs,
// JSON responses instead of SSE, and 405 for GET and DELETE. Nothing is shared
// between requests, so it scales out on serverless.

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export interface RateLimit {
  /** Requests allowed per client IP in each window. */
  limit: number;
  windowMs: number;
}

export interface HttpHandlerOptions {
  /** Passed to createServer() for every request. */
  server?: ServerOptions;
  /** Per-IP limit on POSTs. Defaults to 60 a minute; false turns it off. */
  rateLimit?: RateLimit | false;
  /** Picks the client's IP. Defaults to the first X-Forwarded-For entry, then X-Real-IP. */
  clientIp?: (req: Request) => string | undefined;
  /** Largest POST body accepted, in bytes. Defaults to 256 KiB. */
  maxBodyBytes?: number;
}

export const DEFAULT_RATE_LIMIT: RateLimit = { limit: 60, windowMs: 60_000 };

function defaultClientIp(req: Request): string | undefined {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip")?.trim() || undefined;
}

/**
 * A fixed-window counter per IP, held in memory. On serverless hosts each
 * instance keeps its own counts, so treat it as a brake, not a guarantee.
 */
export function createRateLimiter({ limit, windowMs }: RateLimit, now: () => number = Date.now) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return (key: string): { ok: true } | { ok: false; retryAfterSec: number } => {
    const t = now();
    if (windows.size > 10_000) {
      for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
    }
    let w = windows.get(key);
    if (!w || w.resetAt <= t) {
      w = { count: 0, resetAt: t + windowMs };
      windows.set(key, w);
    }
    w.count++;
    if (w.count > limit) return { ok: false, retryAfterSec: Math.ceil((w.resetAt - t) / 1000) };
    return { ok: true };
  };
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
 * A stateless Streamable HTTP endpoint for the read-only server (the transaction tools are never registered on it), as a
 * fetch-style handler: `(Request) => Promise<Response>`. Mount it on one path
 * for every method (Next.js route handlers, Hono, Bun, Deno, workers).
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

    if (limiter) {
      const verdict = limiter(clientIp(req) ?? "unknown");
      if (!verdict.ok) {
        return rpcError(429, -32000, `Rate limited. Retry in ${verdict.retryAfterSec}s.`, {
          "Retry-After": String(verdict.retryAfterSec),
        });
      }
    }

    // Public and unauthenticated: the read tools only, never the transaction tools.
    const server = createServer({ ...opts.server, transactionTools: false });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: maxBodyBytes,
    });
    try {
      await server.connect(transport);
      return withCors(await transport.handleRequest(req));
    } catch (err) {
      console.error("[highwire] MCP request failed:", err);
      return rpcError(500, -32603, "Internal error");
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  };
}
