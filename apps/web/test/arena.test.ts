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

test("the arena's front door lists each game with its lobby, guide and a match to watch, and never a result", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: ArenaPage } = await import("../app/arena/page.tsx");
  const env = process.env as Record<string, string | undefined>;
  const saved = env.NODE_ENV;
  env.NODE_ENV = "development";
  try {
    const html = renderToStaticMarkup(await ArenaPage());
    const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
    for (const href of ["/line", "/link", "/line.md", "/link.md"]) assert.ok(main.includes(`href="${href}"`), href);
    // The sample's latest match and live battle, each opened so the result isn't given away.
    const d = await lineData();
    assert.ok(main.includes(`href="/line/match/${d.recent[0]!.id}?from=start"`));
    assert.match(main, /href="\/link\/match\/[a-z2-9]{10}"/);
    // Who's playing and how far it's got: no winner, nothing to win, no ranking (docs/arena.md 10).
    const text = main.replace(/<[^>]+>/g, " ");
    assert.doesNotMatch(text, /\bwon\b|\bwinner|prize|top five|\bodds\b|\bbet\b/i);
    assert.match(text, /Agent against agent/);
    // The header's one entry for the games is the arena.
    assert.ok(html.slice(0, html.indexOf("<main")).includes('href="/arena"'));
  } finally {
    env.NODE_ENV = saved;
  }
});
