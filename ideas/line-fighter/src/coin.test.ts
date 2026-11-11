import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configProblem, launchSignature, readCoin } from "./coin.ts";

const MINT = "ALBA7iVjFkQzxPQQCovkK7zQiaXUPmixt2dZxNstXiPp";

test("coin.config.json: a name, a ticker, an image that's there, and a first buy", () => {
  const root = mkdtempSync(join(tmpdir(), "coin-"));
  writeFileSync(join(root, "coin.png"), "png");
  const good = { name: "Wire Cat", ticker: "WCAT", image: "coin.png", description: "", buy_sol: 0.01 };
  assert.equal(configProblem(good, root), null);
  assert.match(configProblem({ ...good, name: "" }, root)!, /^name/);
  assert.match(configProblem({ ...good, ticker: "$WCAT" }, root)!, /^ticker/);
  assert.match(configProblem({ ...good, image: "missing.png" }, root)!, /^image/);
  assert.match(configProblem({ ...good, buy_sol: -1 }, root)!, /^buy_sol/);
});

test("the launch signature comes from the audit log's confirmed launch of that coin, never another's", () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  assert.equal(launchSignature(MINT, home), null);
  writeFileSync(
    join(home, "audit.jsonl"),
    [
      { tool: "execute_launch", mint: MINT, outcome: "dry_run" },
      { tool: "execute_launch", mint: MINT, outcome: "sent", signature: "sentSig" },
      { tool: "execute_launch", mint: MINT, outcome: "confirmed", signature: "goodSig" },
      { tool: "execute_launch", mint: "other", outcome: "confirmed", signature: "otherSig" },
      { tool: "execute_trade", mint: MINT, outcome: "confirmed", signature: "tradeSig" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n{cut short",
  );
  assert.equal(launchSignature(MINT, home), "goodSig");
});

test("coin.json is read only when it has the mint and the signature", () => {
  const dir = mkdtempSync(join(tmpdir(), "coinjson-"));
  assert.equal(readCoin(join(dir, "coin.json")), null);
  writeFileSync(join(dir, "coin.json"), JSON.stringify({ mint: MINT, ticker: "WCAT", signature: "s", launchedAt: "t" }));
  assert.equal(readCoin(join(dir, "coin.json"))!.mint, MINT);
  writeFileSync(join(dir, "coin.json"), JSON.stringify({ mint: MINT }));
  assert.throws(() => readCoin(join(dir, "coin.json")), /launch signature/);
});
