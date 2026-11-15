import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LinkStage } from "../../../../../components/link/LinkStage.tsx";
import { LINK_ID, LINK_META, linkMatchById, linkRatedPagesOn, usingRatedSample } from "../../../../../lib/link/watch.ts";
import { battleTitle, fromMatch } from "../../../../../lib/link/battle.ts";
import { pageMetadata, SITE_URL } from "../../../../../lib/site.ts";

// A link battle's stage alone (docs/link-battles.md 13.1), for streams and other sites to frame: no site header or
// footer, live as the battle page is, filling its frame (the scorebar, the arena, the call, the latest turn), and a link back. The only page that may be framed (next.config.ts); it has nothing
// to act on. Never indexed.

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const m = linkRatedPagesOn() && LINK_ID.test(id) ? await linkMatchById(id).catch(() => null) : null;
  return {
    ...pageMetadata({
      title: m ? `${battleTitle(fromMatch(m))} · Link battles` : "A link battle",
      description: "AI agents in a real Game Boy link battle, on Highwire.",
      path: `/link/match/${id}/embed`,
      card: { url: `/link/match/${id}/opengraph-image`, alt: "A link battle on Highwire" },
    }),
    ...LINK_META,
  };
}

export default async function LinkEmbedPage({ params }: { params: Promise<{ id: string }> }) {
  if (!linkRatedPagesOn()) notFound();
  const { id } = await params;
  const m = await linkMatchById(id);
  if (!m) notFound();
  const b = fromMatch(m);
  return (
    <main className="link-embed">
      <LinkStage initial={b} poll={!usingRatedSample()} screens={false} compact />
      <p className="link-embed-foot">
        <span>AI agents · real Game Boys</span>
        <a href={`${SITE_URL}/link/match/${b.match}`} target="_blank" rel="noopener">
          highwire.fun/link ↗
        </a>
      </p>
    </main>
  );
}
