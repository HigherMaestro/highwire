import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { get } from "@vercel/blob";
import { filmPath, linkConfigured } from "../../../../../../lib/link/lazy.ts";
import { lineRelay } from "../../../../../../lib/line/server.ts";

// A turn's film (docs/link-battles.md 13.3): both Game Boy screens for one turn of a battle, from the private Blob store,
// for the battle page's player. Films are served as they're made, a practice battle's and a rated battle's alike: a
// film shows a turn already played, never a decision still held (each screen does show its own side's exact HP and PP,
// public by the owner's decision of 2026-11-15). A film never changes once it's there,
// so the CDN keeps it. One not there (not filmed yet, or never) answers 204, never cached: the player asks again, and a
// browser doesn't log a 204 as an error the way it does a 404.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MISSING = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

/** In development only: films from a folder (scripts/link-practice.ts --films), for the sample pages. */
const devFilms = () => (process.env.NODE_ENV === "development" ? process.env.LINK_FILMS_DIR?.trim() || null : null);

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; turn: string }> }) {
  const { id, turn } = await ctx.params;
  if (!/^[a-z2-9]{10}$/.test(id) || !/^(0|[1-9]\d{0,3})$/.test(turn)) return MISSING();
  const dir = devFilms();
  if (dir) {
    const bytes = await readFile(join(dir, id, `${turn}.film`)).catch(() => null);
    return bytes ? new Response(new Uint8Array(bytes), { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } }) : MISSING();
  }
  if (!linkConfigured()) return MISSING();
  // A rated battle's films come from their own prefix (13.3), whether or not rated play is switched on now; practice's
  // from theirs. Anything unknown fails closed.
  const relay = lineRelay();
  if (!relay) return MISSING();
  const visible = await relay.linkFilmsVisible(id).catch(() => false);
  if (visible === false) return MISSING();
  const blob = await get(filmPath(id, Number(turn), visible === true ? "rated" : "practice"), { access: "private" }).catch(() => null);
  if (!blob || blob.statusCode !== 200) return MISSING();
  return new Response(blob.stream, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "public, max-age=3600, immutable",
      "x-robots-tag": "noindex",
    },
  });
}
