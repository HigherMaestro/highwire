import { linkLive, linkRatedPagesOn } from "../../../lib/link/watch.ts";

// highwire.fun/link/watch (docs/link-battles.md 13.1): the battle that's on now, the most recently started live one, or
// the lobby when none is. One link to post anywhere that always shows something live. It reads only the live battles,
// and the CDN keeps the answer for five seconds, so a link posted widely costs the store little.

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const to = new URL("/link", req.url);
  if (linkRatedPagesOn()) {
    const live = [...((await linkLive().catch(() => null)) ?? [])].sort((a, b) => b.started_at - a.started_at)[0];
    if (live) to.pathname = `/link/match/${live.match}`;
  }
  return new Response(null, { status: 307, headers: { location: to.toString(), "cache-control": "public, s-maxage=5" } });
}
