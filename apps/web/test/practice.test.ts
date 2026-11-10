import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SeriesHistory } from "highwire-core";
import { replaySeries } from "../lib/practice/replay.ts";

// The practice pages' replay (docs/wager-mode.md 7.5), on two series recorded from devnet (W1, docs/wager-devnet.md 8):
// 4986497b, where LGTM's reveal daemon was killed mid-series and recovered, and 598b27ec, whose fourth match went to
// fallbacks and timeouts. Every reveal must match its commitment, and the replay's winner must be the program's.

const load = (id: string): SeriesHistory => JSON.parse(readFileSync(new URL(`./fixtures/practice/hist-${id}.json`, import.meta.url), "utf8"));

test("recorded devnet series replay exactly, and agree with the program's closing event", () => {
  const killed = replaySeries(load("4986497b"));
  assert.equal(killed.ok, true, killed.problem ?? "");
  assert.equal(killed.agrees, true);
  assert.deepEqual(killed.matches.map((m) => m.result?.reason), ["missed_reveal", "missed_reveal", "reached_end"]);
  assert.ok(killed.matches[2]!.rounds.some((r) => r.fallback.A || r.fallback.B), "the restarted daemon's fallback reveal shows as a fallback");
  const voids = replaySeries(load("598b27ec"));
  assert.equal(voids.ok, true, voids.problem ?? "");
  assert.equal(voids.reveals, 32);
  assert.equal(voids.commits, 30);
  assert.deepEqual(voids.matches.map((m) => m.result?.reason), ["reached_end", "reached_end", "void", "void"]);
});

test("a changed reveal, a stranger's move or a different announced winner fails the check", () => {
  const h = load("4986497b");
  const nonce = structuredClone(h);
  const r = nonce.events.find((e) => e.kind === "reveal")!;
  if (r.kind === "reveal") r.nonce = r.nonce.replace(/^./, (c) => (c === "0" ? "1" : "0"));
  const a = replaySeries(nonce);
  assert.equal(a.ok, false);
  assert.match(a.problem!, /commitment/);

  const pull = structuredClone(h);
  const p = pull.events.find((e) => e.kind === "reveal")!;
  if (p.kind === "reveal") p.pull += 1;
  assert.equal(replaySeries(pull).ok, false);

  const stranger = structuredClone(h);
  const c = stranger.events.find((e) => e.kind === "commit")!;
  if (c.kind === "commit") c.player = "11111111111111111111111111111111";
  assert.match(replaySeries(stranger).problem!, /isn't in this series/);

  const winner = structuredClone(h);
  const closed = winner.events.find((e) => e.kind === "closed")!;
  if (closed.kind === "closed" && closed.outcome.how === "settled") closed.outcome.winner = closed.outcome.winner === "A" ? "B" : "A";
  const w = replaySeries(winner);
  assert.equal(w.agrees, false);
  assert.equal(w.ok, false);
});

test("only a series' last life counts, and moves without an accept never pass", () => {
  const h = load("4986497b");
  const open = h.events.find((e) => e.kind === "open")!;
  // Opened, cancelled, then opened again on the same ticket: the first life's close mustn't stand for the second.
  const reopened = structuredClone(h);
  reopened.events.unshift({ ...open, at: open.at - 10, sig: "earlier" }, { at: open.at - 5, sig: "cancel", kind: "closed", outcome: { state: "closed", how: "cancelled" } });
  const r = replaySeries(reopened);
  assert.equal(r.ok, true, r.problem ?? "");
  assert.equal(r.agrees, true, "the settle's winner is compared, not the earlier cancel");
  // The accept missing (read from an incomplete history): never a pass.
  const noAccept = structuredClone(h);
  noAccept.events = noAccept.events.filter((e) => e.kind !== "accept");
  const n = replaySeries(noAccept);
  assert.equal(n.ok, false);
  assert.match(n.problem!, /acceptance/);
});

test("the replay runs in the browser: at runtime it imports only highwire-core/arena", () => {
  const src = readFileSync(new URL("../lib/practice/replay.ts", import.meta.url), "utf8");
  const runtime = [...src.matchAll(/^import (?!type )[^;]*from "([^"]+)";/gm)].map((m) => m[1]);
  assert.deepEqual(runtime, ["highwire-core/arena"]);
});
