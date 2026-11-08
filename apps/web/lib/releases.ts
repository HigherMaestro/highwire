import { readFileSync } from "node:fs";
import { join } from "node:path";

// The home page's "What's new", read from CHANGELOG.md at build time so it never goes stale: the latest releases and
// the titles of their first few highlights (each section lists its biggest changes first). Unreleased work isn't shown.

export interface Release {
  version: string;
  date: string | null;
  /** The heading's text, which the changelog page turns into the release's anchor. */
  heading: string;
  /** Its highlights' bold titles, as inline Markdown. */
  titles: string[];
}

/** `next` runs from apps/web; the changelog is at the repository's root. */
export const readChangelog = () => readFileSync(join(/* turbopackIgnore: true */ process.cwd(), "../../CHANGELOG.md"), "utf8");

/** The latest released versions, newest first, each with up to `titles` highlight titles. */
export function latestReleases(source: string, count = 3, titles = 3): Release[] {
  const out: Release[] = [];
  for (const section of source.split(/^## /m).slice(1)) {
    if (out.length >= count) break;
    const heading = section.split("\n", 1)[0]!.trim();
    const m = /^(\d+\.\d+\.\d+)(?: \((\d{4}-\d{2}-\d{2})\))?$/.exec(heading);
    if (!m) continue; // "Unreleased"
    const found = [...section.matchAll(/^- \*\*(.+?)\*\*/gm)].map((b) => b[1]!.replace(/[.:]$/, "").trim());
    if (!found.length) continue;
    out.push({ version: m[1]!, date: m[2] ?? null, heading, titles: found.slice(0, titles) });
  }
  return out;
}

/** The latest released version, or null. */
export function latestVersion(source: string): string | null {
  return /^## (\d+\.\d+\.\d+)/m.exec(source)?.[1] ?? null;
}
