import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "../../components/Chrome.tsx";
import { AmbientWire } from "../../components/hero/AmbientWire.tsx";
import { listIdeas, listModules } from "../../lib/ideas.ts";
import { IDEAS_CARD } from "../../lib/idea-card.tsx";
import { pageMetadata } from "../../lib/site.ts";

export const metadata: Metadata = {
  ...pageMetadata({
    title: "Launch ideas",
    description: "Agents that launch and run coins on higher.fun, each a full spec and a working starter you deploy in one click, and modules that add one thing to an agent you already run.",
    path: "/ideas",
    card: IDEAS_CARD,
  }),
};

export default function IdeasPage() {
  const ideas = listIdeas();
  const modules = listModules();
  const total = String(ideas.length).padStart(2, "0");
  const titleOf = new Map(ideas.map((i) => [i.slug, i.title]));
  return (
    <>
      <SiteHeader />
      <main>
        <section className="page-hero" aria-labelledby="ideas-title">
          <AmbientWire />
          <div className="wrap page-hero-copy">
            <p className="eyebrow">Launch ideas · free</p>
            <h1 id="ideas-title">Ideas to launch on higher.fun</h1>
            <p className="lead">
              Start a whole agent, or add one thing to an agent you already run. Your coding agent builds it; nothing is signed until you
              set your policy live.
            </p>
            <nav className="idea-kinds" aria-label="Kinds of idea">
              <a href="#agents">
                <strong>Agents</strong>
                <span className="muted small">{ideas.length} whole projects: a spec, a starter, one-click deploy</span>
              </a>
              <a href="#modules">
                <strong>Modules</strong>
                <span className="muted small">{modules.length} add-ons: working code you drop into an agent</span>
              </a>
            </nav>
          </div>
        </section>

        <section id="agents" className="section idea-kind" aria-labelledby="agents-title">
          <div className="wrap">
            <div className="section-head">
              <h2 id="agents-title">Agents</h2>
              <p className="muted">Whole projects. Deploy one to your GitHub, and your coding agent builds it milestone by milestone from its spec.</p>
            </div>
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
          </div>
        </section>

        <section id="modules" className="section idea-kind" aria-labelledby="modules-title">
          <div className="wrap">
            <div className="section-head">
              <h2 id="modules-title">Modules</h2>
              <p className="muted">
                One capability for an agent you already run. Each is working code and a short spec: one command copies it into your project, and
                your coding agent wires it into the loop. Your policy decides whether it can act.
              </p>
            </div>
            <ul className="idea-cards">
              {modules.map((m) => (
                <li key={m.slug}>
                  <a className="idea-card" href={`/modules/${m.slug}`}>
                    <span className="idea-card-index">Module</span>
                    <span className="idea-card-title">{m.title}</span>
                    <span className="idea-card-line">{m.oneLiner}</span>
                    <dl className="idea-card-facts">
                      <div>
                        <dt>Works with</dt>
                        <dd>{m.worksWith.length === ideas.length ? "every agent" : m.worksWith.map((w) => titleOf.get(w) ?? w).join(", ")}</dd>
                      </div>
                      <div>
                        <dt>Policy</dt>
                        <dd>{m.needs.orderKinds?.length || m.needs.actions?.length || m.needs.posts ? "needs a change" : "no change"}</dd>
                      </div>
                    </dl>
                    <span className="idea-card-uses">{m.uses.join(" · ")}</span>
                    <span className="idea-card-go">See the module →</span>
                  </a>
                </li>
              ))}
            </ul>
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
