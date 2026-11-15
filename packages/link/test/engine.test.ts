import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_REVISION, experienceAt, LEVEL, partyRecord, stat, TEAM } from "highwire-link";

// The engine's revision (state.ts): a saved battle resumes only under the logic that saved it, so a change to the files
// that play a turn must bump ENGINE_REVISION. This test pins those files' hash to the revision; when it fails, bump the
// revision and write the new line into test/fixtures/engine.txt (the failure message has it).

const here = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const FILES = ["src/battle.ts", "src/yellow.ts", "src/format.ts", "src/state.ts", "src/rig.ts"];

test("the engine's files match the revision saved battles are stamped with", () => {
  const hash = createHash("sha256");
  for (const f of FILES) hash.update(readFileSync(join(here, f)));
  const line = `${ENGINE_REVISION} ${hash.digest("hex")}`;
  const pinned = readFileSync(join(here, "test/fixtures/engine.txt"), "utf8").trim();
  assert.equal(line, pinned, `The engine changed: bump ENGINE_REVISION in src/state.ts if a turn plays differently, then set test/fixtures/engine.txt to the new "revision hash" line (now: ${line}).`);
});

test("the format's stats are Gen 1's, with the best DVs and full stat experience", () => {
  // Charizard's base stats (78/84/78/100/85) at level 50: what the game shows in battle.
  assert.equal(LEVEL, 50);
  assert.equal(stat(78, 50, true), 185);
  assert.equal(stat(84, 50), 136);
  assert.equal(stat(100, 50), 152);
  // Medium slow at 50: 6/5·50³ − 15·50² + 100·50 − 140.
  assert.equal(experienceAt(3, 50), 117360);
  const data = { move: () => ({ name: "", pp: 15, power: 0, type: 0, accuracy: 100, effect: 0 }), species: () => "", typeName: () => "", effectiveness: () => 1 };
  const r = partyRecord({ dex: 6, hp: 78, atk: 84, def: 78, spd: 100, spc: 85, types: [20, 2], catchRate: 45, growth: 3 }, 0xb4, TEAM[0]!.moves, data, 0x1234);
  assert.equal(r.length, 44);
  assert.deepEqual([r[0], (r[1]! << 8) | r[2]!, r[33], (r[34]! << 8) | r[35]!], [0xb4, 185, 50, 185]);
  assert.deepEqual([...r.subarray(8, 12)], TEAM[0]!.moves);
  assert.deepEqual([r[27], r[28]], [0xff, 0xff]);
});
