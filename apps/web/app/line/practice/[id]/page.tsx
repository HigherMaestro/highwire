import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { seriesAddress, wagerProgram } from "highwire-core";
import { pageMetadata } from "../../../../lib/site.ts";
import { SiteFooter, SiteHeader } from "../../../../components/Chrome.tsx";
import { ArenaHero } from "../../../../components/arena/Parts.tsx";
import { PracticeCheck } from "../../../../components/arena/PracticeCheck.tsx";
import { when } from "../../../../lib/arena/data.ts";
import { explorer, PRACTICE_META, practiceHistory, practiceOn, shortWallet } from "../../../../lib/practice/data.ts";
import { replaySeries } from "../../../../lib/practice/replay.ts";

// One practice series, replayed from its on-chain moves (docs/wager-mode.md 7.5): every match round by round, and the
// check, run again in the browser. No stakes shown (9.3): they're on-chain, and the explorer link says so.

export const dynamic = "force-dynamic";
// The first read of a long series can take a while on devnet; inTime gives up at 45 s, inside this.
export const maxDuration = 60;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { ...pageMetadata({ title: "A practice series · The Line", description: "A best-of-five practice series on devnet, move by move.", path: `/line/practice/${id}` }), ...PRACTICE_META };
}

const REASON: Record<string, string> = {
  reached_end: "reached the end",
  rounds_up: "ahead after 15 rounds",
  tie_break: "on the tie-break",
  draw: "level after 15 rounds",
  missed_reveal: "the other side didn't reveal",
  void: "neither side revealed",
};

function Unavailable() {
  return (
    <>
      <SiteHeader />
      <main className="arena">
        <ArenaHero id="series-title" eyebrow={<><a href="/line">The Line</a> · <a href="/line/practice">practice</a></>} title="A practice series" lead="Devnet didn't answer in time, so this series can't be replayed just now. Try again in a minute." />
      </main>
      <SiteFooter />
    </>
  );
}

export default async function PracticeSeriesPage({ params }: { params: Promise<{ id: string }> }) {
  if (!practiceOn()) notFound();
  const { id } = await params;
  const found = await practiceHistory(id).catch((err: unknown) => {
    console.error(`practice: devnet history unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return "unavailable" as const;
  });
  if (found === "unavailable") return <Unavailable />;
  if (!found) notFound();
  const { summary, names, history } = found;
  const name = (p: "A" | "B") => names?.[p].name ?? shortWallet(p === "A" ? summary.playerA : summary.playerB);
  const r = replaySeries(history);
  const wins = (p: "A" | "B") => r.matches.filter((m) => m.result?.winner === p).length;
  const o = summary.closed?.outcome;
  const lead = !summary.acceptedAt
    ? o?.how === "cancelled"
      ? "Never accepted, so it was called off and the opener's stake went back."
      : "Waiting for the second side to accept."
    : o?.how === "settled"
      ? `${o.winner ? `${name(o.winner)} won` : "Drawn"}, ${wins("A")}–${wins("B")}`
      : o?.how === "refunded"
        ? "Refunded: both stakes went back."
        : o?.how === "unread"
          ? `Closed, ${wins("A")}–${wins("B")} as replayed (the program's announcement of how couldn't be read)`
          : `Under way: ${wins("A")}–${wins("B")}`;
  const program = wagerProgram("devnet");

  return (
    <>
      <SiteHeader />
      <main className="arena">
        <ArenaHero
          id="series-title"
          eyebrow={
            <>
              <a href="/line">The Line</a> · <a href="/line/practice">practice</a>
            </>
          }
          title={
            <>
              <span className="arena-vs-a">{name("A")}</span> <span className="arena-vs-sep">v</span> <span className="arena-vs-b">{name("B")}</span>
            </>
          }
          lead={lead}
          facts={[
            { label: "Matches", value: r.matches.length },
            { label: "Moves", value: r.commits },
            { label: "Opened", value: when(summary.openedAt * 1000) },
          ]}
        />
        <div className="arena-preview" role="note">
          <div className="wrap">
            <strong>Practice.</strong> Devnet only: no real money, nothing of value won or lost.
          </div>
        </div>
        <div className="wrap arena-body">
          <section className="fee-block" aria-labelledby="check-title">
            <div className="section-head">
              <h2 id="check-title">Checked move by move</h2>
              <p className="muted">
                Each round both sides commit to a hidden pull on-chain (a SHA-256 hash of the series, match, round, side, pull and a
                random nonce), then reveal it. This page reads every one of those transactions from devnet and replays them under
                the rules, in your browser.
              </p>
            </div>
            <PracticeCheck history={history} />
          </section>

          {r.matches.map((m) => (
            <section key={m.match} className="fee-block" aria-labelledby={`match-${m.match}`}>
              <div className="section-head">
                <h2 id={`match-${m.match}`}>Match {m.match}</h2>
                <p className="muted">
                  {m.result
                    ? m.result.winner
                      ? `${name(m.result.winner)} won: ${REASON[m.result.reason] ?? m.result.reason}.`
                      : `No winner: ${REASON[m.result.reason] ?? m.result.reason}.`
                    : "In play."}{" "}
                  A pull marked * is a fallback: that side didn&apos;t commit in time.
                </p>
              </div>
              {m.rounds.length ? (
                <div className="table-wrap arena-table-wrap">
                  <table className="arena-table arena-rounds">
                    <caption className="sr-only">Match {m.match}, every round</caption>
                    <thead>
                      <tr>
                        <th scope="col">Round</th>
                        <th scope="col" className="arena-col-a">{name("A")}</th>
                        <th scope="col" className="arena-col-b">{name("B")}</th>
                        <th scope="col">Node</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.rounds.map((x) => (
                        <tr key={x.round} className={x.winner ? `won-${x.winner === "A" ? "a" : "b"}` : "won-none"}>
                          <th scope="row">{x.round}</th>
                          {(["A", "B"] as const).map((p) => (
                            <td key={p} className={x.winner === p ? "is-winner" : ""}>
                              <strong>
                                {x.pull[p]}
                                {x.fallback[p] ? "*" : ""}
                              </strong>
                            </td>
                          ))}
                          <td className="muted small">{x.node === 0 ? "middle" : `${Math.abs(x.node)} toward ${name(x.node > 0 ? "A" : "B")}`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted small">No rounds played.</p>
              )}
            </section>
          ))}

          <section className="fee-block" aria-labelledby="chain-title">
            <div className="section-head">
              <h2 id="chain-title">On the chain</h2>
              <p className="muted">
                The stakes, the moves and the payout are all public on devnet.{" "}
                {program ? (
                  <a href={explorer(seriesAddress(program, id).toBase58())} rel="noopener noreferrer" target="_blank">
                    The series account on the explorer
                  </a>
                ) : null}
                {program ? "." : ""}
              </p>
            </div>
          </section>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
