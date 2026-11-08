import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuditEntry } from "highwire-agent";
import { checkKill, type KillFacts, type KillRules } from "./kill-switch.ts";

// The kill switch's checks, with made-up audit logs: no network, no wallet.

const RULES: KillRules = { min_balance_sol: 0.02, max_sol_per_hour: 0.5, max_failed_per_day: 3, max_refused_per_hour: 5, foreign_signatures: true };
const NOW = new Date("2026-11-08T12:00:00Z");
const WALLET = "7bK1LThaA8xMKpmJt3wosCRcYvVA2R8V2PzoiAdqfu4B";
const facts = (f: Partial<KillFacts>): KillFacts => ({ rules: RULES, entries: [], now: NOW, since: "2026-11-01T00:00:00Z", balanceSol: 0.5, foreign: [], ...f });
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
const entry = (e: Partial<AuditEntry>): AuditEntry => ({ time: at(10), tool: "execute_trade", action: "trade", cluster: "mainnet", wallet: WALLET, outcome: "sent", sol: "0.1", lamports: "100000000", ...e });

test("a quiet wallet passes", () => {
  assert.deepEqual(checkKill(facts({ entries: [entry({}), entry({ outcome: "refused", order: "0000000a" })] })), []);
});

test("a transaction Highwire didn't send stops it", () => {
  const r = checkKill(facts({ foreign: ["5abc"] }));
  assert.equal(r.length, 1);
  assert.match(r[0]!, /signed a transaction Highwire didn't send \(5abc\)/);
});

test("a balance under the floor stops it; an unread balance doesn't", () => {
  assert.match(checkKill(facts({ balanceSol: 0.01 }))[0]!, /0.01 SOL, under the 0.02 SOL floor/);
  assert.deepEqual(checkKill(facts({ balanceSol: undefined })), []);
});

test("spending faster than allowed in an hour stops it; older spends don't count", () => {
  const six = Array.from({ length: 6 }, () => entry({ time: at(20) }));
  assert.match(checkKill(facts({ entries: six }))[0]!, /spent 0.6 SOL in the last hour/);
  assert.deepEqual(checkKill(facts({ entries: six.map((e) => ({ ...e, time: at(90) })) })), []);
  // Only sends count: dry runs and refusals spend nothing.
  assert.deepEqual(checkKill(facts({ entries: six.map((e) => ({ ...e, outcome: "dry_run" as const })) })), []);
});

test("failed sends in a day stop it", () => {
  const failed = (m: number) => entry({ outcome: "failed", time: at(m) });
  assert.deepEqual(checkKill(facts({ entries: [failed(10), failed(600)] })), []);
  assert.match(checkKill(facts({ entries: [failed(10), failed(600), failed(1300)] }))[0]!, /3 sends failed/);
  assert.deepEqual(checkKill(facts({ entries: [failed(10), failed(600), failed(1500)] })), [], "older than a day");
});

test("the agent's own refused calls stop it; the order runner's retries don't", () => {
  const refused = Array.from({ length: 5 }, () => entry({ outcome: "refused" }));
  assert.match(checkKill(facts({ entries: refused }))[0]!, /refused 5 of the agent's own calls/);
  assert.deepEqual(checkKill(facts({ entries: refused.map((e) => ({ ...e, order: "0000000a" })) })), []);
});

test("nothing before `since` counts, so deleting STOP starts afresh", () => {
  const failed = [10, 20, 30].map((m) => entry({ outcome: "failed", time: at(m) }));
  assert.equal(checkKill(facts({ entries: failed })).length, 1);
  assert.deepEqual(checkKill(facts({ entries: failed, since: at(5) })), []);
});

test("every reason is listed", () => {
  const r = checkKill(facts({ foreign: ["a", "b"], balanceSol: 0, entries: Array.from({ length: 6 }, () => entry({})) }));
  assert.equal(r.length, 3);
  assert.match(r[0]!, /2 transactions/);
});
