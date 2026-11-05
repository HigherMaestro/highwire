import { createHttpHandler, serverOptionsFromEnv } from "highwire-mcp";

// The hosted, read-only MCP endpoint. Stateless: every POST gets a fresh
// server, so it scales out on serverless with nothing to share.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handler = createHttpHandler({
  server: serverOptionsFromEnv(),
  rateLimit: {
    limit: Number(process.env.HIGHWIRE_RATE_LIMIT) || 60,
    windowMs: 60_000,
  },
});

export { handler as GET, handler as POST, handler as DELETE, handler as OPTIONS };
