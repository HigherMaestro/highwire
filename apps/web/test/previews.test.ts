import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { IDEAS_CARD, cardFacts, ideaCard, ideaCardFor, ideasCard, moduleCard, moduleCardFor, shortSol } from "../lib/idea-card.tsx";
import { listIdeas, listModules } from "../lib/ideas.ts";
import { FEES_CARD, SITE_CARD, pageMetadata } from "../lib/site.ts";

// Link previews: each idea's card fits what idea.json puts on it, and every page has Open Graph and X tags of its
// own, so no link previews as the homepage.

const ideas = listIdeas();

test("every idea fits its card", () => {
  for (const idea of ideas) {
    assert.ok(cardFacts(idea).length <= 40, `${idea.slug}: "${cardFacts(idea)}" runs into the wire`);
    assert.ok(idea.title.length <= 20, `${idea.slug}: the title takes more than two lines`);
    // validateIdea holds the loop to three or four steps of at most LOOP_STEP_MAX characters.
    assert.ok(idea.loop.length >= 3 && idea.loop.length <= 4, idea.slug);
  }
  for (const m of listModules()) {
    assert.ok(`highwire add ${m.slug}`.length <= 40, `${m.slug}: the command runs into the wire`);
    assert.ok(m.title.length <= 20, `${m.slug}: the title takes more than two lines`);
  }
  assert.equal(shortSol("about 0.3 SOL, the budget you give it"), "0.3 SOL");
  assert.equal(shortSol("0 SOL, or about 0.3 SOL if it buys"), "0 SOL");
});

test("the cards render as 1200x630 PNGs, and /ideas's has room for every idea", async () => {
  assert.ok(ideas.length <= 5, "/ideas's card shows five ideas at most");
  for (const card of [ideaCard(ideas[0]!), ideasCard(ideas), moduleCard(listModules()[0]!)]) {
    const png = Buffer.from(await (await card).arrayBuffer());
    assert.deepEqual([...png.subarray(1, 4)], [...Buffer.from("PNG")]);
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
  }
});

test("pageMetadata gives a page its own preview tags", () => {
  const m = pageMetadata({ title: "Docs", description: "Every tool.", path: "/docs" });
  assert.deepEqual(m.alternates, { canonical: "/docs" });
  assert.equal(m.openGraph?.url, "/docs");
  assert.equal(m.openGraph?.title, "Docs · Highwire");
  assert.equal(m.twitter?.title, "Docs · Highwire");
  assert.equal(m.twitter?.description, "Every tool.");
});

test("the cards pages name are the files that draw them, with their alt text", () => {
  const m = pageMetadata({ title: "Docs", description: "Every tool.", path: "/docs" });
  assert.deepEqual(m.openGraph?.images, [{ ...SITE_CARD, width: 1200, height: 630 }]);
  assert.deepEqual(m.twitter?.images, m.openGraph?.images);
  for (const [card, dir, url] of [[SITE_CARD, "app", "/opengraph-image.png"], [FEES_CARD, "app/fees", "/fees/opengraph-image.png"]] as const) {
    assert.equal(card.url, url);
    for (const file of ["opengraph-image", "twitter-image"]) {
      assert.equal(card.alt, readFileSync(join(process.cwd(), dir, `${file}.alt.txt`), "utf8").trim(), `${dir}/${file}`);
    }
  }
  assert.ok(existsSync(join(process.cwd(), "app/ideas/opengraph-image.tsx")) && IDEAS_CARD.url === "/ideas/opengraph-image");
  assert.ok(existsSync(join(process.cwd(), "app/ideas/[slug]/opengraph-image.tsx")) && ideaCardFor("dip-buyer").url === "/ideas/dip-buyer/opengraph-image");
  assert.ok(existsSync(join(process.cwd(), "app/modules/[slug]/opengraph-image.tsx")) && moduleCardFor("receipts").url === "/modules/receipts/opengraph-image");
});

test("every page with metadata of its own goes through pageMetadata", () => {
  const pages = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? pages(path) : name === "page.tsx" ? [path] : [];
    });
  const found = pages(join(process.cwd(), "app")).filter((p) => /export (const metadata|async function generateMetadata)/.test(readFileSync(p, "utf8")));
  assert.ok(found.length >= 8);
  for (const p of found) assert.match(readFileSync(p, "utf8"), /pageMetadata\(/, p);
});
