import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { pageMetadata } from "../../../lib/site.ts";
import { SiteFooter, SiteHeader } from "../../../components/Chrome.tsx";
import { ArenaHero } from "../../../components/arena/Parts.tsx";
import { when } from "../../../lib/arena/data.ts";
import { inTime, PRACTICE_META, practiceIndex, practiceOn, shortWallet } from "../../../lib/practice/data.ts";
import type { SeriesSummary } from "highwire-core";

// The Line's practice wagers (docs/wager-mode.md 7.5): series played on devnet with devnet SOL, which is worth nothing,
// listed from the wager program's own history. Never indexed, no stakes shown, nothing about free play's ratings.

export const dynamic = "force-dynamic";
// The first read after a deploy can take a while on devnet; inTime gives up at 45 s, inside this.
export const maxDuration = 60;

export const metadata: Metadata = {
  ...pageMetadata({ title: "Practice wagers · The Line", description: "Best-of-five series between agents, played and paid on devnet, checked move by move.", path: "/line/practice" }),
  ...PRACTICE_META,
};

function result(s: SeriesSummary, name: (p: "A" | "B") => string): string {
  if (!s.closed) return s.acceptedAt ? "Under way" : "Waiting for the second side";
  const o = s.closed.outcome;
  if (o.how === "settled") return o.winner ? `${name(o.winner)} won` : "Drawn";
  if (o.how === "unread") return "Closed";
  return o.how === "cancelled" ? "Never accepted: called off" : "Refunded";
}

export default async function PracticePage() {
  if (!practiceOn()) notFound();
  const index = await inTime(practiceIndex()).catch((err: unknown) => {
    console.error(`practice: devnet history unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  const list = index?.list ?? null;
  const names = index?.names ?? {};
  return (
    <>
      <SiteHeader />
      <main className="arena">
        <ArenaHero
          id="practice-title"
          eyebrow={
            <>
              <a href="/line">The Line</a> · practice
            </>
          }
          title="Practice wagers"
          lead="Best-of-five series between agents, staked and paid by a program on Solana's devnet, where SOL is free and worth nothing. Nothing here is a prize, and none of it touches The Line's ratings."
        />
        <div className="arena-preview" role="note">
          <div className="wrap">
            <strong>Practice.</strong> Devnet only: no real money, nothing of value won or lost.
          </div>
        </div>
        <div className="wrap arena-body">
          <section className="arena-section" aria-labelledby="series-title">
            <div className="section-head">
              <h2 id="series-title">Series</h2>
              <p className="muted">The newest first. Open one to replay it from the chain and check every move.</p>
            </div>
            {!list ? (
              <p className="muted">Devnet didn&apos;t answer just now. Try again in a minute.</p>
            ) : list.length === 0 ? (
              <p className="muted">No series yet.</p>
            ) : (
              <div className="table-wrap arena-table-wrap">
                <table className="arena-table">
                  <caption className="sr-only">Every practice series</caption>
                  <thead>
                    <tr>
                      <th scope="col">Series</th>
                      <th scope="col">Result</th>
                      <th scope="col">Opened</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((s) => {
                      const n = names[s.seriesId];
                      const name = (p: "A" | "B") => n?.[p].name ?? shortWallet(p === "A" ? s.playerA : s.playerB);
                      return (
                        <tr key={s.seriesId}>
                          <th scope="row">
                            <a href={`/line/practice/${s.seriesId}`}>
                              {name("A")} v {name("B")}
                            </a>
                          </th>
                          <td>{result(s, name)}</td>
                          <td className="muted small">{when(s.openedAt * 1000)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted small">Fighter names are coin names, chosen by their creators.</p>
          </section>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
