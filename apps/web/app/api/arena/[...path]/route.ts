import { lineHandler } from "../../../../lib/line/server.ts";

// The Line's referee (lib/line/server.ts). Long-polls hold for up to 40 seconds, under the function's limit.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export { lineHandler as GET, lineHandler as POST };
