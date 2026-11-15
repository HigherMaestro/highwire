import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The walls around link battles (docs/link-battles.md 12): which packages may depend on the rig, that the game never
// enters the repository, and that the committed WebAssembly is the one its checksum names.

const root = fileURLToPath(new URL("../../..", import.meta.url));
const here = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

test("no package but the site imports highwire-link, in its code or its manifest", () => {
  for (const pkg of ["core", "agent", "mcp", "relay", "wager"]) {
    const manifest = JSON.parse(readFileSync(join(root, "packages", pkg, "package.json"), "utf8"));
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      assert.ok(!(manifest[field] && "highwire-link" in manifest[field]), `${manifest.name} lists highwire-link in ${field}`);
    }
    for (const file of sources(join(root, "packages", pkg, "src"))) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /from\s+"highwire-link|import\(\s*"highwire-link|require\(\s*"highwire-link/, `${file} imports highwire-link`);
    }
  }
});

test("the repository holds no game, save file or emulator state", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const game = tracked.filter((f) => /\.(gb|gbc|sgb|sav|srm|ss\d|s\d|state|gbcart|gbl)$/i.test(f) || /\.gbcart\//i.test(f));
  assert.deepEqual(game, [], `game files tracked: ${game.join(", ")}`);
});

test("the committed WebAssembly is the build its checksum names", () => {
  const [expected] = readFileSync(join(here, "src/wasm/sameboy.sha256"), "utf8").trim().split(/\s+/);
  const actual = createHash("sha256").update(readFileSync(join(here, "src/wasm/sameboy.mjs"))).digest("hex");
  assert.equal(actual, expected, "src/wasm/sameboy.mjs changed without scripts/build-wasm.sh");
  assert.match(readFileSync(join(here, "src/wasm/version.ts"), "utf8"), new RegExp(`"${actual}"`), "src/wasm/version.ts names another build");
});
