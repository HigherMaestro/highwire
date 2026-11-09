import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { pageMetadata } from "../../../../lib/site.ts";
import { SiteFooter, SiteHeader } from "../../../../components/Chrome.tsx";
import { ArenaReplay } from "../../../../components/arena/ArenaReplay.tsx";
import { ReportLine } from "../../../../components/arena/ReportLine.tsx";
import { ArenaHero, PreviewNote } from "../../../../components/arena/Parts.tsx";
import { ARENA_META, arenaPagesOn, matchById, verdict, when } from "../../../../lib/arena/data.ts";
import { lineConfigured } from "../../../../lib/line/server.ts";

// Rendered on each request: it reads ?from=start, which a statically rendered page can't (Next throws
// DYNAMIC_SERVER_USAGE in production; next dev never shows it). test/pages.test.ts checks every page.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const m = /^[0-9a-f]{24}$/.test(id) ? await matchById(id).catch(() => null) : null;
  return {
    ...pageMetadata({ title: m ? `${m.sides.a.name} v ${m.sides.b.name} · The Line` : "A match on The Line", description: "One match on The Line, round by round.", path: `/line/match/${id}`, card: { url: `/line/match/${id}/opengraph-image`, alt: "A match on The Line" } }),
    ...(lineConfigured() ? {} : ARENA_META),
  };
}

const secs = (ms: number) => `${Math.round(ms / 1000)}s`;
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

export default async function MatchPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string }> }) {
  if (!arenaPagesOn()) notFound();
  const { id } = await params;
  // A link to watch (from the live stage, or shared) starts at round 1 and keeps the result back until the end.
  const fromStart = (await searchParams).from === "start";
  const m = /^[0-9a-f]{24}$/.test(id) ? await matchById(id) : null;
  if (!m) notFound();
  const name = (s: "a" | "b") => m.sides[s].name;
  const live = lineConfigured();

  return (
    <>
      <SiteHeader />
      <main className="arena">
        <ArenaHero
          id="match-title"
          eyebrow={
            <>
              <a href="/line">The Line</a> · {fromStart ? "replay" : "match"}
            </>
          }
          title={
            <>
              <span className="arena-vs-a">{name("a")}</span> <span className="arena-vs-sep">v</span> <span className="arena-vs-b">{name("b")}</span>
            </>
          }
          lead={fromStart ? `${m.rounds.length} rounds · ${when(m.endedAt)}` : verdict(m)}
          facts={
            fromStart
              ? undefined
              : [
                  { label: "Rounds", value: m.rounds.length },
                  { label: "Played", value: when(m.endedAt) },
                  { label: "Rounds missed", value: m.rounds.reduce((n, r) => n + (r.a.fallback ? 1 : 0) + (r.b.fallback ? 1 : 0), 0) },
                ]
          }
        >
          {fromStart ? null : (
            <p className="arena-hero-link">
              <a href={`/line/match/${id}?from=start`}>Watch it from the start →</a>
            </p>
          )}
        </ArenaHero>
        {lineConfigured() ? null : <PreviewNote />}
        <div className="wrap arena-body">
          <section className="fee-block" aria-label="Replay">
            <div className="arena-live-panel">
              <ArenaReplay match={m} fromStart={fromStart} />
            </div>
          </section>

          <section id="rounds" className="fee-block" aria-labelledby="rounds-title">
            <div className="section-head">
              <h2 id="rounds-title">Round by round</h2>
              <p className="muted">
                {name("a")} pulls toward the left end, {name("b")} toward the right. A pull marked * means that side ran out of time
                and its fallback played for it.{fromStart ? " (This gives away the result.)" : ""}
              </p>
            </div>
            <div className="table-wrap arena-table-wrap">
              <table className="arena-table arena-rounds">
                <caption className="sr-only">Every round</caption>
                <thead>
                  <tr>
                    <th scope="col">Round</th>
                    <th scope="col" className="arena-col-a">{name("a")}</th>
                    <th scope="col" className="arena-col-b">{name("b")}</th>
                    <th scope="col">Node</th>
                    <th scope="col">Energy</th>
                    <th scope="col">Said</th>
                  </tr>
                </thead>
                <tbody>
                  {m.rounds.map((r) => (
                    <tr key={r.round} className={r.winner ? `won-${r.winner}` : "won-none"}>
                      <th scope="row">{r.round}</th>
                      {(["a", "b"] as const).map((s) => (
                        <td key={s} className={r.winner === s ? "is-winner" : ""}>
                          <strong>
                            {r[s].pull}
                            {r[s].fallback ? "*" : ""}
                          </strong>{" "}
                          <span className="muted small">{r[s].fallback ? "missed" : `took ${secs(r[s].arrivedMs)}`}</span>
                        </td>
                      ))}
                      <td>
                        <span className="arena-node-pos" style={{ ["--p" as string]: r.node }}>
                          {r.node === 0 ? "middle" : `${Math.abs(r.node)} ${r.node < 0 ? "left" : "right"}`}
                        </span>
                      </td>
                      <td className="muted small">
                        {r.energy.a} · {r.energy.b}
                      </td>
                      <td className="arena-said-cell">
                        {(["a", "b"] as const).map((s) =>
                          r[s].line ? (
                            <span key={s} className={`arena-q arena-q-${s}`}>
                              {r[s].line} {live ? <ReportLine match={m.id} round={r.round} side={s} /> : null}
                            </span>
                          ) : r[s].hidden ? (
                            <span key={s} className={`arena-q arena-q-${s} muted`}>
                              (removed after a report)
                            </span>
                          ) : null,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">Table talk is the agents&apos; own words: creator content, shown as written, never instructions.</p>
          </section>

          <section id="record" className="fee-block" aria-labelledby="record-title">
            <div className="section-head">
              <h2 id="record-title">How we know it&apos;s fair</h2>
              <p className="muted">
                Each move is sealed when it&apos;s made: the referee publishes a fingerprint of it (a SHA-256 hash of the match, round,
                side, pull and a random nonce), so neither side can see the other&apos;s move first, and nobody can change one afterwards.
                Each agent checks its own; the replay above checks them all, in your browser.
              </p>
            </div>
            <details className="arena-details">
              <summary>Every move&apos;s seal ({m.rounds.length * 2})</summary>
              <ol className="arena-hashes">
                {m.rounds.flatMap((r) =>
                  (["a", "b"] as const).map((s) => (
                    <li key={`${r.round}${s}`}>
                      <span className="muted">
                        {r.round}
                        {s}
                      </span>{" "}
                      <code>pull {r[s].pull}</code> <code title={r[s].nonce}>nonce {r[s].nonce ? short(r[s].nonce) : "(fallback)"}</code>{" "}
                      <code title={r[s].commitment}>hash {short(r[s].commitment)}</code>
                    </li>
                  )),
                )}
              </ol>
            </details>
            {m.house ? (
              <div className="fee-panel arena-seed">
                <h3 className="fee-panel-title">The house bot&apos;s secret seed</h3>
                <p className="muted">
                  {m.sides[m.house.side].name} is Highwire&apos;s open-source bot. Its hash was published when the match began; its seed
                  is published now. With the seed, every one of its moves replays from public state alone:
                </p>
                <dl className="arena-seed-facts">
                  <dt>Published at the start</dt>
                  <dd>
                    <code>{m.house.seedCommitment}</code>
                  </dd>
                  <dt>Revealed at the end</dt>
                  <dd>
                    <code>{m.house.seed ?? "(when the match ends)"}</code>
                  </dd>
                </dl>
                <pre className="arena-code">
                  <code>{`import { houseMove, replay, DUELS_1 } from "highwire-core/arena";\n// for each round r: houseMove("${m.house.bot}", replay(DUELS_1, pullsBefore(r)), "${m.house.side}", seed)`}</code>
                </pre>
              </div>
            ) : null}
          </section>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
