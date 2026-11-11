import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Keypair } from "@solana/web3.js";
import { agentPaths, LocalSigner } from "highwire-agent";
import { createServer } from "highwire-mcp";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { ALL_TOOLS, EXECUTE_TOOLS, FAKE_OPTIONS } from "../../mcp/test/fake.ts";
import { registerWagerTools } from "../src/tools.ts";

// The wall around wagering (docs/boundaries.md 5.2): which way the packages may depend, what a default install of
// highwire-mcp can no longer contain, and what this package's server adds.

const root = fileURLToPath(new URL("../../..", import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

test("no other package imports highwire-wager, in its code or its manifest; only the site does", () => {
  for (const pkg of ["core", "agent", "mcp", "relay"]) {
    const manifest = JSON.parse(readFileSync(join(root, "packages", pkg, "package.json"), "utf8"));
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      assert.ok(!(manifest[field] && "highwire-wager" in manifest[field]), `${manifest.name} lists highwire-wager in ${field}`);
    }
    for (const file of sources(join(root, "packages", pkg, "src"))) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /from\s+"highwire-wager|import\(\s*"highwire-wager|require\(\s*"highwire-wager/, `${file} imports highwire-wager`);
    }
  }
});

test("highwire-mcp carries no wager tool, daemon or builder: nothing in it can stake", () => {
  const src = join(root, "packages", "mcp", "src");
  const files = sources(src);
  assert.ok(!files.some((f) => /wager|line-cli/.test(f.slice(src.length))), "no wager file in highwire-mcp");
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /registerWagerTools|buildWagerOpen|buildWagerAccept|buildWagerMove|WagerRunner|WagerSecrets/, `${file} reaches wager code`);
    // The two tool names appear only where they're described to an agent whose server has the extension.
    if (!file.endsWith(join("tools", "arena.ts")) && !file.endsWith("result.ts")) assert.doesNotMatch(text, /line_stake|line_wagers/, `${file} names a staking tool`);
  }
  // And nothing loads an extension by name: no dynamic import or require of a computed or environment-named module.
  for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"), /import\(\s*(process\.env|[a-zA-Z_]+\s*\))|require\(\s*process\.env/, `${file} loads code by a computed name`);
});

test("highwire-core and highwire-agent no longer export the builders, the history, the daemon or its secrets", async () => {
  const core = await import("highwire-core"), agent = await import("highwire-agent");
  for (const name of ["buildWagerOpen", "buildWagerAccept", "buildWagerMove", "readSeries", "listWalletSeries", "seriesOutcome", "seriesHistory", "recentSeries"]) assert.ok(!(name in core), `highwire-core exports ${name}`);
  for (const name of ["WagerRunner", "WagerSecrets", "daemonStatus", "writeBeat", "nextWagerAction"]) assert.ok(!(name in agent), `highwire-agent exports ${name}`);
});

test("this package's server is highwire-mcp's with line_stake and line_wagers added, and nothing else", async () => {
  const signer = new LocalSigner(Keypair.generate(), agentPaths({ HIGHWIRE_HOME: mkdtempSync(join(tmpdir(), "highwire-wager-")) }));
  const list = async (wagers?: typeof registerWagerTools) => {
    const server = createServer({ ...FAKE_OPTIONS, arena: true, cluster: "devnet", signer, wagers });
    const client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return (await client.listTools()).tools.map((t) => t.name).sort();
  };
  assert.deepEqual(await list(), [...ALL_TOOLS, ...EXECUTE_TOOLS].sort());
  assert.deepEqual(await list(registerWagerTools), [...ALL_TOOLS, ...EXECUTE_TOOLS, "line_stake", "line_wagers"].sort());
});
