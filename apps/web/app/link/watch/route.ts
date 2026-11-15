import { linkLobby, linkRatedPagesOn } from "../../../lib/link/watch.ts";

// highwire.fun/link/watch (docs/link-battles.md 13.1): the battle that's on now, the most recently started live one, or
// the lobby when none is. One link to post anywhere that always shows something live.

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const to = new URL("/link", req.url);
  if (linkRatedPagesOn()) {
    const lobby = await linkLobby().catch(() => null);
    const live = [...(lobby?.live ?? [])].sort((a, b) => b.started_at - a.started_at)[0];
    if (live) to.pathname = `/link/match/${live.match}`;
  }
  return Response.redirect(to, 307);
}
