import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "../../../components/Chrome.tsx";
import { AmbientWire } from "../../../components/hero/AmbientWire.tsx";
import { SectionNav } from "../../../components/ideas/SectionNav.tsx";
import { CopyCommand } from "../../../components/CopyCommand.tsx";
import { addCommand, defaultIdeasDir, fileTree, getModule, listIdeas, listModules, moduleFiles, moduleSpecPath, readModuleSpec } from "../../../lib/ideas.ts";
import { moduleCardFor } from "../../../lib/idea-card.tsx";
import { Markdown } from "../../../lib/markdown.tsx";
import { SITE_URL, pageMetadata } from "../../../lib/site.ts";

export const dynamicParams = false;

export function generateStaticParams() {
  return listModules().map((m) => ({ slug: m.slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const mod = getModule((await params).slug);
  if (!mod) return {};
  return pageMetadata({ title: `${mod.title}: module`, description: mod.oneLiner, path: `/modules/${mod.slug}`, card: moduleCardFor(mod.slug) });
}

const SECTIONS = [
  { id: "add", label: "Add it" },
  { id: "how", label: "How it works" },
  { id: "policy", label: "Policy" },
  { id: "files", label: "The code" },
  { id: "risks", label: "Risks" },
  { id: "spec", label: "The spec" },
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

export default async function ModulePage({ params }: Props) {
  const mod = getModule((await params).slug);
  if (!mod) notFound();
  const ideas = listIdeas();
  const fits = ideas.filter((i) => mod.worksWith.includes(i.slug));
  const files = moduleFiles(mod.slug);
  const code = [...files].filter(([rel]) => rel !== moduleSpecPath(mod.slug));
  const settings = mod.settings ? (JSON.parse(readFileSync(join(defaultIdeasDir(), "modules", mod.slug, "files", mod.settings.file), "utf8")) as Record<string, unknown>) : null;
  const mdUrl = `${SITE_URL}/modules/${mod.slug}/module.md`;
  const agentPrompt = `Add Highwire's ${mod.title} module to this project: run \`${addCommand(mod.slug)}\`, then ${mod.prompt[0]!.toLowerCase()}${mod.prompt.slice(1)}`;
  const noCli = `Read ${mdUrl} and add Highwire's ${mod.title} module to this project: write each file it lists at its path, then wire it in as its "Wiring it in" section says. Don't change the policy; tell me what it needs.`;
  const needs = [
    ...(mod.needs.actions?.length ? [`${mod.needs.actions.map((a) => `"${a}"`).join(", ")} in "actions"`] : []),
    ...(mod.needs.orderKinds?.length
      ? [`${mod.needs.orderKinds.map((k) => `"${k}"`).join(", ")} in "orders" → "kinds"${mod.needs.openOrders ? `, with room for ${mod.needs.openOrders} more in "max_open"` : ""}`]
      : []),
    ...(mod.needs.posts ? ['a "posts" section: comments on the wallet\'s own coins'] : []),
  ];

  return (
    <>
      <SiteHeader />
      <main>
        <section className="page-hero idea-hero" aria-labelledby="module-title">
          <AmbientWire />
          <div className="wrap page-hero-copy">
            <nav className="crumbs" aria-label="Breadcrumb">
              <a href="/ideas">Ideas</a>
              <span aria-hidden="true">/</span>
              <a href="/ideas#modules">Modules</a>
              <span aria-hidden="true">/</span>
              <span aria-current="page">{mod.title}</span>
            </nav>
            <p className="eyebrow">Module · free</p>
            <h1 id="module-title">{mod.title}</h1>
            <p className="lead">{mod.oneLiner}</p>
            <div className="hero-actions">
              <a className="button" href="#add">
                Add it to your agent
              </a>
              <a className="button button-quiet" href={`/modules/${mod.slug}/module.md`}>
                The spec and code, as markdown
              </a>
            </div>
            <dl className="idea-stats">
              <div>
                <dt>Works with</dt>
                <dd>{fits.length === ideas.length ? "Every agent" : `${fits.length} agent${fits.length === 1 ? "" : "s"}`}</dd>
              </div>
              <div>
                <dt>Policy</dt>
                <dd>{needs.length ? "Needs a change" : "No change"}</dd>
              </div>
              <div>
                <dt>Files</dt>
                <dd>{code.length}</dd>
              </div>
              {mod.liveOn && (
                <div>
                  <dt>Running on</dt>
                  <dd>{mod.liveOn.replace(/^The /, "").replace(/, since.*$/, "")}</dd>
                </div>
              )}
            </dl>
          </div>
        </section>

        <SectionNav sections={SECTIONS} />

        <div className="wrap idea-page">
          <section id="add" className="idea-block" aria-labelledby="add-title">
            <H2 id="add">Add it</H2>
            <div className="idea-start-main card">
              <ol className="idea-start-steps">
                <li>
                  <strong>Copy it in.</strong> In your agent&apos;s project, made from one of the{" "}
                  <a href="/ideas#agents">agents</a>. It never overwrites a file and never touches your policy.
                  <CopyCommand code={addCommand(mod.slug)} label="Add the module" />
                </li>
                <li>
                  <strong>Wire it in.</strong> Open the project in your coding agent and say:
                  <CopyCommand code={mod.prompt} label="Prompt for your coding agent" multiline />
                </li>
                <li>
                  <strong>{needs.length ? "Allow it." : "Run it."}</strong>{" "}
                  {needs.length
                    ? `Add to your policy, yourself: ${needs.join("; ")}. The command above says what yours is missing.`
                    : "It needs nothing from your policy. Restart the agent, or reinstall its service, to load it."}
                </li>
              </ol>
            </div>
            <div className="idea-starts">
              <div className="card idea-start">
                <h4>Hand it to your agent</h4>
                <p className="muted small">A coding agent with a shell runs the command and wires it in.</p>
                <CopyCommand code={agentPrompt} label="Prompt that does every step" multiline />
              </div>
              <div className="card idea-start">
                <h4>Without Highwire&apos;s command line</h4>
                <p className="muted small">The spec and every file in one markdown page, for any coding agent that can read the web.</p>
                <CopyCommand code={noCli} label="Prompt that reads the markdown" multiline />
              </div>
              <div className="card idea-start">
                <h4>Fits these agents</h4>
                <ul className="plain idea-list">
                  {fits.map((i) => (
                    <li key={i.slug}>
                      <a href={`/ideas/${i.slug}`}>{i.title}</a>
                    </li>
                  ))}
                </ul>
                {mod.liveOn && <p className="muted small">{mod.liveOn}.</p>}
              </div>
            </div>
          </section>

          <section id="how" className="idea-block" aria-labelledby="how-title">
            <H2 id="how">How it works</H2>
            <div className="idea-grid">
              <div>
                <h3>What it does</h3>
                <ol className="steps">
                  {mod.howItWorks.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ol>
              </div>
              <div>
                <h3>Wiring it in</h3>
                <ol className="steps">
                  {mod.wire.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ol>
              </div>
            </div>
          </section>

          <section id="policy" className="idea-block" aria-labelledby="policy-title">
            <H2 id="policy">Policy and settings</H2>
            <p className="muted">
              {needs.length ? `Your policy needs ${needs.join("; ")}. Only you change it.` : "It needs nothing from your policy, and only ever narrows what the agent can do."}
            </p>
            {settings && mod.settings && (
              <>
                <h3>
                  <code>{mod.settings.file}</code>
                </h3>
                <dl className="idea-policy">
                  {Object.entries(settings).map(([k, v]) => (
                    <div key={k}>
                      <dt>
                        <code>{k}</code> <span className="mono-wrap muted small">{JSON.stringify(v)}</span>
                      </dt>
                      <dd>{mod.settings!.notes[k]}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </section>

          <section id="files" className="idea-block" aria-labelledby="files-title">
            <H2 id="files">The code</H2>
            <div className="idea-grid">
              <pre className="idea-tree" aria-label="The files it adds">{`your-agent/\n${fileTree([...files.keys()])}`}</pre>
              <p className="muted">
                Plain TypeScript that imports only your project&apos;s own <code>src/highwire.ts</code> and <code>src/tools.ts</code> and
                Highwire&apos;s packages. The decision is a pure function with tests; the rest reads, then acts through Highwire, inside your
                policy.
              </p>
            </div>
            {code.map(([rel, text]) => (
              <details key={rel} className="module-code">
                <summary>{rel}</summary>
                <pre>
                  <code>{text}</code>
                </pre>
              </details>
            ))}
          </section>

          <section id="risks" className="idea-block" aria-labelledby="risks-title">
            <H2 id="risks">Risks and limits</H2>
            <ul className="plain idea-list">
              {mod.risks.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </section>

          <section id="spec" className="idea-block idea-prd" aria-labelledby="spec-title">
            <H2 id="spec">The spec</H2>
            <p className="muted small">
              {moduleSpecPath(mod.slug)}, as your coding agent reads it. <a href={`/modules/${mod.slug}/module.md`}>With the code, as markdown</a>
            </p>
            <article className="prose">
              <Markdown source={readModuleSpec(mod.slug)} />
            </article>
          </section>

          <p className="muted small idea-fine">An example, not financial advice. You run the agent and you&apos;re responsible for what it does.</p>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
