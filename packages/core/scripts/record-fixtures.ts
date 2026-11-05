// Re-records the fixtures the transaction tests replay, from api.higher.fun
// and mainnet RPC. Every transaction is only simulated; nothing is sent.
// Run with `npm run record-fixtures -w highwire-core` (needs network access).
import { writeFileSync } from "node:fs";
import { recordingFetch, type Recording } from "../test/replay.ts";
import { runScenario } from "../test/run-scenario.ts";
import { SCENARIOS } from "../test/scenarios.ts";

const only = process.argv.slice(2);
let first = true;
for (const name of SCENARIOS) {
  if (only.length && !only.includes(name)) continue;
  // The public RPC rate-limits by IP; give it a breather between scenarios.
  if (!first) await new Promise((r) => setTimeout(r, 10_000));
  first = false;
  const recording: Recording = {};
  const result = await runScenario(name, recordingFetch(recording));
  const sims = result && "envelope" in result && result.envelope ? result.envelope.transactions.map((t) => t.simulation) : [];
  writeFileSync(new URL(`../test/fixtures/${name}.json`, import.meta.url), JSON.stringify(recording) + "\n");
  console.log(`${name}: ${Object.keys(recording).length} requests recorded; simulations: ${JSON.stringify(sims.map((s) => (s.ok ? "ok" : s.skipped ? "skipped" : s.error)))}`);
}
