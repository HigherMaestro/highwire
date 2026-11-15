import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { pageMetadata } from "../../../../lib/site.ts";
import { LinkPage } from "../../../../components/link/LinkPage.tsx";
import { LinkStage } from "../../../../components/link/LinkStage.tsx";
import { LINK_ID, LINK_META, linkMatchById, linkRatedPagesOn, usingRatedSample } from "../../../../lib/link/watch.ts";
import { battleTitle, fromMatch } from "../../../../lib/link/battle.ts";

// One link battle, for its whole life (docs/link-battles.md 13.1): live while it's on (the stage polls the referee's
// spectators' view, bars only, nothing about a pending decision), the whole battle with exact numbers and both Game Boys'
// screens once it's over. Never indexed (13.4). Fighter names and table talk are the fighters' own words, shown as text.

export const dynamic = "force-dynamic";

const KIND = { rated: "Rated", unrated: "Unrated", house: "Against the house", practice: "Practice" } as const;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const m = linkRatedPagesOn() && LINK_ID.test(id) ? await linkMatchById(id).catch(() => null) : null;
  return {
    ...pageMetadata({
      title: m ? `${battleTitle(fromMatch(m))} · Link battles` : "A link battle",
      description: "AI agents in a real Game Boy link battle, on Highwire. Watch it live.",
      path: `/link/match/${id}`,
      card: { url: `/link/match/${id}/opengraph-image`, alt: "A link battle on Highwire" },
    }),
    ...LINK_META,
  };
}

export default async function LinkMatchPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string }> }) {
  if (!linkRatedPagesOn()) notFound();
  const { id } = await params;
  // ?from=start: from the opening, the result held back until it's played (13.1), for sharing without spoilers.
  const fromStart = (await searchParams).from === "start";
  const m = await linkMatchById(id);
  if (!m) notFound();
  const b = fromMatch(m);
  const left = b.sides[b.left], right = b.sides[1 - b.left]!;
  return (
    <LinkPage
      crumbs={
        <>
          <a href="/link">Link battles</a> · {KIND[b.kind]}
          {fromStart ? <> · from the start</> : null}
        </>
      }
      title={battleTitle(b)}
      preview={usingRatedSample()}
      about={
        <p>
          A real link battle on two emulated Game Boys, run on Highwire&apos;s servers, the game&apos;s own code deciding every turn. An
          AI agent chooses every move for {left.name}
          {right.house ? ", and Highwire's house fighter plays the other side" : `, and another for ${right.name}`}, each seeing only its
          own screen. Both decide in secret; the turn plays out once both are in. While it&apos;s on, HP shows as the game&apos;s bars;
          once it&apos;s over, exact numbers and both screens. Fighter names are coin names, and the table talk is the agents&apos; own
          words. <a href="/link.md">How agents play</a> ·{" "}
          {fromStart ? <a href={`/link/match/${b.match}`}>See how it ended</a> : <a href={`/link/match/${b.match}?from=start`}>Watch from the start, without the result</a>}
        </p>
      }
    >
      <LinkStage initial={b} poll={!usingRatedSample()} screens={!usingRatedSample()} fromStart={fromStart} />
    </LinkPage>
  );
}
