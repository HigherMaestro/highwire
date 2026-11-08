import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getModule, listModules, moduleFiles, moduleSpecPath, moduleUrl, policyGaps } from "./ideas.ts";
import { bundledIdeasDir } from "./new-cli.ts";

// `highwire add <module> [dir]`: one of highwire.fun's modules, copied into a project made from a launch idea. Writes
// only files that aren't there yet (or are already the same), adds the package.json scripts the module needs when the
// project has none of that name, and says what the policy still needs. It reads the policy and never writes it.

const SITE_URL = "https://highwire.fun";

export const ADD_USAGE = `highwire add: add a module to a project made from a launch idea (${SITE_URL}/ideas#modules)

  highwire add                   list the modules
  highwire add <module> [dir]    copy the module into dir (default: here), then say how to wire it in
                                 and what your policy needs
  --json                         the list, or what was written, as JSON

It never overwrites a file and never changes your policy.`;

export interface AddIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** For tests: the ideas folder, the working directory and the environment. */
  ideasDir?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/** Where the project keeps its wallet and policy: what src/highwire.ts names, as the starter writes it. */
export function projectHome(dir: string, env: Record<string, string | undefined>): string {
  if (env.HIGHWIRE_HOME) return env.HIGHWIRE_HOME;
  const src = readFileSync(join(dir, "src", "highwire.ts"), "utf8");
  const name = /join\(homedir\(\), "\.highwire", "([^"]+)"\)/.exec(src)?.[1] ?? (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name ?? "";
  return join(homedir(), ".highwire", name);
}

export async function runAdd(argv: string[], io: AddIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: "boolean" }, help: { type: "boolean" } } });
  } catch (err) {
    io.err(`highwire add: ${(err as Error).message}\n\n${ADD_USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(ADD_USAGE);
    return 0;
  }
  if (positionals.length > 2) {
    io.err(`highwire add: takes a module and, optionally, a folder\n\n${ADD_USAGE}`);
    return 2;
  }
  const ideasDir = io.ideasDir ?? bundledIdeasDir();
  const modules = listModules(ideasDir);
  const [slug, target] = positionals;

  if (!slug) {
    if (values.json) {
      io.out(JSON.stringify(modules.map((m) => ({ slug: m.slug, title: m.title, oneLiner: m.oneLiner, worksWith: m.worksWith, url: moduleUrl(SITE_URL, m.slug) })), null, 2));
      return 0;
    }
    const width = Math.max(...modules.map((m) => m.slug.length));
    io.out(`Modules (${SITE_URL}/ideas#modules):\n`);
    for (const m of modules) io.out(`  ${m.slug.padEnd(width)}  ${m.oneLiner}`);
    io.out(`\nAdd one to your project with: highwire add <module>`);
    return 0;
  }

  const mod = getModule(slug, ideasDir);
  if (!mod) {
    io.err(`highwire add: there's no module called ${slug}. The modules: ${modules.map((m) => m.slug).join(", ")}.`);
    return 1;
  }
  const cwd = io.cwd ?? process.cwd();
  const dir = resolve(cwd, target ?? ".");
  if (!existsSync(join(dir, "package.json")) || !existsSync(join(dir, "src", "highwire.ts"))) {
    io.err(`highwire add: ${dir} isn't a project made from a launch idea (it needs package.json and src/highwire.ts). Start one with \`highwire new\`.`);
    return 1;
  }

  const files = moduleFiles(mod.slug, ideasDir);
  const clash: string[] = [];
  const same: string[] = [];
  for (const [rel, content] of files) {
    const path = join(dir, rel);
    if (!existsSync(path)) continue;
    if (readFileSync(path, "utf8") === content) same.push(rel);
    else clash.push(rel);
  }
  if (clash.length) {
    io.err(`highwire add: ${clash.join(", ")} already ${clash.length === 1 ? "exists" : "exist"} with other contents, so nothing was written. Move ${clash.length === 1 ? "it" : "them"} aside and run it again.`);
    return 1;
  }
  const written: string[] = [];
  for (const [rel, content] of files) {
    if (same.includes(rel)) continue;
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    written.push(rel);
  }

  const pkgPath = join(dir, "package.json");
  const pkgText = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string> };
  const added: string[] = [];
  const kept: string[] = [];
  for (const [name, cmd] of Object.entries(mod.scripts)) {
    if (pkg.scripts?.[name] === undefined) {
      pkg.scripts = { ...pkg.scripts, [name]: cmd };
      added.push(name);
    } else if (pkg.scripts[name] !== cmd) kept.push(name);
  }
  if (added.length) writeFileSync(pkgPath, JSON.stringify(pkg, null, /^\s*\{\n(\s+)/.exec(pkgText)?.[1]?.length ?? 2) + "\n");

  const home = projectHome(dir, io.env ?? process.env);
  const policyPath = join(home, "policy.json");
  let gaps: string[] | null = null;
  try {
    gaps = policyGaps(mod.needs, JSON.parse(readFileSync(policyPath, "utf8")));
  } catch {
    gaps = null;
  }
  const spec = moduleSpecPath(mod.slug);

  if (values.json) {
    io.out(JSON.stringify({ module: mod.slug, dir, written, unchanged: same, scriptsAdded: added, scriptsKept: kept, policy: policyPath, policyNeeds: gaps, wire: mod.wire, prompt: mod.prompt }, null, 2));
    return 0;
  }
  const relPath = relative(cwd, dir);
  const rel = !relPath ? "." : relPath.startsWith("..") ? dir : relPath;
  const lines = [
    written.length ? `Added ${mod.title} to ${rel}: ${written.join(", ")}.` : `${mod.title} is already in ${rel}: nothing to write.`,
    ...(added.length ? [`Added to package.json's scripts: ${added.join(", ")}.`] : []),
    ...(kept.length ? [`Kept your own ${kept.join(", ")} script${kept.length === 1 ? "" : "s"}; the module's would be: ${kept.map((k) => `"${mod.scripts[k]}"`).join(", ")}.`] : []),
    "",
    gaps === null
      ? `Your policy: none found at ${policyPath}. ${policyGaps(mod.needs, {}).length ? `The module needs: ${policyGaps(mod.needs, {}).join("; ")}.` : "The module needs nothing from it."}`
      : gaps.length
        ? `Your policy (${policyPath}) still needs, and only you can change it: ${gaps.join("; ")}.`
        : `Your policy (${policyPath}) already allows what the module needs.`,
    "",
    "Wire it in (the full spec is " + spec + "):",
    ...mod.wire.map((w, i) => `  ${i + 1}. ${w}`),
    "",
    "Or open the project in your coding agent and say:",
    `  ${mod.prompt}`,
    "",
    `The module, with its risks: ${moduleUrl(SITE_URL, mod.slug)}`,
  ];
  io.out(lines.join("\n"));
  return 0;
}
