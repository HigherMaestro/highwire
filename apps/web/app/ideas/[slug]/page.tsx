import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DEFAULT_API_URL, HigherApi, createHttpConfig } from "highwire-core";
import { SiteFooter, SiteHeader } from "../../../components/Chrome.tsx";
import { CopyCommand } from "../../../components/CopyCommand.tsx";
import { IdeaCalculator, type MarketContext } from "../../../components/ideas/IdeaCalculator.tsx";
import { agentPrompt, assemble, defaultIdeasDir, deployUrl, fileTree, getIdea, listIdeas, readPrd, startCommand } from "../../../lib/ideas.ts";
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

export default async function IdeaPage({ params }: Props) {
  const idea = getIdea((await params).slug);
  if (!idea) notFound();
  const market = await marketContext();
  const files = [...assemble(idea.slug, { version: VERSION(), siteUrl: SITE_URL }).keys()];
  const policy = JSON.parse(readFileSync(join(defaultIdeasDir(), idea.slug, "policy.example.json"), "utf8")) as Record<string, unknown>;
  const steps = [`git clone https://github.com/<you>/${idea.slug}.git`, `cd ${idea.slug}`, "npm install", "npm run setup"].join("\n");

  return (
    <>
      <SiteHeader />
      <main className="section">
        <div className="wrap idea-page">
          <p className="small">
            <a href="/ideas">← All ideas</a>
          </p>
          <header className="docs-intro idea-intro">
            <p className="eyebrow">Launch idea · {idea.difficulty}</p>
            <h1>{idea.title}</h1>
            <p className="lead">{idea.oneLiner}</p>
            <ul className="badges" aria-label="What it uses">
              {idea.uses.map((u) => (
                <li key={u} className="badge">
                  {u}
                </li>
              ))}
            </ul>
            <dl className="idea-facts">
              <div>
                <dt>To start</dt>
                <dd>{idea.solToStart}</dd>
              </div>
              <div>
                <dt>To a first dry run</dt>
                <dd>about {idea.minutesToDryRun} minutes</dd>
              </div>
              <div>
                <dt>Outside services</dt>
                <dd>{idea.outside.length ? idea.outside.join("; ") : "none"}</dd>
              </div>
              <div>
                <dt>Costs to try</dt>
                <dd>nothing: everything starts as a dry run</dd>
              </div>
            </dl>
          </header>

          <section className="idea-block" aria-labelledby="start-title">
            <h2 id="start-title">Start it, three ways</h2>
            <p className="muted">
              Each gives you the same repository: the spec, instructions for your coding agent, Highwire wired in, and a
              policy that&apos;s a dry run. Highwire never sees it.
            </p>
            <div className="idea-starts">
              <div className="card idea-start">
                <p className="eyebrow">1 · In the browser</p>
                <h3>Deploy to GitHub</h3>
                <p className="muted small">GitHub&apos;s own form creates it in your account. Then clone it and set it up:</p>
                <p>
                  <a className="button" href={deployUrl(idea)}>
                    Deploy to GitHub
                  </a>
                </p>
                <CopyCommand code={steps} label="Clone and set up" multiline />
              </div>
              <div className="card idea-start">
                <p className="eyebrow">2 · One command</p>
                <h3>With GitHub&apos;s CLI</h3>
                <p className="muted small">
                  Creates the repository, clones it and sets it up, if you have <a href="https://cli.github.com">gh</a> signed
                  in and Node 20 or later.
                </p>
                <CopyCommand code={startCommand(idea.slug)} label="Create, clone and set up" multiline />
              </div>
              <div className="card idea-start">
                <p className="eyebrow">3 · Hand it to your agent</p>
                <h3>Paste this</h3>
                <p className="muted small">Claude Code, or any coding agent with a shell, does every step and stops after milestone 1.</p>
                <CopyCommand code={agentPrompt(idea)} label="Prompt for your coding agent" multiline />
              </div>
            </div>
            <p className="muted small">
              Already have the repository? Open it in your coding agent and say: <q>{idea.prompt}</q>
            </p>
          </section>

          <div className="idea-grid">
            <section aria-labelledby="how-title">
              <h2 id="how-title">How it works</h2>
              <ol className="steps">
                {idea.howItWorks.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ol>
            </section>
            <section aria-labelledby="day-title">
              <h2 id="day-title">How it runs</h2>
              <ol className="idea-timeline">
                {idea.day.map((d) => (
                  <li key={d.at}>
                    <span className="idea-timeline-at">{d.at}</span>
                    <span>{d.text}</span>
                  </li>
                ))}
              </ol>
            </section>
          </div>

          <section className="idea-block" aria-labelledby="numbers-title">
            <h2 id="numbers-title">The numbers</h2>
            <p className="muted">{idea.earns}</p>
            <IdeaCalculator kind={idea.calculator} market={market} />
          </section>

          <div className="idea-grid">
            <section aria-labelledby="costs-title">
              <h2 id="costs-title">What it costs</h2>
              <Bullets items={idea.costs} />
            </section>
            <section aria-labelledby="needs-title">
              <h2 id="needs-title">What you need</h2>
              <Bullets items={[...idea.needs, ...idea.outside]} />
            </section>
            <section aria-labelledby="risks-title">
              <h2 id="risks-title">Risks and limits</h2>
              <Bullets items={idea.risks} />
            </section>
          </div>

          <div className="idea-grid">
            <section aria-labelledby="files-title">
              <h2 id="files-title">What you get</h2>
              <pre className="idea-tree" aria-label="The repository's files">{`${idea.slug}/\n${fileTree(files)}`}</pre>
              <ul className="plain idea-list">
                {FILE_NOTES.filter(([f]) => files.includes(f)).map(([f, note]) => (
                  <li key={f}>
                    <code>{f}</code>: {note}
                  </li>
                ))}
              </ul>
            </section>
            <section aria-labelledby="policy-title">
              <h2 id="policy-title">The starting policy</h2>
              <p className="muted small">
                Copied to <code>~/.highwire/{idea.slug}/policy.json</code> by setup. Nothing is signed while{" "}
                <code>live</code> is false, and only you can change it.
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
          </div>

          <section className="idea-block" aria-labelledby="milestones-title">
            <h2 id="milestones-title">Milestones</h2>
            <ol className="idea-milestones">
              {idea.milestones.map((m) => (
                <li key={m.title} className="card">
                  <strong>{m.title}</strong>
                  <span className="muted">{m.summary}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="idea-block" aria-labelledby="faq-title">
            <h2 id="faq-title">Questions</h2>
            <div className="idea-faq">
              {idea.faq.map((f) => (
                <details key={f.q}>
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </section>

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
