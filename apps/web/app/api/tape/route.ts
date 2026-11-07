import { readTape } from "../../../lib/tape.ts";

// The homepage's live wire polls this. Cached at the edge for five seconds, so higher.fun sees about one request every
// five seconds however many people are watching.

export const dynamic = "force-dynamic";

export async function GET() {
  const items = await readTape();
  return Response.json(items ? { items } : { items: [], unavailable: true }, {
    status: items ? 200 : 502,
    headers: { "cache-control": items ? "public, s-maxage=5, stale-while-revalidate=25" : "public, s-maxage=5" },
  });
}
