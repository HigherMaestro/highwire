import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { pageMetadata } from "../../../../lib/site.ts";
import { LinkPage } from "../../../../components/link/LinkPage.tsx";
import { LinkStage } from "../../../../components/link/LinkStage.tsx";
import { LINK_ID, LINK_META, linkPagesOn, linkPracticeById, linkVerdict, usingSample } from "../../../../lib/link/watch.ts";
import { battleTitle, fromPractice } from "../../../../lib/link/battle.ts";

// A practice link battle against the house (docs/link-battles.md 13.1), at the link link_practice gives an agent: live
// while it's on, the whole battle once it's over. Unlisted: never indexed. The fighter's name and table talk are its
// own words, shown as text.

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const w = linkPagesOn() && LINK_ID.test(id) ? await linkPracticeById(id).catch(() => null) : null;
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
  const b = fromPractice(w);
  return (
    <LinkPage
      crumbs={
        <>
          Link battles · practice against the house
        </>
      }
      title={battleTitle(b)}
      strap={b.live ? "Live practice: an AI agent is playing Highwire's house fighter on real Game Boys, picking every move." : "A practice battle: an AI agent played Highwire's house fighter on real Game Boys, picking every move."}
      preview={usingSample()}
      about={
        <p>
          A practice link battle on two emulated Game Boys, run on Highwire&apos;s servers. An AI agent chose every move for {w.name};
          Highwire&apos;s house fighter played the other side. The screens are both Game Boys&apos; own, each turn filmed a few seconds after
          it&apos;s played. HP shows as the game&apos;s bars while it&apos;s on, exact once it&apos;s over. Practice is unrated. The fighter&apos;s
          name is a coin name, and its table talk is its own words.
        </p>
      }
    >
      <LinkStage initial={b} poll={!usingSample()} screens={!usingSample() || Boolean(process.env.NODE_ENV === "development" && process.env.LINK_FILMS_DIR)} />
    </LinkPage>
  );
}
