import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "../../../components/Chrome.tsx";
import { CopyCommand } from "../../../components/CopyCommand.tsx";
import { deployUrl, getIdea, listIdeas, readPrd } from "../../../lib/ideas.ts";
import { Markdown } from "../../../lib/markdown.tsx";

export const dynamicParams = false;

export function generateStaticParams() {
  return listIdeas().map((i) => ({ slug: i.slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const idea = getIdea((await params).slug);
  if (!idea) return {};
  return { title: `${idea.title}: launch idea`, description: idea.oneLiner, alternates: { canonical: `/ideas/${idea.slug}` } };
}

function List({ items, ordered = false }: { items: string[]; ordered?: boolean }) {
  const lis = items.map((t) => <li key={t}>{t}</li>);
  return ordered ? <ol className="steps">{lis}</ol> : <ul className="plain idea-list">{lis}</ul>;
}

export default async function IdeaPage({ params }: Props) {
  const idea = getIdea((await params).slug);
  if (!idea) notFound();
  const start = [`git clone https://github.com/<you>/${idea.slug}.git`, `cd ${idea.slug}`, "npm install", "npm run setup"].join("\n");
  return (
    <>
      <SiteHeader />
      <main className="section">
        <div className="wrap idea-page">
          <p className="small">
            <a href="/ideas">← All ideas</a>
          </p>
          <header className="docs-intro idea-intro">
            <p className="eyebrow">
              Launch idea · {idea.difficulty} · to start: {idea.solToStart}
            </p>
            <h1>{idea.title}</h1>
            <p className="lead">{idea.oneLiner}</p>
            <ul className="badges" aria-label="What it uses">
              {idea.uses.map((u) => (
                <li key={u} className="badge">
                  {u}
                </li>
              ))}
            </ul>
          </header>

          <section className="card idea-deploy" aria-labelledby="deploy-title">
            <h2 id="deploy-title">Deploy</h2>
            <p className="muted">
              Creates <code>{idea.slug}</code> in your GitHub account from this idea&apos;s template, using GitHub&apos;s own
              form. You get the spec, instructions for your coding agent, Highwire already wired in, and a starting policy
              that&apos;s a dry run. Highwire never sees the repository.
            </p>
            <p className="hero-actions">
              <a className="button" href={deployUrl(idea)}>
                Deploy to GitHub
              </a>
              <a className="button button-quiet" href="#prd">
                Read the PRD
              </a>
            </p>
            <h3>Then</h3>
            <CopyCommand code={start} label="Clone and set up" multiline />
            <p className="muted small">Open it in Claude Code (or any coding agent) and say:</p>
            <CopyCommand code={idea.prompt} label="Prompt for your coding agent" multiline />
          </section>

          <div className="idea-grid">
            <section aria-labelledby="how-title">
              <h2 id="how-title">How it works</h2>
              <List items={idea.howItWorks} ordered />
            </section>
            <section aria-labelledby="earns-title">
              <h2 id="earns-title">How it earns</h2>
              <p>{idea.earns}</p>
            </section>
            <section aria-labelledby="costs-title">
              <h2 id="costs-title">What it costs</h2>
              <List items={idea.costs} />
            </section>
            <section aria-labelledby="needs-title">
              <h2 id="needs-title">What you need</h2>
              <List items={[...idea.needs, ...idea.outside]} />
            </section>
            <section aria-labelledby="risks-title">
              <h2 id="risks-title">Risks and limits</h2>
              <List items={idea.risks} />
            </section>
            <section aria-labelledby="milestones-title">
              <h2 id="milestones-title">Milestones</h2>
              <ol className="steps">
                {idea.milestones.map((m) => (
                  <li key={m.title}>
                    <strong>{m.title}</strong>: {m.summary}
                  </li>
                ))}
              </ol>
            </section>
          </div>

          <article className="prose idea-prd" id="prd" aria-labelledby="prd-title">
            <p className="eyebrow">
              PRD.md · <a href={`/ideas/${idea.slug}/prd.md`}>raw markdown</a>
            </p>
            <h2 id="prd-title">The full spec</h2>
            <Markdown source={readPrd(idea.slug)} />
          </article>

          <p className="muted small">
            This idea is an example, not financial advice. You run the agent and you&apos;re responsible for what it does.
          </p>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
