import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { arenaPagesOn, lineData } from "../lib/arena/data.ts";

// The arena's pages are a preview: off in production unless HIGHWIRE_ARENA_PAGES=1, and their sample matches are
// real referee play, so every commitment and house seed checks out.

test("the pages are off in production until the referee's database is connected (or switched on)", () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = { node: env.NODE_ENV, flag: env.HIGHWIRE_ARENA_PAGES };
  try {
    env.NODE_ENV = "production";
    delete env.HIGHWIRE_ARENA_PAGES;
    assert.equal(arenaPagesOn(), false);
    env.LINE_KV_REST_API_URL = "https://up.test";
    env.LINE_KV_REST_API_TOKEN = "t";
    assert.equal(arenaPagesOn(), true, "on once the database is connected");
    delete env.LINE_KV_REST_API_URL;
    delete env.LINE_KV_REST_API_TOKEN;
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

test("without the database, the pages show the sample, whose commitments and house seeds all check out", async () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const d = await lineData();
  assert.equal(d.sample, true);
  const matches = d.recent;
  assert.ok(matches.length >= 10);
  for (const m of matches) {
    assert.ok(m.ending, m.id);
    for (const r of m.rounds) for (const s of ["a", "b"] as const) assert.equal(sha(`${m.id}|${r.round}|${s}|${r[s].pull}|${r[s].nonce}`), r[s].commitment, `${m.id} ${r.round}${s}`);
    if (m.house) assert.equal(sha(m.house.seed!), m.house.seedCommitment, m.id);
  }
});
