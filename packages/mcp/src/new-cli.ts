import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assemble, getIdea, ideaUrl, listIdeas } from "./ideas.ts";
import { VERSION } from "./server.ts";

// `highwire new <idea> [dir]`: one of highwire.fun's launch ideas as a new project, the same files the idea's
// template repository has, for agents and people who'd rather not use GitHub's form. Writes only into an empty or new
// folder, runs git init, and never makes a wallet: `npm run setup` in the project does that, outside it.

const SITE_URL = "https://highwire.fun";

export const NEW_USAGE = `highwire new: start a project from one of highwire.fun's launch ideas (${SITE_URL}/ideas)

  highwire new                 list the ideas
  highwire new <idea> [dir]    write the idea's project into dir (default ./<idea>) and run git init
  --json                       the list, or what was written, as JSON

Then: cd into it, npm install && npm run setup, and ask your coding agent to read PRD.md and build milestone 1.
Everything is a dry run until you set "live": true in the project's policy yourself.`;

/**
 * Where the ideas are: shipped next to dist/ in the package (prepack copies them), or the repository's own ideas/
 * when running from source.
 */
export function bundledIdeasDir(): string {
  const fromSource = import.meta.url.endsWith(".ts");
  return fileURLToPath(new URL(fromSource ? "../../../ideas" : "../ideas", import.meta.url));
}

export interface NewIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** For tests: the ideas folder and the working directory. */
  ideasDir?: string;
  cwd?: string;
}

export async function runNew(argv: string[], io: NewIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: "boolean" }, help: { type: "boolean" } } });
  } catch (err) {
    io.err(`highwire new: ${(err as Error).message}\n\n${NEW_USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(NEW_USAGE);
    return 0;
  }
  const dir = io.ideasDir ?? bundledIdeasDir();
  const ideas = listIdeas(dir);
  const [slug, target] = positionals;
  if (positionals.length > 2) {
    io.err(`highwire new: takes an idea and, optionally, a folder\n\n${NEW_USAGE}`);
    return 2;
  }

  if (!slug) {
    if (values.json) {
      io.out(JSON.stringify(ideas.map((i) => ({ slug: i.slug, title: i.title, oneLiner: i.oneLiner, difficulty: i.difficulty, url: ideaUrl(SITE_URL, i.slug) })), null, 2));
      return 0;
    }
    const width = Math.max(...ideas.map((i) => i.slug.length));
    io.out(`Launch ideas (${SITE_URL}/ideas):\n`);
    for (const i of ideas) io.out(`  ${i.slug.padEnd(width)}  ${i.difficulty.padEnd(6)}  ${i.oneLiner}`);
    io.out(`\nStart one with: highwire new <idea>`);
    return 0;
  }

  const idea = getIdea(slug, dir);
  if (!idea) {
    io.err(`highwire new: there's no idea called ${slug}. The ideas: ${ideas.map((i) => i.slug).join(", ")}.`);
    return 1;
  }
  const cwd = io.cwd ?? process.cwd();
  const out = resolve(cwd, target ?? idea.slug);
  if (existsSync(out)) {
    if (!statSync(out).isDirectory()) {
      io.err(`highwire new: ${out} is a file. Pick a new folder.`);
      return 1;
    }
    if (readdirSync(out).length) {
      io.err(`highwire new: ${out} isn't empty, so nothing was written. Pick a new or empty folder.`);
      return 1;
    }
  }

  const files = assemble(idea.slug, { version: VERSION, siteUrl: SITE_URL, dir });
  for (const [rel, content] of files) {
    const path = join(out, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const git = spawnSync("git", ["init", "-q"], { cwd: out, encoding: "utf8" });
  const gitOk = git.status === 0;
  const rel = relative(cwd, out);
  const shown = !rel ? "." : rel.startsWith("..") ? out : rel;

  if (values.json) {
    io.out(JSON.stringify({ idea: idea.slug, dir: out, files: [...files.keys()].sort(), git: gitOk, next: [`cd ${shown}`, "npm install", "npm run setup"], prompt: idea.prompt }, null, 2));
    return 0;
  }
  io.out(`Wrote ${idea.title} to ${shown} (${files.size} files)${gitOk ? ", and ran git init" : "; git isn't available, so it isn't a repository yet"}.

Next:
  cd ${shown}
  npm install
  npm run setup      makes the agent's wallet in ~/.highwire/${idea.slug}/ and a dry-run policy

Then open it in your coding agent and say:
  ${idea.prompt}

The idea, with its costs and risks: ${ideaUrl(SITE_URL, idea.slug)}`);
  return 0;
}
