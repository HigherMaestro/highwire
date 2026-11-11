import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Vercel's ignored build step (scripts/ignore-build.mjs, docs/boundaries.md 5.3): exit 0 skips a deployment, exit 1
// builds. It must skip only what the site can't see, and build whenever it isn't sure.

const web = fileURLToPath(new URL("..", import.meta.url));
const root = join(web, "../..");
const script = join(web, "scripts/ignore-build.mjs");
const SKIP = 0, BUILD = 1;

/** The script's decision for a list of changed paths. */
const decide = (...files: string[]) => spawnSync(process.execPath, [script, "--files", ...files], { encoding: "utf8" }).status;

test("a push the site can't see is skipped: the program, research notes, a package's tests or scripts", () => {
  assert.equal(decide("programs/line-wager/src/processor.rs"), SKIP);
  assert.equal(decide("programs/line-wager/Cargo.lock", "programs/line-wager/tests/program.rs"), SKIP);
  assert.equal(decide("docs/research/new-games.md"), SKIP);
  assert.equal(decide("packages/core/test/arena.test.ts", "packages/wager/test/fixtures/x.json"), SKIP);
  assert.equal(decide("packages/core/scripts/games-sim.ts", "packages/wager/scripts/wager-admin.ts"), SKIP);
  assert.equal(decide(".github/workflows/ci.yml", ".github/scripts/freeze.mjs"), SKIP);
});

test("anything the site reads or might read builds, alone or beside skippable files", () => {
  for (const file of [
    "CHANGELOG.md", // the changelog page and the home page's "What's new"
    "ideas/line-fighter/PRD.md", // the idea pages
    "packages/mcp/package.json", // the version the idea pages show
    "packages/core/src/arena/rules.ts",
    "packages/wager/src/history.ts",
    "packages/relay/src/arena/wager.ts",
    "apps/web/app/page.tsx",
    "apps/web/public/line.md",
    "apps/web/vercel.json",
    "apps/web/scripts/ignore-build.mjs", // the rule itself
    "apps/web/test/pages.test.ts", // the site's own tests aren't a package's
    "package.json",
    "package-lock.json",
    "tsconfig.base.json",
    "docs/wager-mode.md", // only research notes are skipped
    "AGENTS.md",
    "tools/ledger/package.json",
    "ideas/starter/scripts/launch.ts", // a scripts folder that isn't a package's
    "packages/core/tests/x.ts", // not the test folder
    "packages/scripts/x.ts", // not inside a package
    "apps/web/public/thing.rs", // a file type is never skipped by itself
    "programs", // not under the folder
    "apps/web/.github/x.yml", // not the repository's own
  ]) {
    assert.equal(decide(file), BUILD, file);
    assert.equal(decide("programs/line-wager/src/lib.rs", file, "docs/research/new-games.md"), BUILD, `${file}, mixed`);
  }
  // Paths that only look like the skippable ones.
  assert.equal(decide("apps/web/programs/x.ts"), BUILD);
  assert.equal(decide("xprograms/x.ts"), BUILD);
  assert.equal(decide("docs/research.md"), BUILD);
});

test("nothing changed is a redeploy asked for on purpose, and it builds", () => {
  assert.equal(decide(), BUILD);
});

/** This process's environment with Vercel's "last deployed commit" set to `previous`, or absent. */
function envWith(previous: string | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.VERCEL_GIT_PREVIOUS_SHA;
  if (previous !== undefined) env.VERCEL_GIT_PREVIOUS_SHA = previous;
  return env;
}

/** A throwaway repository shaped like this one, with one commit; returns its apps/web and that commit. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "highwire-ignore-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  const commit = (message: string) => {
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  write("apps/web/app/page.tsx", "one");
  write("programs/line-wager/src/lib.rs", "one");
  write("CHANGELOG.md", "one");
  const first = commit("first");
  const run = (previous: string | undefined) =>
    spawnSync(process.execPath, [script], { cwd: join(dir, "apps/web"), encoding: "utf8", env: envWith(previous) }).status;
  // Every git command here runs in the throwaway folder, never in this repository.
  assert.ok(dir.startsWith(tmpdir()) || dir.includes("highwire-ignore-"));
  return { git, write, commit, run, first };
}

test("as Vercel runs it: compared with the last deployed commit, from apps/web, over every commit since", () => {
  const r = repo();
  // Two commits since the last deployment, both to the program: judged together, skipped.
  r.write("programs/line-wager/src/lib.rs", "two");
  r.commit("program");
  r.write("programs/line-wager/src/state.rs", "new");
  r.commit("program again");
  assert.equal(r.run(r.first), SKIP);
  // A third touches the changelog: the whole push builds, though its last commit alone would not.
  r.write("CHANGELOG.md", "two");
  const withChangelog = r.commit("changelog");
  r.write("programs/line-wager/src/lib.rs", "three");
  r.commit("program once more");
  assert.equal(r.run(r.first), BUILD);
  // Against the commit that had the changelog, only the program changed since.
  assert.equal(r.run(withChangelog), SKIP);
  // A file moved out of a skippable folder into the site counts as a change to the site.
  const beforeMove = r.git("rev-parse", "HEAD");
  r.git("mv", "programs/line-wager/src/state.rs", "apps/web/app/state.rs");
  r.commit("moved into the site");
  assert.equal(r.run(beforeMove), BUILD);
});

test("as Vercel runs it: when it can't tell, it builds", () => {
  const r = repo();
  r.write("programs/line-wager/src/lib.rs", "two");
  const head = r.commit("program");
  assert.equal(r.run(undefined), BUILD, "the first deployment of a branch");
  assert.equal(r.run(""), BUILD);
  assert.equal(r.run("0123456789abcdef0123456789abcdef01234567"), BUILD, "a commit that isn't in the clone");
  assert.equal(r.run("main; rm -rf /"), BUILD, "not a commit id: never passed to a shell");
  assert.equal(r.run("--output=/tmp/x"), BUILD);
  assert.equal(r.run(head), BUILD, "the same commit again: a redeploy");
  // Outside a repository altogether.
  assert.equal(spawnSync(process.execPath, [script], { cwd: tmpdir(), encoding: "utf8", env: envWith(r.first) }).status, BUILD);
});

test("the skip list really is outside what the site reads", () => {
  // Every file the site's code imports or reads from outside apps/web, by the paths its sources name.
  const outside = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next" || name === "test" || name === "scripts") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|json)$/.test(name)) for (const m of readFileSync(p, "utf8").matchAll(/["'`]((?:\.\.\/)+)((?:packages|programs|docs|ideas|tools)\/[^"'`]*|[A-Z][A-Za-z_.-]*\.md)["'`]/g)) outside.add(m[2]!);
    }
  };
  walk(web);
  assert.ok(outside.has("CHANGELOG.md") && [...outside].some((p) => p.startsWith("packages/")), `found: ${[...outside].join(", ")}`);
  for (const p of outside) assert.equal(decide(p), BUILD, `${p} is read by the site but would be skipped`);
  // And vercel.json points at the script.
  assert.equal(JSON.parse(readFileSync(join(web, "vercel.json"), "utf8")).ignoreCommand, "node scripts/ignore-build.mjs");
  assert.ok(statSync(join(root, "programs")).isDirectory());
});
