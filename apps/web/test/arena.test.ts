import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { arenaData, arenaPagesOn } from "../lib/arena/data.ts";

// The arena's pages are a preview: off in production unless HIGHWIRE_ARENA_PAGES=1, and their sample matches are
// real referee play, so every commitment and house seed checks out.

test("the arena pages are off in production unless switched on", () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = { node: env.NODE_ENV, flag: env.HIGHWIRE_ARENA_PAGES };
  try {
    env.NODE_ENV = "production";
    delete env.HIGHWIRE_ARENA_PAGES;
    assert.equal(arenaPagesOn(), false);
    env.HIGHWIRE_ARENA_PAGES = "1";
    assert.equal(arenaPagesOn(), true);
    env.NODE_ENV = "development";
    delete env.HIGHWIRE_ARENA_PAGES;
    assert.equal(arenaPagesOn(), true);
  } finally {
    env.NODE_ENV = saved.node;
    if (saved.flag === undefined) delete env.HIGHWIRE_ARENA_PAGES;
    else env.HIGHWIRE_ARENA_PAGES = saved.flag;
  }
});

test("every sample match's commitments and house seeds check out", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const { matches } = arenaData();
  assert.ok(matches.length >= 10);
  for (const m of matches) {
    assert.ok(m.ending, m.id);
    for (const r of m.rounds) for (const s of ["a", "b"] as const) assert.equal(sha(`${m.id}|${r.round}|${s}|${r[s].pull}|${r[s].nonce}`), r[s].commitment, `${m.id} ${r.round}${s}`);
    if (m.house) assert.equal(sha(m.house.seed!), m.house.seedCommitment, m.id);
  }
});
