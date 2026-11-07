// The launch ideas' template repositories, from the repo's ideas/ folder. Run from apps/web:
//
//   npm run ideas -- assemble <slug> <dir>   write one idea's template into <dir>
//   npm run ideas -- check [slug]            assemble each template, npm install, typecheck, and run its setup against
//                                            a temporary HIGHWIRE_HOME (needs network for npm; sends nothing)
//   npm run ideas -- sync [--dry-run] [--message <text>]
//                                            create HigherMaestro/highwire-idea-<slug> if it's missing, mark it a
//                                            template, and push the assembled files when they changed. Needs GH_TOKEN
//                                            for HigherMaestro; never switches gh's account.
//
// Templates pin highwire-mcp and highwire-agent to packages/mcp's version: sync after every release.

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assemble, ideaUrl, listIdeas, TEMPLATE_OWNER, templateRepo } from "../lib/ideas.ts";
import { SITE_URL } from "../lib/site.ts";

const VERSION = (JSON.parse(readFileSync(join(process.cwd(), "../../packages/mcp/package.json"), "utf8")) as { version: string }).version;

function write(slug: string, out: string) {
  for (const [rel, content] of assemble(slug, { version: VERSION, siteUrl: SITE_URL })) {
    const path = join(out, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

function sh(cmd: string, args: string[], opts: SpawnSyncOptions = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { ok: r.status === 0, out: String(r.stdout ?? "").trim(), err: String(r.stderr ?? "").trim() };
}

function must(what: string, r: ReturnType<typeof sh>) {
  if (!r.ok) throw new Error(`${what} failed:\n${r.err || r.out}`);
  return r;
}

async function check(only?: string) {
  let failed = 0;
  for (const idea of listIdeas().filter((i) => !only || i.slug === only)) {
    const repo = mkdtempSync(join(tmpdir(), `highwire-idea-${idea.slug}-`));
    const home = mkdtempSync(join(tmpdir(), "highwire-idea-home-"));
    const env: NodeJS.ProcessEnv = { ...process.env, HIGHWIRE_HOME: home };
    delete env.HIGHWIRE_KEYPAIR_PATH;
    const rows: [string, boolean, string][] = [];
    const row = (what: string, ok: boolean, detail = "") => rows.push([what, ok, detail]);
    try {
      write(idea.slug, repo);
      const install = sh("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: repo, env });
      row("npm install", install.ok, install.ok ? "" : install.err.slice(-400));
      if (install.ok) {
        const tc = sh("npm", ["run", "typecheck"], { cwd: repo, env });
        row("typecheck", tc.ok, tc.ok ? "" : tc.out.slice(-400));
        const setup = sh("npm", ["run", "setup"], { cwd: repo, env });
        const policy = existsSync(join(home, "policy.json")) ? JSON.parse(readFileSync(join(home, "policy.json"), "utf8")) : null;
        row("setup makes a wallet and a dry-run policy outside the repository", setup.ok && existsSync(join(home, "wallet.json")) && policy?.live === false, setup.ok ? "" : setup.err.slice(-400));
        const again = sh("npm", ["run", "setup"], { cwd: repo, env });
        row("setup again keeps both", again.ok && /Kept the policy/.test(again.out) && /already/i.test(again.out + again.err));
        const agent = sh("npm", ["run", "agent"], { cwd: repo, env });
        row("the agent's loop runs for that wallet", agent.ok && agent.out.includes("Running for "), agent.ok ? "" : agent.err.slice(-400));
        writeFileSync(
          join(repo, "src", "check-tools.ts"),
          'import { Highwire } from "./tools.ts";\nconst hw = await Highwire.connect();\nconst s = await hw.call<{ policy?: { live: boolean } }>("get_signer_status");\nconsole.log(JSON.stringify({ ok: s.ok, live: s.body.policy?.live }));\nawait hw.close();\n',
        );
        const tools = sh("npx", ["tsx", "src/check-tools.ts"], { cwd: repo, env });
        row("src/tools.ts calls Highwire's tools for that wallet", tools.ok && tools.out.includes('{"ok":true,"live":false}'), tools.ok ? tools.out.slice(-300) : tools.err.slice(-400));
        rmSync(join(repo, "src", "check-tools.ts"));
        // npm start, for a few seconds: both halves start for this wallet, as a dry run, with the RPC from .env.
        writeFileSync(join(repo, ".env"), "SOLANA_RPC_URL=https://api.mainnet-beta.solana.com\n");
        const startEnv = { ...env };
        delete startEnv.SOLANA_RPC_URL;
        const start = spawnSync(join(repo, "node_modules", ".bin", "tsx"), ["src/start.ts"], { cwd: repo, env: startEnv, encoding: "utf8", timeout: 20_000, killSignal: "SIGTERM" });
        const startOut = `${start.stdout ?? ""}${start.stderr ?? ""}`;
        row(
          "npm start runs the order runner and the loop, as a dry run, with .env's RPC",
          /The policy is a dry run/.test(startOut) && /Filling orders for \S+ on mainnet, dry run/.test(startOut) && !/public RPC/.test(startOut),
          startOut.slice(-400),
        );
        rmSync(join(repo, ".env"));
        const help = sh("npm", ["run", "highwire", "--", "--help"], { cwd: repo, env });
        row("npm run highwire reaches Highwire's command line", help.ok && help.out.includes("highwire post"));
        writeFileSync(join(repo, "oops-keypair.json"), JSON.stringify(Array.from({ length: 64 }, (_, i) => i)));
        const refused = sh("npm", ["run", "setup"], { cwd: repo, env });
        row("setup refuses with a keypair file in the repository", !refused.ok && /looks like a wallet key/.test(refused.err));
        const inside = sh("npm", ["run", "setup"], { cwd: repo, env: { ...env, HIGHWIRE_HOME: join(repo, ".highwire") } });
        row("setup refuses a HIGHWIRE_HOME inside the repository", !inside.ok && /inside this repository/.test(inside.err));
      }
    } catch (err) {
      row("assemble", false, (err as Error).message);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
    for (const [what, ok, detail] of rows) {
      console.log(`${ok ? "ok  " : "FAIL"} [${idea.slug}] ${what}${detail ? `\n${detail}` : ""}`);
      if (!ok) failed++;
    }
  }
  if (failed) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
  }
}

/**
 * Who the templates' commits are by. The clone is a temporary folder, outside this repository's own git config, so
 * without this git would sign them with whatever global identity this machine has.
 */
const TEMPLATE_AUTHOR = { name: "HigherMaestro", email: "352895193+HigherMaestro@users.noreply.github.com" };

function sync(dryRun: boolean, message: string) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("Set GH_TOKEN to a token for HigherMaestro (gh auth token --user HigherMaestro). This never switches gh's account.");
  // The token reaches git through the environment, never the command line.
  const git = (args: string[], cwd?: string) =>
    sh("git", ["-c", "credential.helper=", "-c", `credential.helper=!f() { echo username=${TEMPLATE_OWNER}; echo "password=$GH_TOKEN"; }; f`, ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: TEMPLATE_AUTHOR.name,
        GIT_AUTHOR_EMAIL: TEMPLATE_AUTHOR.email,
        GIT_COMMITTER_NAME: TEMPLATE_AUTHOR.name,
        GIT_COMMITTER_EMAIL: TEMPLATE_AUTHOR.email,
      },
    });
  for (const idea of listIdeas()) {
    const name = templateRepo(idea.slug);
    const full = `${TEMPLATE_OWNER}/${name}`;
    const exists = sh("gh", ["api", `repos/${full}`, "--jq", ".is_template"]);
    if (!exists.ok) {
      console.log(`${full}: missing${dryRun ? " (would create it as a public template)" : ", creating it"}`);
      if (dryRun) continue;
      must("gh repo create", sh("gh", ["repo", "create", full, "--public", "--description", idea.oneLiner.slice(0, 340), "--homepage", ideaUrl(SITE_URL, idea.slug)]));
    }
    if (exists.out !== "true" && !dryRun) must("gh repo edit --template", sh("gh", ["repo", "edit", full, "--template"]));

    const work = mkdtempSync(join(tmpdir(), `${name}-`));
    try {
      const url = `https://github.com/${full}.git`;
      const cloned = git(["clone", "--quiet", url, work]);
      if (!cloned.ok) must("git init", git(["init", "--quiet", "-b", "main", work]));
      for (const entry of readdirSync(work)) if (entry !== ".git") rmSync(join(work, entry), { recursive: true, force: true });
      write(idea.slug, work);
      must("git add", git(["add", "-A"], work));
      const changed = git(["status", "--porcelain"], work).out;
      if (!changed) {
        console.log(`${full}: up to date`);
        continue;
      }
      console.log(`${full}: ${changed.split("\n").length} file(s) changed${dryRun ? " (dry run: not pushed)" : ""}`);
      if (dryRun) continue;
      must("git commit", git(["commit", "--quiet", "-m", message.replace("{version}", VERSION)], work));
      const who = git(["log", "-1", "--format=%an <%ae> / %cn <%ce>"], work).out;
      const expected = `${TEMPLATE_AUTHOR.name} <${TEMPLATE_AUTHOR.email}>`;
      if (who !== `${expected} / ${expected}`) throw new Error(`${full}: the commit is by ${who}, not ${expected}, so nothing was pushed`);
      must("git push", git(["push", "--quiet", url, "HEAD:main"], work));
      console.log(`${full}: pushed`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "assemble" && rest[0] && rest[1]) {
    write(rest[0], rest[1]);
    console.log(`Wrote ${rest[0]}'s template to ${rest[1]}`);
  } else if (cmd === "check") {
    await check(rest[0]);
  } else if (cmd === "sync") {
    const i = rest.indexOf("--message");
    sync(rest.includes("--dry-run"), i >= 0 && rest[i + 1] ? rest[i + 1]! : "Sync from Highwire {version}");
  } else {
    console.error("usage: npm run ideas -- assemble <slug> <dir> | check [slug] | sync [--dry-run] [--message <text>]");
    process.exit(2);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
