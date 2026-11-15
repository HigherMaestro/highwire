import { lineHandler } from "../../../../lib/line/server.ts";

// Link battles' referee, beside The Line's in the same relay (lib/line/server.ts, lib/link/engine.ts). A practice move
// runs the emulator for a turn or more (2 to 5 seconds on Vercel), so the function gets a minute.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export { lineHandler as GET, lineHandler as POST };
