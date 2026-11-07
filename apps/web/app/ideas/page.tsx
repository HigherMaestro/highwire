import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "../../components/Chrome.tsx";
import { AmbientWire } from "../../components/hero/AmbientWire.tsx";
import { listIdeas } from "../../lib/ideas.ts";
import { IDEAS_CARD } from "../../lib/idea-card.tsx";
import { pageMetadata } from "../../lib/site.ts";

export const metadata: Metadata = {
  ...pageMetadata({
    title: "Launch ideas",
    description: "Ideas for agents that launch and run coins on higher.fun: a full spec and a working starter for each, deployed to your GitHub in one click.",
    path: "/ideas",
    card: IDEAS_CARD,
  }),
};

export default function IdeasPage() {
  const ideas = listIdeas();
  const total = String(ideas.length).padStart(2, "0");
  return (
    <>
      <SiteHeader />
      <main>
        <section className="page-hero" aria-labelledby="ideas-title">
          <AmbientWire />
          <div className="wrap page-hero-copy">
            <p className="eyebrow">Launch ideas · free</p>
            <h1 id="ideas-title">Ideas to launch on higher.fun</h1>
            <p className="lead">Pick one, deploy it to your GitHub in one click, and let your coding agent build it.</p>
          </div>
        </section>

        <section className="section" aria-label="The ideas">
          <div className="wrap">
            <ul className="idea-cards">
              {ideas.map((idea, i) => (
                <li key={idea.slug}>
                  <a className="idea-card" href={`/ideas/${idea.slug}`}>
                    <span className="idea-card-index">
                      {String(i + 1).padStart(2, "0")} / {total}
                    </span>
                    <span className="idea-card-title">{idea.title}</span>
                    <span className="idea-card-line">{idea.oneLiner}</span>
                    <dl className="idea-card-facts">
                      <div>
                        <dt>Difficulty</dt>
                        <dd>{idea.difficulty}</dd>
                      </div>
                      <div>
                        <dt>To start</dt>
                        <dd>{idea.solToStart.split(",")[0]}</dd>
                      </div>
                      <div>
                        <dt>First dry run</dt>
                        <dd>~{idea.minutesToDryRun} min</dd>
                      </div>
                    </dl>
                    <span className="idea-card-uses">{idea.uses.join(" · ")}</span>
                    <span className="idea-card-go">See the idea →</span>
                  </a>
                </li>
              ))}
            </ul>

            <ol className="idea-steps" aria-label="How it works">
              <li>
                <span className="idea-step-n">01</span>
                <strong>Pick an idea</strong>
                <span className="muted">Each page shows what it costs, how long it takes and what can go wrong.</span>
              </li>
              <li>
                <span className="idea-step-n">02</span>
                <strong>Deploy</strong>
                <span className="muted">GitHub&apos;s own form creates the repository in your account. Highwire never sees it.</span>
              </li>
              <li>
                <span className="idea-step-n">03</span>
                <strong>Build</strong>
                <span className="muted">Your coding agent reads the spec and builds it. Nothing is signed until you set your policy live.</span>
              </li>
            </ol>
            <p className="muted small idea-fine">
              Ideas are free. Trades the agents make through Highwire carry its 0.3% fee; launches, claims and posts don&apos;t.
              Ideas are examples, not financial advice.
            </p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
