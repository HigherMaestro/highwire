import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROGRAM_INPUTS, touchesProgram } from "./changes.mjs";
import { AUDITED, decide, LABEL } from "./freeze.mjs";

// CI's two helpers (docs/boundaries.md 5.4, 5.5): which pushes need the program's tests, and the audit freeze.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

/** A throwaway repository; every git command runs inside it, never in this one. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "highwire-ci-"));
  assert.ok(!dir.startsWith(root), "the throwaway repository is outside this one");
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const write = (file, text) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  const commit = (message) => {
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const run = (script, env) => {
    const full = { ...process.env, ...env };
    delete full.GITHUB_OUTPUT;
    return spawnSync(process.execPath, [join(here, script)], { cwd: dir, encoding: "utf8", env: full });
  };
  git("init", "-q");
  write("programs/line-wager/src/lib.rs", "one");
  write("programs/line-wager/tests/program.rs", "one");
  write("apps/web/app/page.tsx", "one");
  return { git, write, commit, run, base: commit("base") };
}

test("the program's tests run when the program, the rules, the codec, the fixtures or CI changed", () => {
  for (const f of ["programs/line-wager/src/rules.rs", "programs/line-wager/Cargo.lock", "packages/core/src/arena/rules.ts", "packages/core/src/arena/series.ts", "packages/wager/src/codec.ts", "packages/core/scripts/wager-fixtures.ts", "packages/wager/scripts/wager-instructions.ts", "packages/core/test/fixtures/wager-codec.json", "package.json", "package-lock.json", ".github/workflows/ci.yml", ".github/scripts/changes.mjs"]) {
    assert.equal(touchesProgram([f]), true, f);
    assert.equal(touchesProgram(["README.md", f]), true, `${f}, mixed`);
  }
  for (const f of ["README.md", "apps/web/app/page.tsx", "packages/core/src/tx/decode.ts", "packages/wager/src/tools.ts", "packages/mcp/src/server.ts", "docs/wager-mode.md", "xprograms/a.rs", "packages/core/src/arena.ts"]) assert.equal(touchesProgram([f]), false, f);
  assert.equal(touchesProgram([]), false);
  assert.ok(PROGRAM_INPUTS.length > 0);
});

test("as CI runs it: what this branch changed since its base, and the program's tests whenever that can't be known", () => {
  const r = repo();
  r.write("apps/web/app/page.tsx", "two");
  r.commit("site");
  assert.match(r.run("changes.mjs", { BASE: r.base }).stdout, /program=false/);
  r.write("programs/line-wager/src/lib.rs", "two");
  r.commit("program");
  assert.match(r.run("changes.mjs", { BASE: r.base }).stdout, /program=true/);
  for (const BASE of ["", "0".repeat(40), "f".repeat(40), "main", "--output=/tmp/x", "HEAD; echo hi"]) assert.match(r.run("changes.mjs", { BASE }).stdout, /program=true/, JSON.stringify(BASE));
});

test("the freeze: nothing is frozen without an audit tag; after one, a change to what was sent needs the label", () => {
  const tags = ["audit/line-wager-1"];
  assert.equal(decide({ tags: [], files: ["programs/line-wager/src/processor.rs"], labels: [] }).ok, true);
  assert.equal(decide({ tags, files: ["apps/web/app/page.tsx", "programs/line-wager/tests/program.rs", "packages/wager/src/codec.ts"], labels: [] }).ok, true, "tests and the client aren't what was sent");
  for (const f of ["programs/line-wager/src/processor.rs", "programs/line-wager/src/rules.rs", "programs/line-wager/Cargo.toml", "programs/line-wager/Cargo.lock"]) {
    const refused = decide({ tags, files: ["README.md", f], labels: ["bug"] });
    assert.equal(refused.ok, false, f);
    assert.match(refused.why, new RegExp(LABEL));
    assert.ok(refused.why.includes(f));
    assert.equal(decide({ tags, files: [f], labels: ["bug", LABEL] }).ok, true, `${f}, with the label`);
  }
  assert.ok(AUDITED.every((re) => !re.test("programs/line-wager/tests/program.rs")));
});

test("as CI runs it: the freeze reads the tags, the pull request's own changes and its labels", () => {
  const r = repo();
  r.write("programs/line-wager/src/lib.rs", "two");
  r.commit("program");
  const labelled = JSON.stringify([LABEL]);
  // No audit tag: nothing is frozen.
  assert.equal(r.run("freeze.mjs", { BASE: r.base, LABELS: "[]" }).status, 0);
  // Tagged: the same change is flagged, and the label settles it.
  r.git("tag", "audit/line-wager-1", r.base);
  const flagged = r.run("freeze.mjs", { BASE: r.base, LABELS: "[]" });
  assert.equal(flagged.status, 1);
  assert.match(flagged.stdout, /::error::this changes what the auditors were sent \(audit\/line-wager-1\)/);
  assert.equal(r.run("freeze.mjs", { BASE: r.base, LABELS: labelled }).status, 0);
  // A pull request that leaves the program alone passes, tag or not.
  const head = r.git("rev-parse", "HEAD");
  r.write("apps/web/app/page.tsx", "two");
  r.commit("site");
  assert.equal(r.run("freeze.mjs", { BASE: head, LABELS: "[]" }).status, 0);
  // A base it can't compare with, or labels it can't read, never passes by default once there's a tag.
  assert.equal(r.run("freeze.mjs", { BASE: "", LABELS: "[]" }).status, 1);
  assert.equal(r.run("freeze.mjs", { BASE: head, LABELS: "not json" }).status, 0, "the site-only change is fine whatever the labels");
  r.write("programs/line-wager/src/lib.rs", "three");
  r.commit("program again");
  assert.equal(r.run("freeze.mjs", { BASE: head, LABELS: "not json" }).status, 1);
  // Another tag that only looks like an audit tag doesn't freeze anything.
  const other = repo();
  other.write("programs/line-wager/src/lib.rs", "two");
  other.commit("program");
  other.git("tag", "v0.15.0", other.base);
  other.git("tag", "audit-line-wager-1", other.base);
  assert.equal(other.run("freeze.mjs", { BASE: other.base, LABELS: "[]" }).status, 0);
});

test("the workflow pins every action to a commit, holds no secret and never deploys or publishes", () => {
  const yml = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const uses = [...yml.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 5);
  for (const u of uses) assert.match(u, /^actions\/[a-z-]+@[0-9a-f]{40}$/, `${u} isn't pinned to a commit`);
  const code = yml.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(code, /secrets\.|npm publish|vercel|deploy|pull_request_target|workflow_run/i);
  assert.match(yml, /permissions:\n  contents: read/);
  // Event data reaches a script through the environment, never pasted into the command.
  for (const m of yml.matchAll(/run:\s*(?:\|\n((?:\s{10,}.*\n)+)|(.*))/g)) assert.doesNotMatch(m[1] ?? m[2] ?? "", /\$\{\{\s*github\./, "event data inside a run command");
});
