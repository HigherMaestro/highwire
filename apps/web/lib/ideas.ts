import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Launch ideas: the repo's ideas/ folder, read at build time for /ideas, and assembled into template repositories by
// scripts/ideas.ts. Each idea is ideas/<slug>/ (idea.json, PRD.md, policy.example.json, anything else the template
// needs), laid over ideas/starter/, the skeleton every template gets. docs/ideas-prd.md is the spec.

export const TEMPLATE_OWNER = "HigherMaestro";
export const templateRepo = (slug: string) => `highwire-idea-${slug}`;

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;

export interface Idea {
  slug: string;
  title: string;
  oneLiner: string;
  difficulty: (typeof DIFFICULTIES)[number];
  solToStart: string;
  uses: string[];
  outside: string[];
  howItWorks: string[];
  earns: string;
  costs: string[];
  needs: string[];
  risks: string[];
  milestones: { title: string; summary: string }[];
  /** What to paste into a coding agent in the new repository. */
  prompt: string;
}

/** The PRD sections every idea has, in this order, so coding agents learn the shape once. */
export const PRD_SECTIONS = ["Summary", "The loop", "Policy", "Milestones", "Outside services", "Rules", "Out of scope"];

/** `next` and the scripts run from apps/web. */
export const defaultIdeasDir = () => join(/* turbopackIgnore: true */ process.cwd(), "../../ideas");

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const str = (v: unknown, what: string, max = 600): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${what} must be text of at most ${max} characters`);
  return v;
};
const strs = (v: unknown, what: string, min = 0): string[] => {
  if (!Array.isArray(v) || v.length < min) throw new Error(`${what} must be a list${min ? ` of at least ${min}` : ""}`);
  return v.map((x, i) => str(x, `${what}[${i}]`));
};

/** Checks an idea.json, so a bad one fails the build rather than rendering half a page. */
export function validateIdea(raw: unknown, dirName: string): Idea {
  if (!raw || typeof raw !== "object") throw new Error(`ideas/${dirName}/idea.json isn't an object`);
  const o = raw as Record<string, unknown>;
  try {
    const slug = str(o.slug, "slug", 60);
    if (!SLUG.test(slug) || slug !== dirName) throw new Error(`slug must be the folder's name, lowercase words joined by -`);
    const difficulty = o.difficulty as Idea["difficulty"];
    if (!DIFFICULTIES.includes(difficulty)) throw new Error(`difficulty must be ${DIFFICULTIES.join(", ")}`);
    if (!Array.isArray(o.milestones) || o.milestones.length < 1) throw new Error("milestones must be a list");
    const milestones = o.milestones.map((m: unknown, i) => {
      const mm = (m ?? {}) as Record<string, unknown>;
      return { title: str(mm.title, `milestones[${i}].title`, 120), summary: str(mm.summary, `milestones[${i}].summary`) };
    });
    const title = str(o.title, "title", 60);
    const oneLiner = str(o.oneLiner, "oneLiner", 300);
    if (/["\\]/.test(title + oneLiner)) throw new Error("title and oneLiner can't contain \" or \\ (they go into JSON files)");
    return {
      slug,
      title,
      oneLiner,
      difficulty,
      solToStart: str(o.solToStart, "solToStart", 120),
      uses: strs(o.uses, "uses", 1),
      outside: strs(o.outside, "outside"),
      howItWorks: strs(o.howItWorks, "howItWorks", 1),
      earns: str(o.earns, "earns", 800),
      costs: strs(o.costs, "costs", 1),
      needs: strs(o.needs, "needs", 1),
      risks: strs(o.risks, "risks", 1),
      milestones,
      prompt: str(o.prompt, "prompt", 400),
    };
  } catch (err) {
    throw new Error(`ideas/${dirName}/idea.json: ${(err as Error).message}`);
  }
}

const ORDER = { easy: 0, medium: 1, hard: 2 };

/** Every idea, easiest first. The starter isn't one. */
export function listIdeas(dir = defaultIdeasDir()): Idea[] {
  return readdirSync(dir)
    .filter((name) => name !== "starter" && existsSync(join(dir, name, "idea.json")))
    .map((name) => validateIdea(JSON.parse(readFileSync(join(dir, name, "idea.json"), "utf8")), name))
    .sort((a, b) => ORDER[a.difficulty] - ORDER[b.difficulty] || a.title.localeCompare(b.title));
}

export function getIdea(slug: string, dir = defaultIdeasDir()): Idea | null {
  return listIdeas(dir).find((i) => i.slug === slug) ?? null;
}

export function readPrd(slug: string, dir = defaultIdeasDir()): string {
  return readFileSync(join(dir, slug, "PRD.md"), "utf8");
}

export const ideaUrl = (siteUrl: string, slug: string) => `${siteUrl}/ideas/${slug}`;

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

const BINARY = /\.(png|jpe?g|gif|webp|ico)$/i;

function walk(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(root, path) : [relative(root, path)];
  });
}

/**
 * The template repository's files for an idea: the starter, with the idea's own files laid over it (idea.json stays
 * behind), and {{slug}}, {{title}}, {{oneLiner}}, {{prompt}}, {{ideaUrl}} and {{version}} filled in. Paths use /.
 */
export function assemble(slug: string, opts: { version: string; siteUrl: string; dir?: string }): Map<string, Buffer | string> {
  const dir = opts.dir ?? defaultIdeasDir();
  const idea = getIdea(slug, dir);
  if (!idea) throw new Error(`No idea ${slug} in ${dir}`);
  const vars: Record<string, string> = {
    slug: idea.slug,
    title: idea.title,
    oneLiner: idea.oneLiner,
    prompt: idea.prompt,
    ideaUrl: ideaUrl(opts.siteUrl, idea.slug),
    version: opts.version,
  };
  const files = new Map<string, Buffer | string>();
  for (const base of [join(dir, "starter"), join(dir, slug)]) {
    for (const rel of walk(base)) {
      const key = rel.split("\\").join("/");
      if (base !== join(dir, "starter") && key === "idea.json") continue;
      const path = join(base, rel);
      if (BINARY.test(key)) {
        files.set(key, readFileSync(path));
        continue;
      }
      const text = readFileSync(path, "utf8").replace(/\{\{(\w+)\}\}/g, (m, name: string) => {
        const v = vars[name];
        if (v === undefined) throw new Error(`${key}: unknown placeholder ${m}`);
        return v;
      });
      files.set(key, text);
    }
  }
  for (const need of ["PRD.md", "policy.example.json", "package.json", "AGENTS.md", ".gitignore"]) {
    if (!files.has(need)) throw new Error(`ideas/${slug}: the assembled template has no ${need}`);
  }
  return files;
}
