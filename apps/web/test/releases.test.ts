import { test } from "node:test";
import assert from "node:assert/strict";
import { latestReleases, latestVersion, readChangelog } from "../lib/releases.ts";
import { slug } from "../lib/markdown.tsx";

const SAMPLE = `# Changelog

Intro.

## Unreleased

- **Not out yet.** Hidden.

## 1.2.0 (2026-11-09)

- **Big thing.** More text.
  Continued.
- **\`a_tool\` does more:** detail.
- **Third.** x
- **Fourth.** y

## 1.1.0 (2026-11-08)

- **Older.** z
`;

test("What's new skips unreleased work and takes each release's first highlights", () => {
  assert.deepEqual(latestReleases(SAMPLE, 3, 3), [
    { version: "1.2.0", date: "2026-11-09", heading: "1.2.0 (2026-11-09)", titles: ["Big thing", "`a_tool` does more", "Third"] },
    { version: "1.1.0", date: "2026-11-08", heading: "1.1.0 (2026-11-08)", titles: ["Older"] },
  ]);
  assert.equal(latestReleases(SAMPLE, 1).length, 1);
  assert.equal(latestVersion(SAMPLE), "1.2.0");
  assert.equal(slug("1.2.0 (2026-11-09)"), "1-2-0-2026-11-09", "the changelog page's anchor");
});

test("the real changelog gives three releases with titles", () => {
  const real = latestReleases(readChangelog());
  assert.equal(real.length, 3);
  for (const r of real) assert.ok(r.titles.length > 0 && r.titles.every((t) => t.length > 2 && t.length < 90), JSON.stringify(r));
});
