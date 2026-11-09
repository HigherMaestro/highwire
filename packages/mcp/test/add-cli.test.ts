import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listIdeas, listModules, moduleFiles, moduleMarkdown, policyGaps } from "../src/ideas.ts";
import { addPolicyActions, ASKABLE_ACTIONS, runAdd } from "../src/add-cli.ts";
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

// At a terminal, `highwire add` asks the owner before adding "register" to the policy. These drive it with scripted answers.

const LINE_POLICY = { version: 1, cluster: "mainnet", live: true, actions: ["claim", "trade"], max_sol_per_tx: 0.7, max_sol_per_day: 0.75, max_slippage_bps: 500, transfer_allowlist: [], posts: { comments: "own", chat: false, max_per_day: 3 } };

async function lineProject(policy: object = LINE_POLICY) {
  const p = await project("buyback-coin");
  writeFileSync(join(p.home, "policy.json"), JSON.stringify(policy, null, 2) + "\n", { mode: 0o600 });
  return p;
}
const answering = (...answers: string[]) => {
  const questions: string[] = [];
  return { questions, ask: async (q: string) => { questions.push(q); const a = answers.shift(); if (a === undefined) throw new Error(`asked more than expected: ${q}`); return a; } };
};
const never = async (q: string): Promise<string> => { throw new Error(`it asked: ${q}`); };

test("at a terminal, yes adds \"register\" to the policy and changes nothing else", async () => {
  const { cwd, home } = await lineProject();
  const a = answering("y");
  const c = capture(cwd, { HIGHWIRE_HOME: home });
  assert.equal(await runAdd(["line-play", "app"], { ...c.io, ask: a.ask }), 0, c.err.join("\n"));
  assert.equal(a.questions.length, 1);
  assert.match(a.questions[0]!, /"register"/);
  assert.match(a.questions[0]!, /moves no money/);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "policy.json"), "utf8")), { ...LINE_POLICY, actions: ["claim", "trade", "register"] }, "only the action was added");
  assert.equal(statSync(join(home, "policy.json")).mode & 0o777, 0o600, "the policy keeps its mode");
  assert.match(c.out.join("\n"), /Added "register" to your policy's actions/);
  assert.match(c.out.join("\n"), /already allows what the module needs/);

  // Run again: nothing left to ask.
  const again = capture(cwd, { HIGHWIRE_HOME: home });
  assert.equal(await runAdd(["line-play", "app"], { ...again.io, ask: never }), 0, again.err.join("\n"));
});

test("no (or just Enter) changes nothing, and it can be answered later", async () => {
  const { cwd, home } = await lineProject();
  const before = readFileSync(join(home, "policy.json"), "utf8");
  for (const answer of ["n", ""]) {
    const c = capture(cwd, { HIGHWIRE_HOME: home });
    assert.equal(await runAdd(["line-play", "app"], { ...c.io, ask: answering(answer).ask }), 0);
    assert.equal(readFileSync(join(home, "policy.json"), "utf8"), before);
    assert.match(c.out.join("\n"), /Left your policy as it was/);
  }
  assert.equal(await runAdd(["line-play", "app"], { ...capture(cwd, { HIGHWIRE_HOME: home }).io, ask: answering("yes").ask }), 0);
  assert.ok(JSON.parse(readFileSync(join(home, "policy.json"), "utf8")).actions.includes("register"));
});

test("without a terminal, with --json or --no-ask, it asks nothing and leaves the policy alone", async () => {
  const { cwd, home } = await lineProject();
  const before = readFileSync(join(home, "policy.json"), "utf8");
  const c = capture(cwd, { HIGHWIRE_HOME: home });
  assert.equal(await runAdd(["line-play", "app"], c.io), 0);
  assert.match(c.out.join("\n"), /run `npx highwire-mcp add line-play` yourself, in a terminal, and answer y/);
  assert.equal(await runAdd(["line-play", "app", "--json"], { ...capture(cwd, { HIGHWIRE_HOME: home }).io, ask: never }), 0);
  assert.equal(await runAdd(["line-play", "app", "--no-ask"], { ...capture(cwd, { HIGHWIRE_HOME: home }).io, ask: never }), 0);
  assert.equal(readFileSync(join(home, "policy.json"), "utf8"), before);
});

test("it never offers an action that moves money, even at a terminal", async () => {
  const { cwd, home } = await project();
  const policy = JSON.stringify({ version: 1, cluster: "mainnet", live: false, actions: ["claim"], max_sol_per_tx: 0.1, max_sol_per_day: 0.2, max_slippage_bps: 500, transfer_allowlist: [], orders: { kinds: ["fee_claim"], max_open: 1 } });
  writeFileSync(join(home, "policy.json"), policy);
  const c = capture(cwd, { HIGHWIRE_HOME: home });
  assert.equal(await runAdd(["dip-buys", "app"], { ...c.io, ask: never }), 0, c.err.join("\n"));
  assert.equal(readFileSync(join(home, "policy.json"), "utf8"), policy);
  assert.match(c.out.join("\n"), /only you can change it: add "trade" to "actions"/);
  assert.deepEqual(ASKABLE_ACTIONS, ["register"]);
});

test("with no policy yet, it asks nothing and never creates one", async () => {
  const { cwd, home } = await project("buyback-coin");
  assert.equal(await runAdd(["line-play", "app"], { ...capture(cwd, { HIGHWIRE_HOME: home }).io, ask: never }), 0);
  assert.equal(existsSync(join(home, "policy.json")), false);
});

test("addPolicyActions refuses to write a policy that wouldn't be valid", () => {
  const home = mkdtempSync(join(tmpdir(), "highwire-policy-"));
  const path = join(home, "policy.json");
  writeFileSync(path, JSON.stringify(LINE_POLICY));
  assert.throws(() => addPolicyActions(path, ["teleport"]), /wouldn't be valid/);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), LINE_POLICY);
});
