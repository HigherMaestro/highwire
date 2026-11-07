import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PolicySchema } from "highwire-agent";
import { checkPostText } from "highwire-core";
import { assemble, deployUrl, listIdeas, PRD_SECTIONS, readPrd, validateIdea } from "../lib/ideas.ts";

// The ideas/ folder, checked without the network: every idea is well formed, and every template assembles into
// something safe to hand out. `npm run ideas -- check` installs and runs them for real.

const VERSION = (JSON.parse(readFileSync(join(process.cwd(), "../../packages/mcp/package.json"), "utf8")) as { version: string }).version;
const ideas = listIdeas();

test("every idea's idea.json is complete, and the starter isn't listed as one", () => {
  assert.ok(ideas.length >= 2);
  assert.ok(!ideas.some((i) => i.slug === "starter"));
  assert.deepEqual(ideas.map((i) => i.difficulty), [...ideas.map((i) => i.difficulty)].sort((a, b) => ["easy", "medium", "hard"].indexOf(a) - ["easy", "medium", "hard"].indexOf(b)));
  assert.throws(() => validateIdea({ ...ideas[0], slug: "other" }, ideas[0]!.slug), /folder's name/);
  assert.throws(() => validateIdea({ ...ideas[0], difficulty: "trivial" }, ideas[0]!.slug), /difficulty/);
  assert.throws(() => validateIdea({ ...ideas[0], title: 'say "hi"' }, ideas[0]!.slug), /can't contain/);
});

test("every PRD has the shared sections, in order", () => {
  for (const idea of ideas) {
    const heads = [...readPrd(idea.slug).matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(heads, PRD_SECTIONS, idea.slug);
  }
});

test("every template assembles with nothing left unfilled, valid JSON, and the current Highwire", () => {
  for (const idea of ideas) {
    const files = assemble(idea.slug, { version: VERSION, siteUrl: "https://highwire.fun" });
    assert.ok(!files.has("idea.json"), "idea.json stays behind");
    for (const [path, content] of files) {
      if (typeof content !== "string") continue;
      assert.ok(!/\{\{\w+\}\}/.test(content), `${idea.slug}/${path} has an unfilled placeholder`);
      if (path.endsWith(".json")) assert.doesNotThrow(() => JSON.parse(content), `${idea.slug}/${path}`);
    }
    const pkg = JSON.parse(files.get("package.json") as string);
    assert.equal(pkg.name, idea.slug);
    assert.equal(pkg.dependencies["highwire-mcp"], VERSION);
    assert.equal(pkg.dependencies["highwire-agent"], VERSION);
    for (const [name, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) assert.match(String(v), /^\d+\.\d+\.\d+$/, `${name} is pinned`);
    assert.equal(files.get("PRD.md"), readPrd(idea.slug), "the idea's PRD replaces nothing and is copied as is");
    assert.match(files.get("README.md") as string, new RegExp(`https://highwire.fun/ideas/${idea.slug}`));
    const mcp = JSON.parse(files.get(".mcp.json") as string);
    assert.equal(mcp.mcpServers.highwire.env.HIGHWIRE_HOME, `\${HOME}/.highwire/${idea.slug}`);
    const ignore = files.get(".gitignore") as string;
    for (const pattern of ["wallet.json", "*keypair*.json", ".env", ".highwire*/"]) assert.ok(ignore.split("\n").includes(pattern), `.gitignore covers ${pattern}`);
  }
});

test("every starting policy is a valid Highwire policy, on mainnet, and a dry run", () => {
  for (const idea of ideas) {
    const raw = JSON.parse(readFileSync(join(process.cwd(), "../../ideas", idea.slug, "policy.example.json"), "utf8"));
    const policy = PolicySchema.parse(raw);
    assert.equal(policy.live, false, idea.slug);
    assert.equal(policy.cluster, "mainnet", idea.slug);
    assert.deepEqual(policy.transfer_allowlist, [], `${idea.slug} sends nowhere`);
    // The PRD shows the same policy the template ships.
    const shown = /## Policy[\s\S]*?```json\n([\s\S]*?)```/.exec(readPrd(idea.slug))?.[1];
    assert.deepEqual(JSON.parse(shown!), raw, `${idea.slug}'s PRD shows its policy.example.json`);
  }
});

test("example posts in the PRDs would pass Highwire's post check", () => {
  for (const idea of ideas) {
    for (const m of readPrd(idea.slug).matchAll(/example: `([^`]+)`/g)) assert.doesNotThrow(() => checkPostText(m[1]!.replace(/\s+/g, " "), "comment"), `${idea.slug}: ${m[1]}`);
  }
});

test("Deploy opens GitHub's own template form for the signed-in user", () => {
  const url = new URL(deployUrl(ideas[0]!));
  assert.equal(url.origin + url.pathname, "https://github.com/new");
  assert.equal(url.searchParams.get("template_owner"), "HigherMaestro");
  assert.equal(url.searchParams.get("template_name"), `highwire-idea-${ideas[0]!.slug}`);
  assert.equal(url.searchParams.get("owner"), "@me");
  assert.equal(url.searchParams.get("name"), ideas[0]!.slug);
});
