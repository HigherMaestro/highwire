import { join } from "node:path";
import * as shared from "highwire-mcp/ideas";
import { TEMPLATE_OWNER, templateRepo, type Idea } from "highwire-mcp/ideas";

// Launch ideas for the site: the repo's ideas/ folder, read at build time for /ideas, and assembled into template
// repositories by scripts/ideas.ts. The loading and assembling live in highwire-mcp (src/ideas.ts), which ships the
// same folder for `highwire new`; this adds the site's own links. docs/ideas-prd.md is the spec.

export { CALCULATORS, DIFFICULTIES, PRD_SECTIONS, TEMPLATE_OWNER, ideaUrl, templateRepo, validateIdea, type Idea } from "highwire-mcp/ideas";

/** `next` and the scripts run from apps/web. */
export const defaultIdeasDir = () => join(/* turbopackIgnore: true */ process.cwd(), "../../ideas");

export const listIdeas = (dir = defaultIdeasDir()) => shared.listIdeas(dir);
export const getIdea = (slug: string, dir = defaultIdeasDir()) => shared.getIdea(slug, dir);
export const readPrd = (slug: string, dir = defaultIdeasDir()) => shared.readPrd(slug, dir);
export const assemble = (slug: string, opts: { version: string; siteUrl: string; dir?: string }) =>
  shared.assemble(slug, { ...opts, dir: opts.dir ?? defaultIdeasDir() });

/** The one-command start, with GitHub's CLI: create the repository from the template, clone it, set it up. */
export function startCommand(slug: string): string {
  return `gh repo create ${slug} --template ${TEMPLATE_OWNER}/${templateRepo(slug)} --public --clone && cd ${slug} && npm install && npm run setup`;
}

/** The same project without GitHub: Highwire's command line writes it into a new folder. */
export function newCommand(slug: string): string {
  return `npx -y highwire-mcp new ${slug} && cd ${slug} && npm install && npm run setup`;
}

/** What to tell a coding agent that has a shell, so it does every step itself. */
export function agentPrompt(idea: Pick<Idea, "slug" | "title">): string {
  return `Start the Highwire "${idea.title}" idea for me: run \`${startCommand(idea.slug)}\`, then read PRD.md and AGENTS.md and build milestone 1. Keep the policy a dry run: never set "live" yourself, and stop when milestone 1 is done.`;
}

/** The template's files as an indented tree, for the page: directories first, then files, alphabetically. */
export function fileTree(paths: string[]): string {
  type Node = Map<string, Node>;
  const root: Node = new Map();
  for (const p of paths) {
    let n = root;
    for (const part of p.split("/")) n = n.get(part) ?? n.set(part, new Map()).get(part)!;
  }
  const lines: string[] = [];
  const walkTree = (n: Node, prefix: string) => {
    const entries = [...n.entries()].sort(([a, an], [b, bn]) => Number(bn.size > 0) - Number(an.size > 0) || a.localeCompare(b));
    entries.forEach(([name, child], i) => {
      const last = i === entries.length - 1;
      lines.push(`${prefix}${last ? "└── " : "├── "}${name}${child.size ? "/" : ""}`);
      if (child.size) walkTree(child, `${prefix}${last ? "    " : "│   "}`);
    });
  };
  walkTree(root, "");
  return lines.join("\n");
}

/**
 * GitHub's own "create a repository from a template" form, pre-filled for whoever is signed in: Highwire never sees
 * the new repository or holds a token. GitHub ignores any parameter that's invalid for the user.
 */
export function deployUrl(idea: Pick<Idea, "slug" | "oneLiner">): string {
  const q = new URLSearchParams({
    template_owner: TEMPLATE_OWNER,
    template_name: templateRepo(idea.slug),
    owner: "@me",
    name: idea.slug,
    description: idea.oneLiner.slice(0, 300),
    visibility: "public",
  });
  return `https://github.com/new?${q}`;
}
