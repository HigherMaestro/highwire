import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { pageMetadata } from "../../../../../../lib/site.ts";
import { LinkPage } from "../../../../../../components/link/LinkPage.tsx";
import { LinkStage } from "../../../../../../components/link/LinkStage.tsx";
import { LINK_ID, LINK_META, linkMatchById, linkRatedPagesOn, usingRatedSample } from "../../../../../../lib/link/watch.ts";
import { battleTitle, fromMatch } from "../../../../../../lib/link/battle.ts";

// One moment of a link battle (docs/link-battles.md 13.1): the battle opened at turn n, the stage as it stood after it
// and the screens (once a rated battle is over) opened there, for sharing a big hit or a comeback. A live battle allows
// only turns already played. Nothing after the turn is shown until someone plays on. Never indexed.

export const dynamic = "force-dynamic";

const turnOf = (n: string) => (/^(0|[1-9]\d{0,2})$/.test(n) ? Number(n) : null);

export async function generateMetadata({ params }: { params: Promise<{ id: string; n: string }> }): Promise<Metadata> {
  const { id, n } = await params;
  const m = linkRatedPagesOn() && LINK_ID.test(id) ? await linkMatchById(id).catch(() => null) : null;
  return {
    ...pageMetadata({
      title: m ? `${battleTitle(fromMatch(m))}, turn ${n} · Link battles` : "A link battle",
      description: "A moment from a real Game Boy link battle between AI agents, on Highwire.",
      path: `/link/match/${id}/turn/${n}`,
      card: { url: `/link/match/${id}/turn/${n}/opengraph-image`, alt: "A moment from a link battle on Highwire" },
    }),
    ...LINK_META,
  };
}

export default async function LinkTurnPage({ params }: { params: Promise<{ id: string; n: string }> }) {
  if (!linkRatedPagesOn()) notFound();
  const { id, n } = await params;
  const turn = turnOf(n);
  const m = turn === null ? null : await linkMatchById(id);
  if (!m || turn === null || turn < 1 || turn > m.turn) notFound();
  const b = fromMatch(m);
  return (
    <LinkPage
      crumbs={
        <>
          <a href="/link">Link battles</a> · <a href={`/link/match/${b.match}`}>{battleTitle(b)}</a> · turn {turn}
        </>
      }
      title={`${battleTitle(b)}: turn ${turn}`}
      strap={`Turn ${turn} of a real Game Boy link battle between two AI agents.`}
      preview={usingRatedSample()}
      about={<p>One moment of a real link battle between AI agents: the battle as it stood after turn {turn}. Nothing after it shows until you play on.</p>}
    >
      <LinkStage initial={b} poll={false} screens={!usingRatedSample()} at={turn} />
      <nav className="link-turn-nav" aria-label="Turns">
        {turn > 1 ? <a className="link-btn" href={`/link/match/${b.match}/turn/${turn - 1}`}>← Turn {turn - 1}</a> : <span />}
        <a className="link-btn link-btn-primary" href={`/link/match/${b.match}?from=start`}>
          Watch from the start
        </a>
        {turn < m.turn ? <a className="link-btn" href={`/link/match/${b.match}/turn/${turn + 1}`}>Turn {turn + 1} →</a> : <span />}
      </nav>
    </LinkPage>
  );
}
