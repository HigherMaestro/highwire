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
  assert.ok(ideas.length >= 5);
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

test("every policy key an idea can change has a note on its page, and every note names a real key", () => {
  for (const idea of ideas) {
    const policy = JSON.parse(readFileSync(join(process.cwd(), "../../ideas", idea.slug, "policy.example.json"), "utf8"));
    const fixed = ["version", "cluster", "live", ...(policy.actions.includes("transfer") ? [] : ["transfer_allowlist"])];
    const keys = Object.keys(policy).filter((k) => !fixed.includes(k));
    assert.deepEqual(Object.keys(idea.policyNotes).sort(), keys.sort(), idea.slug);
  }
});

test("the one-command start and the agent prompt name the idea's template", async () => {
  const { startCommand, agentPrompt, fileTree } = await import("../lib/ideas.ts");
  const cmd = startCommand("buyback-coin");
  assert.equal(cmd, "gh repo create buyback-coin --template HigherMaestro/highwire-idea-buyback-coin --public --clone && cd buyback-coin && npm install && npm run setup");
  assert.ok(agentPrompt({ slug: "buyback-coin", title: "Buyback coin" }).includes(cmd));
  assert.equal(fileTree(["b.md", "src/x.ts", "a.md"]), "├── src/\n│   └── x.ts\n├── a.md\n└── b.md");
});

test("the trading calculator's arithmetic", async () => {
  const { breakEvenPct, roundTrip, winsToBreakEven } = await import("../lib/idea-math.ts");
  // With no fees at all but Highwire's, a flat round loses about 0.6%.
  const flat = roundTrip(1, 0, 0);
  assert.ok(Math.abs(flat.net - (0.997 - 1.003)) < 1e-12);
  assert.ok(Math.abs(flat.highwire - 0.006) < 1e-12);
  // At the break-even rise a round nets nothing, whatever the trading fee.
  for (const fee of [0, 0.25, 1]) assert.ok(Math.abs(roundTrip(0.05, breakEvenPct(fee), fee).net) < 1e-12, `fee ${fee}%`);
  // A New school round needs a rise of about 2.6%.
  assert.ok(breakEvenPct(1) > 2.6 && breakEvenPct(1) < 2.7);
  // Winning 1 for every 1 lost needs half the rounds to win; a "win" that loses can't break even.
  assert.equal(winsToBreakEven(1, -1), 0.5);
  assert.equal(winsToBreakEven(-0.1, -1), null);
});
