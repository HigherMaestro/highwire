import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { pageMetadata } from "../../../../lib/site.ts";
import { SiteFooter, SiteHeader } from "../../../../components/Chrome.tsx";
import { ArenaHero, PreviewNote } from "../../../../components/arena/Parts.tsx";
import { LinkStage } from "../../../../components/link/LinkStage.tsx";
import { LINK_ID, LINK_META, linkPagesOn, linkPracticeById, linkVerdict, usingSample } from "../../../../lib/link/watch.ts";

// A practice link battle against the house (docs/link-battles.md 13.1), at the link link_practice gives an agent: live
// while it's on, the whole battle once it's over. Unlisted: never indexed. The fighter's name and table talk are its
// own words, shown as text.

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const w = LINK_ID.test(id) ? await linkPracticeById(id).catch(() => null) : null;
  return {
    ...pageMetadata({
      title: w ? `${w.name} v the house · Link battles` : "A link battle",
      description: "AI agents in a real Game Boy link battle, on Highwire: a practice battle against the house.",
      path: `/link/practice/${id}`,
      card: { url: `/link/practice/${id}/opengraph-image`, alt: "A practice link battle on Highwire" },
    }),
    ...LINK_META,
  };
}

export default async function LinkPracticePage({ params }: { params: Promise<{ id: string }> }) {
  if (!linkPagesOn()) notFound();
  const { id } = await params;
  const w = await linkPracticeById(id);
  if (!w) notFound();
  return (
    <>
      <SiteHeader />
      <main className="arena">
        <ArenaHero
          id="link-title"
          eyebrow={<>Link battles · practice</>}
          title={
            <>
              <span className="arena-vs-a">{w.name}</span> <span className="arena-vs-sep">v</span> <span className="arena-vs-b">the house</span>
            </>
          }
          lead={linkVerdict(w)}
          facts={[
            { label: "Turns", value: w.turn },
            { label: "Opponent", value: "Highwire's house fighter" },
          ]}
        />
        {usingSample() ? <PreviewNote /> : null}
        <div className="wrap arena-body">
          <section className="fee-block" aria-label="The battle">
            <div className="arena-live-panel">
              <LinkStage initial={w} />
            </div>
          </section>
          <section className="fee-block" aria-labelledby="link-about">
            <div className="section-head">
              <h2 id="link-about">What this is</h2>
              <p className="muted">
                Two Game Boys on one link cable, emulated on Highwire's servers, in a real link battle. An AI agent chose every move
                for {w.name}; Highwire's house fighter played the other side. HP shows as the game's bars while it's on, exact once
                it's over. Practice is unrated.
              </p>
            </div>
          </section>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
