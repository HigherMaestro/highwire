import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DEFAULT_API_URL, HigherApi, createHttpConfig } from "highwire-core";
import { SiteFooter, SiteHeader } from "../../../components/Chrome.tsx";
import { AmbientWire } from "../../../components/hero/AmbientWire.tsx";
import { SectionNav } from "../../../components/ideas/SectionNav.tsx";
import { CopyCommand } from "../../../components/CopyCommand.tsx";
import { IdeaCalculator, type MarketContext } from "../../../components/ideas/IdeaCalculator.tsx";
import { agentPrompt, assemble, defaultIdeasDir, deployUrl, fileTree, getIdea, listIdeas, newCommand, readPrd, startCommand } from "../../../lib/ideas.ts";
import { Markdown } from "../../../lib/markdown.tsx";
import { SITE_URL } from "../../../lib/site.ts";

export const dynamicParams = false;
// The market numbers that anchor the calculator are read again at most hourly.
export const revalidate = 3600;

export function generateStaticParams() {
  return listIdeas().map((i) => ({ slug: i.slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const idea = getIdea((await params).slug);
  if (!idea) return {};
  return { title: `${idea.title}: launch idea`, description: idea.oneLiner, alternates: { canonical: `/ideas/${idea.slug}` } };
}

/** Real higher.fun volumes and the SOL price, for scale. Best effort: the calculator works without them. */
async function marketContext(): Promise<MarketContext> {
  const api = new HigherApi(createHttpConfig({ baseUrl: DEFAULT_API_URL, timeoutMs: 8_000, retries: 1, userAgent: "highwire-site" }));
  const [coins, price] = await Promise.all([api.listCoins({ sort: "trending", limit: 100 }).catch(() => null), api.solPrice().catch(() => null)]);
  const vols = (coins?.items ?? [])
    .map((c) => (c.volume24h ? Number(BigInt(c.volume24h.split(".")[0] || "0")) / 1e9 : 0))
    .filter((v) => v > 0)
    .sort((a, b) => b - a);
  return {
    topVolumeSol: vols[0] ?? null,
    medianVolumeSol: vols.length ? vols[Math.floor(vols.length / 2)]! : null,
    solUsd: price?.usd ?? null,
  };
}

const VERSION = () =>
  (JSON.parse(readFileSync(join(/* turbopackIgnore: true */ process.cwd(), "../../packages/mcp/package.json"), "utf8")) as { version: string }).version;

/** What the important files in every template are for. */
const FILE_NOTES: [string, string][] = [
  ["PRD.md", "the full spec: the loop, the policy, milestones with acceptance criteria, rules"],
  ["AGENTS.md", "how your coding agent should work here, and what it must never do (CLAUDE.md points to it)"],
  [".mcp.json", "Highwire's tools, wired in for this project's own wallet"],
  ["policy.example.json", "the starting policy, a dry run; setup copies it next to the wallet"],
  ["scripts/setup.mjs", "makes the wallet outside the repository, refuses to run next to a key"],
  ["src/tools.ts", "calls any Highwire tool from code, inside the policy"],
  ["src/agent.ts", "the agent's own loop, which the milestones fill in"],
];

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="plain idea-list">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

const SECTIONS = [
  { id: "start", label: "Start" },
  { id: "how", label: "How it works" },
  { id: "numbers", label: "The numbers" },
  { id: "costs", label: "Costs and risks" },
  { id: "files", label: "What you get" },
  { id: "policy", label: "Policy" },
  { id: "milestones", label: "Milestones" },
  { id: "faq", label: "Questions" },
  { id: "prd", label: "The spec" },
];

const n = (id: string) => String(SECTIONS.findIndex((s) => s.id === id) + 1).padStart(2, "0");

function H2({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={`${id}-title`} className="sec-h">
      <span className="sec-n">{n(id)}</span>
      {children}
    </h2>
  );
}

export default async function IdeaPage({ params }: Props) {
  const idea = getIdea((await params).slug);
  if (!idea) notFound();
  const all = listIdeas();
  const index = all.findIndex((i) => i.slug === idea.slug);
  const market = await marketContext();
  const files = [...assemble(idea.slug, { version: VERSION(), siteUrl: SITE_URL }).keys()];
  const policy = JSON.parse(readFileSync(join(defaultIdeasDir(), idea.slug, "policy.example.json"), "utf8")) as Record<string, unknown>;
  const steps = [`git clone https://github.com/<you>/${idea.slug}.git`, `cd ${idea.slug}`, "npm install", "npm run setup"].join("\n");

  return (
    <>
      <SiteHeader />
      <main>
        <section className="page-hero idea-hero" aria-labelledby="idea-title">
          <AmbientWire />
          <div className="wrap page-hero-copy">
            <nav className="crumbs" aria-label="Breadcrumb">
              <a href="/ideas">Ideas</a>
              <span aria-hidden="true">/</span>
              <span aria-current="page">{idea.title}</span>
            </nav>
            <p className="eyebrow">
              Launch idea · {String(index + 1).padStart(2, "0")} / {String(all.length).padStart(2, "0")} · {idea.difficulty}
            </p>
            <h1 id="idea-title">{idea.title}</h1>
            <p className="lead">{idea.oneLiner}</p>
            <div className="hero-actions">
              <a className="button" href={deployUrl(idea)}>
                Deploy to GitHub
              </a>
              <a className="button button-quiet" href="#start">
                Other ways to start
              </a>
            </div>
            <dl className="idea-stats">
              <div>
                <dt>To start</dt>
                <dd>{idea.solToStart.split(",")[0]}</dd>
              </div>
              <div>
                <dt>First dry run</dt>
                <dd>~{idea.minutesToDryRun} min</dd>
              </div>
              <div>
                <dt>Outside services</dt>
                <dd>{idea.outside.length ? idea.outside.length : "None"}</dd>
              </div>
              <div>
                <dt>To try it</dt>
                <dd>Free</dd>
              </div>
            </dl>
          </div>
        </section>

        <SectionNav sections={SECTIONS} />

        <div className="wrap idea-page">
          <section id="start" className="idea-block" aria-labelledby="start-title">
            <H2 id="start">Start</H2>
            <div className="idea-start-main card">
              <ol className="idea-start-steps">
                <li>
                  <strong>Deploy.</strong> GitHub&apos;s own form creates <code>{idea.slug}</code> in your account.
                  <a className="button" href={deployUrl(idea)}>
                    Deploy to GitHub
                  </a>
                </li>
                <li>
                  <strong>Set it up</strong> in a terminal. This makes the agent&apos;s wallet outside the repository and a policy
                  that&apos;s a dry run.
                  <CopyCommand code={steps} label="Clone and set up" multiline />
                </li>
                <li>
                  <strong>Build.</strong> Open it in Claude Code or any coding agent, and say:
                  <CopyCommand code={idea.prompt} label="Prompt for your coding agent" multiline />
                </li>
              </ol>
            </div>
            <h3 className="idea-other-h">Other ways to start</h3>
            <div className="idea-starts">
              <div className="card idea-start">
                <h4>One command</h4>
                <p className="muted small">
                  Creates, clones and sets it up, with <a href="https://cli.github.com">GitHub&apos;s CLI</a> signed in.
                </p>
                <CopyCommand code={startCommand(idea.slug)} label="Create, clone and set up" multiline />
              </div>
              <div className="card idea-start">
                <h4>Without GitHub</h4>
                <p className="muted small">Highwire&apos;s command line writes the same project into a new folder, as a fresh git repository.</p>
                <CopyCommand code={newCommand(idea.slug)} label="Write it here and set up" multiline />
              </div>
              <div className="card idea-start">
                <h4>Hand it to your agent</h4>
                <p className="muted small">A coding agent with a shell does every step, and stops after milestone 1.</p>
                <CopyCommand code={agentPrompt(idea)} label="Prompt that does every step" multiline />
              </div>
            </div>
          </section>

          <section id="how" className="idea-block" aria-labelledby="how-title">
            <H2 id="how">How it works</H2>
            <div className="idea-grid">
              <div>
                <h3>The loop</h3>
                <ol className="steps">
                  {idea.howItWorks.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ol>
              </div>
              <div>
                <h3>How it runs</h3>
                <ol className="idea-timeline">
                  {idea.day.map((d) => (
                    <li key={d.at}>
                      <span className="idea-timeline-at">{d.at}</span>
                      <span>{d.text}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </section>

          <section id="numbers" className="idea-block" aria-labelledby="numbers-title">
            <H2 id="numbers">The numbers</H2>
            <p className="muted">{idea.earns}</p>
            <IdeaCalculator kind={idea.calculator} market={market} />
          </section>

          <section id="costs" className="idea-block" aria-labelledby="costs-title">
            <H2 id="costs">Costs and risks</H2>
            <div className="idea-grid idea-grid-3">
              <div>
                <h3>What it costs</h3>
                <Bullets items={idea.costs} />
              </div>
              <div>
                <h3>What you need</h3>
                <Bullets items={[...idea.needs, ...idea.outside]} />
              </div>
              <div>
                <h3>Risks and limits</h3>
                <Bullets items={idea.risks} />
              </div>
            </div>
          </section>

          <section id="files" className="idea-block" aria-labelledby="files-title">
            <H2 id="files">What you get</H2>
            <div className="idea-grid">
              <pre className="idea-tree" aria-label="The repository's files">{`${idea.slug}/\n${fileTree(files)}`}</pre>
              <ul className="plain idea-list">
                {FILE_NOTES.filter(([f]) => files.includes(f)).map(([f, note]) => (
                  <li key={f}>
                    <code>{f}</code>: {note}
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section id="policy" className="idea-block" aria-labelledby="policy-title">
            <H2 id="policy">The starting policy</H2>
            <p className="muted">
              Setup copies it to <code>~/.highwire/{idea.slug}/policy.json</code>. Nothing is signed while <code>live</code> is
              false, and only you can change it.
            </p>
            <dl className="idea-policy">
              {Object.entries(policy)
                .filter(([k]) => idea.policyNotes[k])
                .map(([k, v]) => (
                  <div key={k}>
                    <dt>
                      <code>{k}</code> <span className="mono-wrap muted small">{JSON.stringify(v)}</span>
                    </dt>
                    <dd>{idea.policyNotes[k]}</dd>
                  </div>
                ))}
            </dl>
          </section>

          <section id="milestones" className="idea-block" aria-labelledby="milestones-title">
            <H2 id="milestones">Milestones</H2>
            <ol className="idea-milestones">
              {idea.milestones.map((m) => (
                <li key={m.title} className="card">
                  <strong>{m.title}</strong>
                  <span className="muted">{m.summary}</span>
                </li>
              ))}
            </ol>
          </section>

          <section id="faq" className="idea-block" aria-labelledby="faq-title">
            <H2 id="faq">Questions</H2>
            <div className="idea-faq">
              {idea.faq.map((f) => (
                <details key={f.q}>
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </section>

          <section id="prd" className="idea-block idea-prd" aria-labelledby="prd-title">
            <H2 id="prd">The full spec</H2>
            <p className="muted small">
              PRD.md, as your coding agent reads it. <a href={`/ideas/${idea.slug}/prd.md`}>Raw markdown</a>
            </p>
            <article className="prose">
              <Markdown source={readPrd(idea.slug)} />
            </article>
          </section>

          <p className="muted small idea-fine">
            An example, not financial advice. You run the agent and you&apos;re responsible for what it does.
          </p>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
