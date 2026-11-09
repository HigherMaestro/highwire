import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PolicySchema } from "highwire-agent";
import { getModule, listModules, moduleFiles, moduleSpecPath, moduleUrl, policyGaps } from "./ideas.ts";
import { bundledIdeasDir } from "./new-cli.ts";

// `highwire add <module> [dir]`: one of highwire.fun's modules, copied into a project made from a launch idea. Writes
// only files that aren't there yet (or are already the same), adds the package.json scripts the module needs when the
// project has none of that name, and says what the policy still needs.
//
// When a person runs it at a terminal and the module needs a policy action that moves no money (ASKABLE_ACTIONS:
// "register", one memo for the network fee), it asks them whether to add it, so joining needs no hand edit. The change
// waits for a typed yes. It never asks without a terminal or with --json, never adds an action that trades, launches,
// claims or transfers, never touches "live" or a limit, and no MCP tool can reach it.

const SITE_URL = "https://highwire.fun";

export const ADD_USAGE = `highwire add: add a module to a project made from a launch idea (${SITE_URL}/ideas#modules)

  highwire add                   list the modules
  highwire add <module> [dir]    copy the module into dir (default: here), then say how to wire it in
                                 and what your policy needs
  --json                         the list, or what was written, as JSON
  --no-ask                       don't ask anything; just say what's left

It never overwrites a file. If the module needs a policy action that moves no money (like "register"), at a terminal
it asks whether to add it; nothing else in your policy changes. Run it again any time to answer.`;

/** The policy actions `highwire add` may offer to add on a person's yes: ones that move no money. Anything else is a hand edit. */
export const ASKABLE_ACTIONS = ["register"];

export interface AddIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** For tests: the ideas folder, the working directory and the environment. */
  ideasDir?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Asks a person a question at a terminal and returns their answer. Absent when no one is there to answer. */
  ask?: (question: string) => Promise<string>;
}

const yes = (answer: string) => /^\s*y(es)?\s*$/i.test(answer);

/** Adds actions to the policy file, changing nothing else in it, and only if the result is still a valid policy. */
export function addPolicyActions(path: string, actions: string[]): void {
  const text = readFileSync(path, "utf8");
  const raw = JSON.parse(text) as { actions?: string[] };
  const have = raw.actions ?? [];
  const next = { ...raw, actions: [...have, ...actions.filter((a) => !have.includes(a))] };
  const parsed = PolicySchema.safeParse(next);
  if (!parsed.success) throw new Error(`the policy wouldn't be valid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  writeJson(path, next, text);
}

/** Writes JSON in the old file's indentation and mode, through a temporary file so a crash never leaves half of it. */
function writeJson(path: string, value: unknown, old: string): void {
  const indent = /^\s*\{\n(\s+)/.exec(old)?.[1]?.length ?? 2;
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, indent) + "\n", { mode: statSync(path).mode & 0o777 });
  renameSync(tmp, path);
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
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: "boolean" }, help: { type: "boolean" }, "no-ask": { type: "boolean" } } });
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
  let gaps: string[] | null = null;  // what the policy still needs, or null when there's no policy yet
  try {
    gaps = policyGaps(mod.needs, JSON.parse(readFileSync(policyPath, "utf8")));
  } catch {
    gaps = null;
  }
  const spec = moduleSpecPath(mod.slug);

  // What waits on the owner: the actions they may add here.
  const askable = (): string[] => {
    if (gaps === null) return [];
    const have = (JSON.parse(readFileSync(policyPath, "utf8")) as { actions?: string[] }).actions ?? [];
    return (mod.needs.actions ?? []).filter((a) => ASKABLE_ACTIONS.includes(a) && !have.includes(a));
  };
  const asked: string[] = [];
  if (io.ask && !values.json && !values["no-ask"]) {
    const missing = askable();
    if (missing.length) {
      const list = missing.map((a) => `"${a}"`).join(", ");
      const answer = await io.ask(`Your policy (${policyPath}) doesn't allow ${list} yet, which ${mod.title} needs (it moves no money: one memo, the network fee only). Add it? [y/N] `);
      if (yes(answer)) {
        addPolicyActions(policyPath, missing);
        asked.push(`Added ${list} to your policy's actions. Nothing else in it changed.`);
        gaps = policyGaps(mod.needs, JSON.parse(readFileSync(policyPath, "utf8")));
      } else asked.push(`Left your policy as it was.`);
    }
  }
  const waiting = askable();

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
    ...asked,
    ...(waiting.length && !asked.length
      ? [`To add ${waiting.map((a) => `"${a}"`).join(", ")} without editing the file: run \`npx highwire-mcp add ${mod.slug}\` yourself, in a terminal, and answer y.`]
      : []),
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
