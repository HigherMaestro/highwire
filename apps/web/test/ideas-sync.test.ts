import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// `npm run ideas -- sync` against a fake `gh` on PATH: it must stop on a token GitHub turns down, or one that isn't
// HigherMaestro's, and treat only a 404 as a missing repository. Nothing here reaches GitHub, and every run is a dry run.

const web = fileURLToPath(new URL("..", import.meta.url));

/** Runs a dry-run sync with a fake gh that answers `api user` with `user` and a repository lookup with `repo`. */
function dryRun(user: { ok: true; login: string } | { ok: false; err: string }, repo: { ok: true } | { ok: false; err: string }) {
  const dir = mkdtempSync(join(tmpdir(), "ideas-sync-"));
  const log = join(dir, "calls.log");
  const answer = (r: { ok: true; out: string } | { ok: false; err: string }) =>
    r.ok ? `echo '${r.out}'; exit 0` : `echo '${r.err}' >&2; exit 1`;
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      `echo "$*" >> '${log}'`,
      'if [ "$1 $2" = "api user" ]; then',
      answer(user.ok ? { ok: true, out: user.login } : user),
      "fi",
      'case "$2" in repos/*)',
      answer(repo.ok ? { ok: true, out: "true" } : repo),
      ";; esac",
      "echo 'unexpected gh call' >&2; exit 1",
    ].join("\n"),
  );
  chmodSync(join(dir, "gh"), 0o755);
  // No case here reaches a clone: each either stops or, as a dry run, skips a missing repository.
  const r = spawnSync(process.execPath, ["--import", "tsx", "--conditions=highwire-source", "scripts/ideas.ts", "sync", "--dry-run"], {
    cwd: web,
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: "fake" },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n");
  } catch {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls };
}

test("a token GitHub turns down stops the sync before any repository is looked up", () => {
  const r = dryRun({ ok: false, err: "gh: Bad credentials (HTTP 401)" }, { ok: false, err: "gh: Bad credentials (HTTP 401)" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GitHub didn't accept GH_TOKEN/);
  assert.doesNotMatch(r.stdout, /missing/);
  assert.deepEqual(r.calls, ["api user --jq .login"]);
});

test("another account's token stops the sync", () => {
  const r = dryRun({ ok: true, login: "someone-else" }, { ok: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GH_TOKEN is someone-else's, not HigherMaestro's/);
  assert.deepEqual(r.calls, ["api user --jq .login"]);
});

test("a lookup that fails for any reason but a 404 stops the sync instead of reporting the repository missing", () => {
  const r = dryRun({ ok: true, login: "HigherMaestro" }, { ok: false, err: "gh: Server Error (HTTP 502)" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /couldn't look it up, so the sync stopped here/);
  assert.doesNotMatch(r.stdout, /missing/);
  assert.equal(r.calls.filter((c) => c.startsWith("api repos/")).length, 1);
});

test("a 404 is a missing repository, which a dry run only reports", () => {
  const r = dryRun({ ok: true, login: "HigherMaestro" }, { ok: false, err: "gh: Not Found (HTTP 404)" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /missing \(would create it as a public template\)/);
  assert.ok(r.calls.every((c) => c === "api user --jq .login" || c.startsWith("api repos/")), r.calls.join("\n"));
});
