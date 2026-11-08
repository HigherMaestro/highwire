import type { Metadata } from "next";
import { coinUrl } from "highwire-core";
import { notFound } from "next/navigation";
import { pageMetadata } from "../../../../lib/site.ts";
import { SiteFooter, SiteHeader } from "../../../../components/Chrome.tsx";
import { ArenaHero, MatchList, PreviewNote, StripKey } from "../../../../components/arena/Parts.tsx";
import { agentRecord, ARENA_META, arenaPagesOn, fighterById, matchesFor, reliability, resultFor, sideOf, when } from "../../../../lib/arena/data.ts";
import { lineConfigured } from "../../../../lib/line/server.ts";

export const revalidate = 30;

export async function generateMetadata({ params }: { params: Promise<{ mint: string }> }): Promise<Metadata> {
  const { mint } = await params;
  return {
    ...pageMetadata({ title: "A fighter on The Line", description: "A fighter's record and matches on The Line.", path: `/line/fighter/${mint}` }),
    ...(lineConfigured() ? {} : ARENA_META),
  };
}

export async function generateStaticParams() {
  return [];
}

export default async function FighterPage({ params }: { params: Promise<{ mint: string }> }) {
  if (!arenaPagesOn()) notFound();
  const { mint } = await params;
  const f = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) ? await fighterById(mint) : null;
  if (!f) notFound();
  const matches = await matchesFor(f.id);
  const rel = reliability(f.id, matches);
  const sample = !lineConfigured();
  const results = matches.map((m) => resultFor(m, sideOf(m, f.id)));
  const won = results.filter((r) => r === "win").length;
  const drawn = results.filter((r) => r === "draw").length;
  const vsAgents = sample ? agentRecord(f.id, matches) : f.record.rated;
  const coinLink = !sample && f.listed;

  return (
    <>
      <SiteHeader />
      <main className="arena">
        <ArenaHero
          id="fighter-title"
          eyebrow={
            <>
              <a href="/line">The Line</a> · fighter
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
        {sample ? <PreviewNote /> : null}
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
                  <a href={coinUrl(f.id)} rel="nofollow noopener noreferrer">
                    ${f.ticker} on higher.fun ↗
                  </a>{" "}
                  · shown because it passes Highwire&apos;s risk check and its creator still holds some, never because of results.
                  Not a reason to buy it.
                </p>
              </div>
            </section>
          ) : null}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
