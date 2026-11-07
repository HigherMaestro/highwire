import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemble, listIdeas } from "../src/ideas.ts";
import { bundledIdeasDir, runNew } from "../src/new-cli.ts";
import { VERSION } from "../src/server.ts";

// `highwire new`: the repository's own ideas/ folder (what prepack ships), written into temporary folders.

const ideasDir = bundledIdeasDir();

function capture(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), ideasDir, cwd }, out, err };
}

test("from source, the ideas are the repository's own", () => {
  assert.ok(existsSync(join(ideasDir, "starter", "AGENTS.md")));
  assert.ok(listIdeas(ideasDir).some((i) => i.slug === "buyback-coin"));
});

test("with no idea, it lists them, as text or JSON", async () => {
  const c = capture(tmpdir());
  assert.equal(await runNew([], c.io), 0);
  for (const idea of listIdeas(ideasDir)) assert.ok(c.out.join("\n").includes(idea.slug));
  const j = capture(tmpdir());
  assert.equal(await runNew(["--json"], j.io), 0);
  const list = JSON.parse(j.out.join("\n")) as { slug: string; url: string }[];
  assert.deepEqual(list.map((i) => i.slug), listIdeas(ideasDir).map((i) => i.slug));
  assert.equal(list[0]!.url, `https://highwire.fun/ideas/${list[0]!.slug}`);
});

test("it writes the same files as the idea's template, at this version, and runs git init", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "highwire-new-"));
  const c = capture(cwd);
  assert.equal(await runNew(["dip-buyer"], c.io), 0, c.err.join("\n"));
  const dir = join(cwd, "dip-buyer");
  const expected = assemble("dip-buyer", { version: VERSION, siteUrl: "https://highwire.fun", dir: ideasDir });
  for (const [rel, content] of expected) assert.equal(readFileSync(join(dir, rel), typeof content === "string" ? "utf8" : undefined).toString(), content.toString(), rel);
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies["highwire-mcp"], VERSION);
  assert.ok(!existsSync(join(dir, "idea.json")));
  assert.ok(!existsSync(join(dir, "wallet.json")), "it never makes a wallet");
  assert.ok(existsSync(join(dir, ".git")), "git init ran");
  const text = c.out.join("\n");
  assert.match(text, /cd dip-buyer\n\s+npm install\n\s+npm run setup/);
  assert.ok(text.includes("https://highwire.fun/ideas/dip-buyer"));
});

test("it takes a folder, and writes only into a new or empty one", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "highwire-new-"));
  mkdirSync(join(cwd, "empty"));
  assert.equal(await runNew(["buyback-coin", "empty"], capture(cwd).io), 0);
  assert.ok(existsSync(join(cwd, "empty", "PRD.md")));

  mkdirSync(join(cwd, "busy"));
  writeFileSync(join(cwd, "busy", "notes.txt"), "mine");
  const busy = capture(cwd);
  assert.equal(await runNew(["buyback-coin", "busy"], busy.io), 1);
  assert.match(busy.err.join("\n"), /isn't empty, so nothing was written/);
  assert.ok(!existsSync(join(cwd, "busy", "PRD.md")));

  writeFileSync(join(cwd, "file"), "x");
  assert.equal(await runNew(["buyback-coin", "file"], capture(cwd).io), 1);
});

test("an unknown idea, or too many arguments, writes nothing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "highwire-new-"));
  const c = capture(cwd);
  assert.equal(await runNew(["moon-bot"], c.io), 1);
  assert.match(c.err.join("\n"), /no idea called moon-bot\. The ideas: .*buyback-coin/);
  assert.equal(await runNew(["buyback-coin", "a", "b"], capture(cwd).io), 2);
  assert.ok(!existsSync(join(cwd, "moon-bot")) && !existsSync(join(cwd, "a")));
});
