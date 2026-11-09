import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A page that reads searchParams is rendered per request, so it must not also ask to be rendered statically
// (revalidate or generateStaticParams without force-dynamic): Next then throws DYNAMIC_SERVER_USAGE in production, a
// 500 that next dev never shows. The Line's replay page did, and its first real match found it.

const APP = fileURLToPath(new URL("../app", import.meta.url));
const pages = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? pages(p) : name === "page.tsx" ? [p] : [];
  });

test("no page that reads searchParams asks to be rendered statically", () => {
  const found = pages(APP);
  assert.ok(found.length > 10);
  for (const p of found) {
    const src = readFileSync(p, "utf8");
    if (!/\bsearchParams\b/.test(src) || /export const dynamic = "force-dynamic"/.test(src)) continue;
    assert.doesNotMatch(src, /export const revalidate\b|export (async )?function generateStaticParams\b/, `${p.slice(APP.length)} reads searchParams but is rendered statically`);
  }
});
