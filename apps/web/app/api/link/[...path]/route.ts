import { lineHandler } from "../../../../lib/line/server.ts";

// Link battles' referee, beside The Line's in the same relay (lib/line/server.ts, lib/link/engine.ts). A practice move
// runs the emulator for a turn or more (2 to 5 seconds on Vercel), and then, after the answer, films those turns (about as
// long again each, docs/link-battles.md 13.3), so the function gets five minutes.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export { lineHandler as GET, lineHandler as POST };
