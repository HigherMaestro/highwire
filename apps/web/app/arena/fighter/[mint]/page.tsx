import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { pageMetadata } from "../../../../lib/site.ts";
import { SiteFooter, SiteHeader } from "../../../../components/Chrome.tsx";
import { ArenaDisclaimer, ArenaHero, MatchList, PreviewNote, StripKey } from "../../../../components/arena/Parts.tsx";
import { agentRecord, ARENA_META, arenaPagesOn, fighterById, matchesFor, reliability, resultFor, sideOf, SAMPLE, when } from "../../../../lib/arena/data.ts";

export const metadata: Metadata = {
  ...pageMetadata({ title: "Arena fighter (preview)", description: "An arena fighter's record and matches.", path: "/arena" }),
  ...ARENA_META,
};

export async function generateStaticParams() {
  return [];
}

export default async function FighterPage({ params }: { params: Promise<{ mint: string }> }) {
  if (!arenaPagesOn()) notFound();
  const { mint } = await params;
  const f = fighterById(mint);
  if (!f) notFound();
  const rel = reliability(f.id);
  const matches = matchesFor(f.id);
  const results = matches.map((m) => resultFor(m, sideOf(m, f.id)));
  const won = results.filter((r) => r === "win").length;
  const drawn = results.filter((r) => r === "draw").length;
  const vsAgents = agentRecord(f.id);
  const coinLink = !SAMPLE && f.listed;

  return (
    <>
      <SiteHeader />
      <main className="arena">
        <ArenaHero
          id="fighter-title"
          eyebrow={
            <>
              <a href="/arena">Arena</a> · fighter
            </>
          }
          title={f.name}
          lead={
            <>
              Played {matches.length} · won {won}
              {drawn ? ` · drew ${drawn}` : ""}
              {matches[0] ? ` · last played ${when(matches[0].endedAt)}` : ""}
            </>
          }
          facts={[
            { label: "Against agents", value: `${vsAgents.win} won, ${vsAgents.loss} lost${vsAgents.draw ? `, ${vsAgents.draw} drawn` : ""}` },
            { label: "Against the house", value: `${f.record.house.win} won, ${f.record.house.loss} lost${f.record.house.draw ? `, ${f.record.house.draw} drawn` : ""}` },
            { label: "Showed up", value: rel === null ? "–" : `${Math.round(rel * 100)}% of rounds` },
            { label: "Rating", value: f.provisional ? "still settling" : f.rating },
          ]}
        >
          <p className="muted small arena-hero-note">
            The name is the coin&apos;s, chosen by its creator (${f.ticker}). A record says nothing about the coin.
          </p>
        </ArenaHero>
        <PreviewNote />
        <div className="wrap arena-body">
          <section id="matches" className="arena-section" aria-labelledby="matches-title">
            <div className="section-head">
              <h2 id="matches-title">Matches</h2>
              <StripKey fighter={f.name} />
            </div>
            <MatchList matches={matches} fighter={f.id} />
          </section>
          {coinLink ? (
            <section id="coin" className="arena-section" aria-labelledby="coin-title">
              <div className="section-head">
                <h2 id="coin-title">The coin</h2>
                <p className="muted">
                  Shown because the coin passes Highwire&apos;s risk check and its creator still holds some, never because of results.
                </p>
              </div>
            </section>
          ) : null}
        </div>
        <ArenaDisclaimer />
      </main>
      <SiteFooter />
    </>
  );
}
