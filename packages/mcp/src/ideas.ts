import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Launch ideas: the repo's ideas/ folder, shipped in this package for `highwire new`, and read by the site for
// /ideas. Each idea is ideas/<slug>/ (idea.json, PRD.md, policy.example.json, anything else the template needs), laid
// over ideas/starter/, the skeleton every template gets. docs/ideas-prd.md is the spec. Every function takes the
// folder, since the site and the command line find it in different places.

export const TEMPLATE_OWNER = "HigherMaestro";
export const templateRepo = (slug: string) => `highwire-idea-${slug}`;

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export const CALCULATORS = ["buyback", "compute", "trading", "treasury", "line"] as const;

export interface Idea {
  slug: string;
  title: string;
  oneLiner: string;
  difficulty: (typeof DIFFICULTIES)[number];
  solToStart: string;
  uses: string[];
  outside: string[];
  howItWorks: string[];
  /** The loop in three or four short steps, each a few words starting with a verb, for the link preview. */
  loop: string[];
  earns: string;
  costs: string[];
  needs: string[];
  risks: string[];
  milestones: { title: string; summary: string }[];
  /** What to paste into a coding agent in the new repository. */
  prompt: string;
  /** Which calculator the page shows. */
  calculator: (typeof CALCULATORS)[number];
  /** Roughly how long from Deploy to a first dry run, for someone following the steps. */
  minutesToDryRun: number;
  /** A sample of how the agent runs, step by step. */
  day: { at: string; text: string }[];
  /** One line on each top-level key of policy.example.json. */
  policyNotes: Record<string, string>;
  faq: { q: string; a: string }[];
}

/** The PRD sections every idea has, in this order, so coding agents learn the shape once. */
export const PRD_SECTIONS = ["Summary", "The loop", "Policy", "Milestones", "Outside services", "Rules", "Out of scope"];

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A loop step's longest, so it fits on the idea's card. */
export const LOOP_STEP_MAX = 18;

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
      loop: ((): string[] => {
        const loop = strs(o.loop, "loop", 3);
        if (loop.length > 4 || loop.some((s) => s.length > LOOP_STEP_MAX)) throw new Error(`loop must be three or four steps of at most ${LOOP_STEP_MAX} characters`);
        return loop;
      })(),
      earns: str(o.earns, "earns", 800),
      costs: strs(o.costs, "costs", 1),
      needs: strs(o.needs, "needs", 1),
      risks: strs(o.risks, "risks", 1),
      milestones,
      prompt: str(o.prompt, "prompt", 400),
      calculator: ((): Idea["calculator"] => {
        if (!CALCULATORS.includes(o.calculator as Idea["calculator"])) throw new Error(`calculator must be one of ${CALCULATORS.join(", ")}`);
        return o.calculator as Idea["calculator"];
      })(),
      minutesToDryRun: ((): number => {
        const n = o.minutesToDryRun;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 240) throw new Error("minutesToDryRun must be whole minutes");
        return n;
      })(),
      day: ((): Idea["day"] => {
        if (!Array.isArray(o.day) || o.day.length < 1) throw new Error("day must be a list");
        return o.day.map((d: unknown, i) => {
          const dd = (d ?? {}) as Record<string, unknown>;
          return { at: str(dd.at, `day[${i}].at`, 40), text: str(dd.text, `day[${i}].text`) };
        });
      })(),
      policyNotes: ((): Record<string, string> => {
        const n = o.policyNotes;
        if (!n || typeof n !== "object" || Array.isArray(n)) throw new Error("policyNotes must be an object");
        return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, str(v, `policyNotes.${k}`, 300)]));
      })(),
      faq: ((): Idea["faq"] => {
        if (!Array.isArray(o.faq) || o.faq.length < 1) throw new Error("faq must be a list");
        return o.faq.map((f: unknown, i) => {
          const ff = (f ?? {}) as Record<string, unknown>;
          return { q: str(ff.q, `faq[${i}].q`, 200), a: str(ff.a, `faq[${i}].a`) };
        });
      })(),
    };
  } catch (err) {
    throw new Error(`ideas/${dirName}/idea.json: ${(err as Error).message}`);
  }
}

const ORDER = { easy: 0, medium: 1, hard: 2 };

/** Every idea in `dir`, easiest first. The starter isn't one. */
export function listIdeas(dir: string): Idea[] {
  return readdirSync(dir)
    .filter((name) => name !== "starter" && existsSync(join(dir, name, "idea.json")))
    .map((name) => validateIdea(JSON.parse(readFileSync(join(dir, name, "idea.json"), "utf8")), name))
    .sort((a, b) => ORDER[a.difficulty] - ORDER[b.difficulty] || a.title.localeCompare(b.title));
}

export function getIdea(slug: string, dir: string): Idea | null {
  return listIdeas(dir).find((i) => i.slug === slug) ?? null;
}

export function readPrd(slug: string, dir: string): string {
  return readFileSync(join(dir, slug, "PRD.md"), "utf8");
}

export const ideaUrl = (siteUrl: string, slug: string) => `${siteUrl}/ideas/${slug}`;

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
 * The starter keeps its .gitignore as `gitignore`, since npm leaves .gitignore files out of packages.
 */
export function assemble(slug: string, opts: { version: string; siteUrl: string; dir: string }): Map<string, Buffer | string> {
  const { dir } = opts;
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
      const key = rel.split("\\").join("/").replace(/(^|\/)gitignore$/, "$1.gitignore");
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

// Modules: one capability to add to an agent that already runs, such as buying the dips or a kill switch. Each is
// ideas/modules/<slug>/: module.json (what the site shows), MODULE.md (the spec a coding agent follows to wire it in)
// and files/, working code copied into the project as is by `highwire add <module>`. Module code imports only the
// starter's own files (src/highwire.ts, src/tools.ts) and Highwire's packages, so it fits any project made from an idea.

export interface ModuleNeeds {
  /** Policy actions it signs with. */
  actions?: string[];
  /** Standing-order kinds it places. */
  orderKinds?: string[];
  /** Orders it keeps open at once, beyond the agent's own. */
  openOrders?: number;
  /** It posts on the agent's own coin. */
  posts?: boolean;
}

export interface Module {
  slug: string;
  title: string;
  oneLiner: string;
  /** Three or four short steps, for the link preview. */
  loop: string[];
  uses: string[];
  /** The agents (idea slugs) it fits. */
  worksWith: string[];
  howItWorks: string[];
  /** What it needs from the policy; the user adds it. */
  needs: ModuleNeeds;
  /** Its settings file, in files/, with one line on each key. */
  settings: { file: string; notes: Record<string, string> } | null;
  /** package.json scripts it adds, when the project has none of that name. */
  scripts: Record<string, string>;
  /** How to call it from the agent's loop, step by step. */
  wire: string[];
  /** What to paste into a coding agent in the project. */
  prompt: string;
  risks: string[];
  /** Where it runs for real today, if anywhere. */
  liveOn?: string;
}

/** MODULE.md's sections, in this order. */
export const MODULE_SECTIONS = ["Summary", "How it works", "Policy", "Settings", "Wiring it in", "Rules", "Done when"];

export const modulesDir = (dir: string) => join(dir, "modules");

export function validateModule(raw: unknown, dirName: string): Module {
  if (!raw || typeof raw !== "object") throw new Error(`ideas/modules/${dirName}/module.json isn't an object`);
  const o = raw as Record<string, unknown>;
  try {
    const slug = str(o.slug, "slug", 60);
    if (!SLUG.test(slug) || slug !== dirName) throw new Error("slug must be the folder's name, lowercase words joined by -");
    const loop = strs(o.loop, "loop", 3);
    if (loop.length > 4 || loop.some((s) => s.length > LOOP_STEP_MAX)) throw new Error(`loop must be three or four steps of at most ${LOOP_STEP_MAX} characters`);
    const n = (o.needs ?? {}) as Record<string, unknown>;
    const needs: ModuleNeeds = {
      ...(n.actions !== undefined ? { actions: strs(n.actions, "needs.actions") } : {}),
      ...(n.orderKinds !== undefined ? { orderKinds: strs(n.orderKinds, "needs.orderKinds") } : {}),
      ...(n.openOrders !== undefined ? { openOrders: Number(n.openOrders) } : {}),
      ...(n.posts !== undefined ? { posts: n.posts === true } : {}),
    };
    if (needs.openOrders !== undefined && (!Number.isInteger(needs.openOrders) || needs.openOrders < 1)) throw new Error("needs.openOrders must be a whole number");
    const s = o.settings as Record<string, unknown> | null | undefined;
    const settings = s
      ? {
          file: str(s.file, "settings.file", 80),
          notes: Object.fromEntries(Object.entries((s.notes ?? {}) as Record<string, unknown>).map(([k, v]) => [k, str(v, `settings.notes.${k}`, 300)])),
        }
      : null;
    const scripts = Object.fromEntries(Object.entries((o.scripts ?? {}) as Record<string, unknown>).map(([k, v]) => [k, str(v, `scripts.${k}`, 200)]));
    return {
      slug,
      title: str(o.title, "title", 40),
      oneLiner: str(o.oneLiner, "oneLiner", 300),
      loop,
      uses: strs(o.uses, "uses", 1),
      worksWith: strs(o.worksWith, "worksWith", 1),
      howItWorks: strs(o.howItWorks, "howItWorks", 1),
      needs,
      settings,
      scripts,
      wire: strs(o.wire, "wire", 1),
      prompt: str(o.prompt, "prompt", 400),
      risks: strs(o.risks, "risks", 1),
      ...(o.liveOn !== undefined ? { liveOn: str(o.liveOn, "liveOn", 200) } : {}),
    };
  } catch (err) {
    throw new Error(`ideas/modules/${dirName}/module.json: ${(err as Error).message}`);
  }
}

/** Every module, by title. */
export function listModules(dir: string): Module[] {
  const root = modulesDir(dir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => existsSync(join(root, name, "module.json")))
    .map((name) => validateModule(JSON.parse(readFileSync(join(root, name, "module.json"), "utf8")), name))
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function getModule(slug: string, dir: string): Module | null {
  return listModules(dir).find((m) => m.slug === slug) ?? null;
}

export function readModuleSpec(slug: string, dir: string): string {
  return readFileSync(join(modulesDir(dir), slug, "MODULE.md"), "utf8");
}

/** Where a module's spec goes in the project, next to its code. */
export const moduleSpecPath = (slug: string) => `modules/${slug}.md`;

/** The files `highwire add` writes: files/ as is, and the spec at modules/<slug>.md. Paths use /. */
export function moduleFiles(slug: string, dir: string): Map<string, string> {
  const base = join(modulesDir(dir), slug, "files");
  const files = new Map<string, string>();
  for (const rel of walk(base)) files.set(rel.split("\\").join("/"), readFileSync(join(base, rel), "utf8"));
  files.set(moduleSpecPath(slug), readModuleSpec(slug, dir));
  return files;
}

/** The module as one markdown file, for coding agents without Highwire's command line: the spec, then every file. */
export function moduleMarkdown(slug: string, dir: string): string {
  const files = moduleFiles(slug, dir);
  files.delete(moduleSpecPath(slug));
  const fence = (path: string) => (path.endsWith(".json") ? "json" : path.endsWith(".ts") ? "ts" : "");
  const parts = [...files].map(([path, text]) => `### \`${path}\`\n\n\`\`\`\`${fence(path)}\n${text.trimEnd()}\n\`\`\`\`\n`);
  return `${readModuleSpec(slug, dir).trimEnd()}\n\n## The files\n\nWrite each one at its path in the project, as is. \`npx -y highwire-mcp add ${slug}\` does the same.\n\n${parts.join("\n")}`;
}

export const moduleUrl = (siteUrl: string, slug: string) => `${siteUrl}/modules/${slug}`;

/**
 * What a policy still needs for a module, as instructions for the user, or nothing. Reads the policy; never writes it.
 */
export function policyGaps(needs: ModuleNeeds, policy: { actions?: string[]; orders?: { kinds?: string[]; max_open?: number }; posts?: unknown }): string[] {
  const gaps: string[] = [];
  const missing = (needs.actions ?? []).filter((a) => !(policy.actions ?? []).includes(a));
  if (missing.length) gaps.push(`add ${missing.map((a) => `"${a}"`).join(", ")} to "actions"`);
  const kinds = (needs.orderKinds ?? []).filter((k) => !(policy.orders?.kinds ?? []).includes(k));
  if (kinds.length) {
    gaps.push(
      policy.orders
        ? `add ${kinds.map((k) => `"${k}"`).join(", ")} to "orders" → "kinds"${needs.openOrders ? `, and raise "max_open" by ${needs.openOrders}` : ""}`
        : `add "orders": { "kinds": [${kinds.map((k) => `"${k}"`).join(", ")}], "max_open": ${needs.openOrders ?? 1} }`,
    );
  }
  if (needs.posts && !policy.posts) gaps.push(`add "posts": { "comments": "own", "chat": false, "max_per_day": 3 }`);
  return gaps;
}
