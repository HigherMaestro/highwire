import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeypairFile } from "highwire-agent";
import { LINE_USAGE, runLine, seriesLister } from "../src/line-cli.ts";

// `highwire-wager run` and `series`. Unit tests only: wallets are throwaway files in a temp folder, never funded, and
// nothing here reaches a cluster.

const home = () => mkdtempSync(join(tmpdir(), "highwire-cli-"));
const capture = () => {
  const out: string[] = [], err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

test("line: usage, and run or series need the signer's keypair; nothing starts without it", async () => {
  const signal = new AbortController().signal;
  const u = capture();
  assert.equal(await runLine([], { ...u.io, signal, env: { HIGHWIRE_HOME: home() } }), 0);
  assert.equal(u.out[0], LINE_USAGE);
  assert.equal(await runLine(["dance"], { ...capture().io, signal, env: { HIGHWIRE_HOME: home() } }), 2);
  for (const cmd of ["run", "series"]) {
    const w = capture();
    assert.equal(await runLine([cmd], { ...w.io, signal, env: { HIGHWIRE_HOME: home() } }), 2);
    assert.match(w.err.join("\n"), /HIGHWIRE_KEYPAIR_PATH/);
  }
});

test("line run refuses to start where it couldn't read a series: a cluster without the program, or another cluster's policy", async () => {
  const { Keypair } = await import("@solana/web3.js");
  const dir = home();
  const keyPath = join(dir, "k.json");
  writeFileSync(keyPath, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  writeFileSync(join(dir, "policy.json"), JSON.stringify({ version: 1, cluster: "mainnet", live: true, actions: ["wager"], max_sol_per_tx: 0.5, max_sol_per_day: 1, max_slippage_bps: 100, transfer_allowlist: [], wagers: { max_stake_sol: 0.1, tiers: [0.1] } }));
  const signal = new AbortController().signal;
  const main = capture();
  assert.equal(await runLine(["run"], { ...main.io, signal, env: { HIGHWIRE_HOME: dir, HIGHWIRE_KEYPAIR_PATH: keyPath, HIGHWIRE_CLUSTER: "mainnet" } }), 2);
  assert.match(main.err.join("\n"), /isn't deployed on mainnet/);
  const mixed = capture();
  assert.equal(await runLine(["run"], { ...mixed.io, signal, env: { HIGHWIRE_HOME: dir, HIGHWIRE_KEYPAIR_PATH: keyPath, HIGHWIRE_CLUSTER: "devnet" } }), 2);
  assert.match(mixed.err.join("\n"), /policy is for mainnet/);
});

test("the daemon reads its known series every pass, asks the referee for new ones every 15 seconds, and never scans", async () => {
  const series = (id: string) => ({ header: { seriesId: id } }) as never;
  let t = 0;
  let asked = 0;
  const reads: string[][] = [];
  const onChain = new Set(["aa", "bb"]);
  const list = seriesLister({
    discover: async () => {
      asked++;
      return ["bb"];
    },
    readMany: async (ids) => {
      reads.push(ids);
      return ids.filter((id) => onChain.has(id)).map(series);
    },
    savedIds: () => ["aa"],
    now: () => t,
  });
  assert.deepEqual((await list()).map((s: any) => s.header.seriesId).sort(), ["aa", "bb"]);
  t += 3_000;
  await list();
  t += 3_000;
  await list();
  assert.equal(asked, 1, "the referee once in 15 seconds");
  assert.equal(reads.length, 3, "one read a pass");
  onChain.delete("bb"); // closed
  t += 3_000;
  assert.deepEqual((await list()).map((s: any) => s.header.seriesId), ["aa"]);
  t += 15_000;
  await list();
  assert.equal(asked, 2);
  // A referee that doesn't answer leaves the saved series watched.
  const down = seriesLister({ discover: async () => { throw new Error("503"); }, readMany: async (ids) => ids.map(series), savedIds: () => ["cc"], onDiscoverError: () => undefined });
  assert.deepEqual((await down()).map((s: any) => s.header.seriesId), ["cc"]);
});
