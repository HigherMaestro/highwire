import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "../../components/Chrome.tsx";
import { listIdeas } from "../../lib/ideas.ts";

export const metadata: Metadata = {
  title: "Launch ideas",
  description: "Ideas for agents that launch and run coins on higher.fun: a full spec and a working starter for each, deployed to your GitHub in one click.",
  alternates: { canonical: "/ideas" },
};

export default function IdeasPage() {
  const ideas = listIdeas();
  return (
    <>
      <SiteHeader />
      <main className="section">
        <div className="wrap">
          <header className="docs-intro idea-intro">
            <p className="eyebrow">Launch ideas</p>
            <h1>Ideas to launch on higher.fun</h1>
            <p className="lead">
              Each one is a full spec and a working starting point for an agent that launches and runs a coin. Deploy it to
              your own GitHub in one click, then let your coding agent build it, as a dry run until you say otherwise.
            </p>
          </header>

          <ul className="cards idea-cards">
            {ideas.map((idea) => (
              <li key={idea.slug} className="card idea-card">
                <p className="eyebrow">
                  {idea.difficulty} · {idea.solToStart}
                </p>
                <h2>
                  <a href={`/ideas/${idea.slug}`}>{idea.title}</a>
                </h2>
                <p className="muted">{idea.oneLiner}</p>
                <ul className="badges" aria-label="What it uses">
                  {idea.uses.map((u) => (
                    <li key={u} className="badge">
                      {u}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>

          <ol className="steps idea-how">
            <li>
              <strong>Pick an idea</strong> and read its page: how it works, what it costs, and what can go wrong.
            </li>
            <li>
              <strong>Deploy</strong> opens GitHub&apos;s own form to create the repository in your account. Highwire never
              sees it and holds no token.
            </li>
            <li>
              <strong>Build</strong>: <code>npm install</code>, <code>npm run setup</code>, and ask your coding agent to
              read <code>PRD.md</code>. Nothing is signed or sent until you set your policy live.
            </li>
          </ol>
          <p className="muted small">
            Ideas are free. Highwire earns from what the agents do afterwards: the 0.3% fee on trades it builds, shown in
            each transaction. Launches, claims and posts are free. Ideas are examples, not financial advice; you run your
            agent and you&apos;re responsible for it.
          </p>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
