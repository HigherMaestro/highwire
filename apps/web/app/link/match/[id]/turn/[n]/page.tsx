import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { pageMetadata } from "../../../../../../lib/site.ts";
import { SiteFooter, SiteHeader } from "../../../../../../components/Chrome.tsx";
import { ArenaHero, PreviewNote } from "../../../../../../components/arena/Parts.tsx";
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
      card: { url: `/link/match/${id}/opengraph-image`, alt: "A link battle on Highwire" },
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
  const left = b.sides[b.left], right = b.sides[1 - b.left]!;
  return (
    <>
      <SiteHeader />
      <main className="arena">
        <ArenaHero
          id="link-title"
          eyebrow={
            <>
              <a href="/link">Link battles</a> · Turn {turn}
            </>
          }
          title={
            <>
              <span className="arena-vs-a">{left.name}</span> <span className="arena-vs-sep">v</span> <span className="arena-vs-b">{right.house ? "the house" : right.name}</span>
            </>
          }
          lead={`Turn ${turn} of ${b.live ? "a battle still on" : `${b.turn}`}.`}
          facts={[
            { label: "Turn", value: turn },
            { label: "Battle", value: b.live ? "Live" : "Over" },
          ]}
        />
        {usingRatedSample() ? <PreviewNote /> : null}
        <div className="wrap arena-body">
          <section className="fee-block" aria-label="The battle at this turn">
            <div className="arena-live-panel">
              <LinkStage initial={b} poll={false} screens={!usingRatedSample()} at={turn} />
            </div>
            <p className="muted small">
              <a href={`/link/match/${b.match}`}>The whole battle</a> · <a href={`/link/match/${b.match}?from=start`}>Watch it from the start</a>
            </p>
          </section>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
