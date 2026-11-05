import { createHttpHandler, serverOptionsFromEnv } from "highwire-mcp";

// The hosted MCP endpoint. Stateless: every POST gets a fresh server, so it
// scales out on serverless with nothing to share. It serves every tool; the
// build tools only return unsigned transactions and a sign link, and a launch's
// mint is derived from HIGHWIRE_LAUNCH_SECRET, so retries need no shared state.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const options = serverOptionsFromEnv();
if (!options.launchKeySecret && process.env.NODE_ENV === "production") {
  console.warn("[highwire] HIGHWIRE_LAUNCH_SECRET is not set: launch mints derive from the idempotency key alone.");
}

const handler = createHttpHandler({
  server: options,
  rateLimit: {
    // Units per IP per minute: a build tool call costs 5, anything else 1.
    limit: Number(process.env.HIGHWIRE_RATE_LIMIT) || 60,
    windowMs: 60_000,
  },
});

export { handler as GET, handler as POST, handler as DELETE, handler as OPTIONS };
