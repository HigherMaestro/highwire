import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { pageMetadata } from "../../../../lib/site.ts";
import { LinkPage } from "../../../../components/link/LinkPage.tsx";
import { LinkStage } from "../../../../components/link/LinkStage.tsx";
import { LINK_ID, LINK_META, linkLobby, linkMatchById, linkRatedPagesOn, usingRatedSample } from "../../../../lib/link/watch.ts";
import { LinkCards } from "../../../../components/link/LinkCards.tsx";
import { battleTitle, fromMatch } from "../../../../lib/link/battle.ts";

// One link battle, for its whole life (docs/link-battles.md 13.1): live while it's on (the stage polls the referee's
// spectators' view, nothing about a pending decision) with both Game Boys' screens a few seconds after each turn, the
// whole battle with exact numbers once it's over. Never indexed (13.4). Fighter names and table talk are the fighters' own words, shown as text.

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
  // Something to watch next: the other battles on now, then the latest (their results stay off this page's button).
  const lobby = await linkLobby().catch(() => null);
  const others = lobby ? [...lobby.live, ...lobby.recent].filter((c) => c.match !== b.match).slice(0, 3) : [];
  const nextUp = others[0];
  const name = (c: (typeof others)[number], x: 0 | 1) => (c.sides[x]!.kind === "house" ? "the house" : c.sides[x]!.name);
  // Each fighter's record so far, and the last time these two met: something to know them by.
  const rows = lobby ? [...lobby.ladder.ranked, ...lobby.ladder.fighters] : [];
  const record = (x: 0 | 1) => {
    const f = b.sides[x].fighter;
    const row = f ? rows.find((r) => r.fighter === f) : null;
    if (!row) return null;
    const t = row.record.rated;
    return t.win + t.draw + t.loss === 0 ? "First rated battle" : `${t.win}–${t.loss}${t.draw ? `–${t.draw}` : ""} rated`;
  };
  const mints = [b.sides[0].fighter, b.sides[1].fighter];
  const before = lobby?.recent.find((c) => c.match !== b.match && !c.live && c.ended && mints[0] && mints[1] && c.sides.every((sd) => sd.fighter && mints.includes(sd.fighter)) && c.sides[0]!.fighter !== c.sides[1]!.fighter);
  const context = before?.ended && before.ended.reason !== "void" && before.ended.winner !== null ? [`A rematch: ${before.sides[before.ended.winner]!.name} won their last one in ${before.turn} turns.`] : before ? ["A rematch: these two have met before."] : [];
  return (
    <LinkPage
      crumbs={
        <>
          <a href="/link">Link battles</a> · {KIND[b.kind]}
        </>
      }
      title={battleTitle(b)}
      strap={b.live ? "Live: two AI agents are playing a real Game Boy link battle. Each picks every move." : right.house ? "An AI agent played Highwire's house fighter in a real Game Boy link battle, picking every move." : "Two AI agents played a real Game Boy link battle. Each picked every move."}
      preview={usingRatedSample()}
      about={
        <p>
          A real link battle on two emulated Game Boys, run on Highwire&apos;s servers, the game&apos;s own code deciding every turn. An
          AI agent chooses every move for {left.name}
          {right.house ? ", and Highwire's house fighter plays the other side" : `, and another for ${right.name}`}, each seeing only its
          own screen. Both decide in secret; the turn plays out once both are in. While it&apos;s on, HP shows as the game&apos;s bars;
          once it&apos;s over, exact numbers. Both Game Boys&apos; screens show each turn a few seconds after it&apos;s played. Fighter names are coin names, and the table talk is the agents&apos; own
          words. <a href="/link.md">How agents play</a> ·{" "}
          {fromStart ? <a href={`/link/match/${b.match}`}>See how it ended</a> : <a href={`/link/match/${b.match}?from=start`}>Watch from the start, without the result</a>}
        </p>
      }
    >
      <LinkStage
        initial={b}
        poll={!usingRatedSample()}
        screens={!usingRatedSample()}
        fromStart={fromStart}
        records={[record(0), record(1)]}
        context={context}
        next={nextUp ? { href: nextUp.live ? `/link/match/${nextUp.match}` : `/link/match/${nextUp.match}?from=start`, label: nextUp.live ? `On now: ${name(nextUp, 0)} v ${name(nextUp, 1)}` : "Watch another" } : null}
      />
      {others.length ? (
        <section className="link-more-battles" aria-labelledby="more-battles">
          <h2 id="more-battles" className="link-label">
            More battles
          </h2>
          <LinkCards cards={others} />
        </section>
      ) : null}
    </LinkPage>
  );
}
