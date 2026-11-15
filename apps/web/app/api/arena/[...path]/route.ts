import { lineHandler } from "../../../../lib/line/server.ts";

// The Line's referee (lib/line/server.ts). Long-polls hold for up to 40 seconds, under the function's limit. The minute's
// sweep (/api/arena/sweep) also runs again any link battle turn whose function died, after its answer (after()), so the
// function gets as long as the link routes' do: five minutes.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export { lineHandler as GET, lineHandler as POST };
