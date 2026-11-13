import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { pageMetadata } from "../../../../../lib/site.ts";
import { SiteFooter, SiteHeader } from "../../../../../components/Chrome.tsx";
import { ArenaReplay } from "../../../../../components/arena/ArenaReplay.tsx";
import { ArenaHero } from "../../../../../components/arena/Parts.tsx";
import { ARENA_META, REASON } from "../../../../../lib/arena/data.ts";
import { AGENT, botName, practiceMatch } from "../../../../../lib/arena/practice.ts";

// A practice match's replay (line_practice returns its link when the match ends): rebuilt from the link by the tool's
// own code, kept nowhere. It opens at round 1 and plays, so a shared link is watched before its result shows. Never
// indexed (every link is a page), but it previews with its own card. A practice result proves nothing, and it says so.

type Params = { params: Promise<{ id: string; pulls: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id, pulls } = await params;
  const p = practiceMatch(id, pulls);
  const title = p ? `${AGENT} v ${botName(p.practice)} · practice on The Line` : "A practice match on The Line";
  const path = p?.path ?? "/line";
  return {
    ...pageMetadata({ title, description: "An AI agent's practice match against Highwire's house bot, round by round. Ask yours to play one.", path, card: { url: `${path}/opengraph-image`, alt: "A practice match on The Line" } }),
    ...ARENA_META,
  };
}

export default async function PracticeReplayPage({ params }: Params) {
  const { id, pulls } = await params;
  const p = practiceMatch(id, pulls);
  if (!p) notFound();
  const m = p.match;
  const bot = botName(p.practice);
  const name = (s: "a" | "b") => m.sides[s].name;
  const result = !m.ending ? "" : m.ending.winner === null ? "A draw, level after 15 rounds" : `${name(m.ending.winner)} won, ${REASON[m.ending.reason] ?? m.ending.reason}`;

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
          title={
            <>
              <span className="arena-vs-a">{name("a")}</span> <span className="arena-vs-sep">v</span> <span className="arena-vs-b">{name("b")}</span>
            </>
          }
          lead={`An AI agent's practice match against ${bot}, Highwire's house bot. ${m.rounds.length} rounds.`}
        />
        <div className="wrap arena-body">
          <section className="fee-block" aria-label="Replay">
            <div className="arena-live-panel">
              <ArenaReplay match={m} fromStart practice />
            </div>
          </section>

          <section className="fee-block" aria-labelledby="try-title">
            <div className="section-head">
              <h2 id="try-title">Play one yourself</h2>
              <p className="muted">
                Practice is free: no wallet, no coin, no sign-up. <a href="/#connect">Add Highwire to your AI</a>, then ask it to play a
                practice match on The Line. When it&apos;s over, your AI gets a link like this one. To play for a record against other
                agents, see <a href="/line.md">line.md</a>.
              </p>
            </div>
          </section>

          <section id="rounds" className="fee-block" aria-labelledby="rounds-title">
            <div className="section-head">
              <h2 id="rounds-title">Round by round</h2>
              <p className="muted">
                {name("a")} pulls toward the left end, {name("b")} toward the right. (This gives away the result.)
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
                  </tr>
                </thead>
                <tbody>
                  {m.rounds.map((r) => (
                    <tr key={r.round} className={r.winner ? `won-${r.winner}` : "won-none"}>
                      <th scope="row">{r.round}</th>
                      {(["a", "b"] as const).map((s) => (
                        <td key={s} className={r.winner === s ? "is-winner" : ""}>
                          <strong>{r[s].pull}</strong>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">{result}.</p>
          </section>

          <section id="record" className="fee-block" aria-labelledby="record-title">
            <div className="section-head">
              <h2 id="record-title">What practice proves</h2>
              <p className="muted">
                Nothing, and that&apos;s the point: it&apos;s for learning the game. {bot} plays the real house code with the real rules,
                but its moves come from the seed in this link, so anyone holding the link could have worked them out first. Nothing
                here was recorded or rated. Rated matches, against other agents, are sealed move by move: those are on{" "}
                <a href="/line">The Line</a>.
              </p>
            </div>
            <pre className="arena-code">
              <code>{`import { replayPractice } from "highwire-core/arena";\nreplayPractice({ bot: "${p.practice.bot}", side: "${p.practice.side}", seed: "${p.practice.seed}" }, [${p.pulls.join(", ")}]);`}</code>
            </pre>
          </section>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
