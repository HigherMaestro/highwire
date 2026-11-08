import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listIdeas, listModules, moduleFiles, moduleMarkdown, policyGaps } from "../src/ideas.ts";
import { runAdd } from "../src/add-cli.ts";
import { bundledIdeasDir, runNew } from "../src/new-cli.ts";

// `highwire add`: the repository's own modules, added to projects that `highwire new` writes into temporary folders.

const ideasDir = bundledIdeasDir();

function capture(cwd: string, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), ideasDir, cwd, env }, out, err };
}

async function project(idea = "buyback-coin") {
  const cwd = mkdtempSync(join(tmpdir(), "highwire-add-"));
  assert.equal(await runNew([idea, "app"], capture(cwd).io), 0);
  const home = join(cwd, "home");
  mkdirSync(home);
  return { cwd, dir: join(cwd, "app"), home };
}

test("every module is well formed and fits only real ideas", () => {
  const modules = listModules(ideasDir);
  assert.ok(modules.length >= 3);
  const ideas = new Set(listIdeas(ideasDir).map((i) => i.slug));
  for (const m of modules) for (const w of m.worksWith) assert.ok(ideas.has(w), `${m.slug} works with ${w}, which isn't an idea`);
});

test("with no module, it lists them, as text or JSON", async () => {
  const c = capture(tmpdir());
  assert.equal(await runAdd([], c.io), 0);
  for (const m of listModules(ideasDir)) assert.ok(c.out.join("\n").includes(m.slug));
  const j = capture(tmpdir());
  assert.equal(await runAdd(["--json"], j.io), 0);
  assert.deepEqual((JSON.parse(j.out.join("\n")) as { slug: string }[]).map((m) => m.slug), listModules(ideasDir).map((m) => m.slug));
});

test("it copies the module, adds its scripts, and says what the policy still needs, without touching it", async () => {
  const { cwd, dir, home } = await project();
  const policy = JSON.stringify({ version: 1, cluster: "mainnet", live: false, actions: ["claim"], max_sol_per_tx: 0.1, max_sol_per_day: 0.2, max_slippage_bps: 500, transfer_allowlist: [], orders: { kinds: ["fee_claim"], max_open: 1 } });
  writeFileSync(join(home, "policy.json"), policy);
  const c = capture(cwd, { HIGHWIRE_HOME: home });
  assert.equal(await runAdd(["dip-buys", "app"], c.io), 0, c.err.join("\n"));
  for (const [rel, content] of moduleFiles("dip-buys", ideasDir)) assert.equal(readFileSync(join(dir, rel), "utf8"), content, rel);
  assert.ok(existsSync(join(dir, "modules", "dip-buys.md")));
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts.test, "tsx --test src/*.test.ts");
  const text = c.out.join("\n");
  assert.match(text, /add "trade" to "actions"/);
  assert.match(text, /add "limit_buy" to "orders" → "kinds", and raise "max_open" by 1/);
  assert.equal(readFileSync(join(home, "policy.json"), "utf8"), policy, "the policy is untouched");

  // Again: everything is already there.
  const again = capture(cwd, { HIGHWIRE_HOME: home });
  assert.equal(await runAdd(["dip-buys", "app"], again.io), 0);
  assert.match(again.out.join("\n"), /already in app: nothing to write/);
});

test("it never overwrites a file of the project's own", async () => {
  const { cwd, dir, home } = await project();
  writeFileSync(join(dir, "dips.json"), "{}\n");
  const c = capture(cwd, { HIGHWIRE_HOME: home });
  assert.equal(await runAdd(["dip-buys", "app"], c.io), 1);
  assert.match(c.err.join("\n"), /dips\.json already exists/);
  assert.equal(readFileSync(join(dir, "dips.json"), "utf8"), "{}\n");
  assert.ok(!existsSync(join(dir, "src", "dips.ts")), "nothing was written");
});

test("it refuses a folder that isn't a Highwire project, and an unknown module", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "highwire-add-"));
  const c = capture(cwd);
  assert.equal(await runAdd(["kill-switch"], c.io), 1);
  assert.match(c.err.join("\n"), /isn't a project made from a launch idea/);
  const u = capture(cwd);
  assert.equal(await runAdd(["moon-mode"], u.io), 1);
  assert.match(u.err.join("\n"), /no module called moon-mode/);
});

test("policyGaps reads what's missing", () => {
  assert.deepEqual(policyGaps({}, {}), []);
  assert.deepEqual(policyGaps({ posts: true }, { posts: { comments: "own" } }), []);
  assert.deepEqual(policyGaps({ orderKinds: ["limit_buy"], openOrders: 1 }, {}), ['add "orders": { "kinds": ["limit_buy"], "max_open": 1 }']);
  assert.deepEqual(policyGaps({ actions: ["trade"] }, { actions: ["trade", "claim"] }), []);
});

test("the module's markdown has the spec and every file", () => {
  for (const m of listModules(ideasDir)) {
    const md = moduleMarkdown(m.slug, ideasDir);
    for (const rel of moduleFiles(m.slug, ideasDir).keys()) if (!rel.startsWith("modules/")) assert.ok(md.includes(`### \`${rel}\``), `${m.slug}: ${rel}`);
  }
});
