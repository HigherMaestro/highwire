// Vercel's ignored build step for the site (vercel.json's `ignoreCommand`, docs/boundaries.md 5.3). Vercel runs it in
// apps/web before installing anything, so it's plain Node with no dependencies. Exit 0 skips the build; exit 1 builds.
//
// It skips only when EVERY file changed since the last deployed commit is under a short list of paths the site can't
// see. Anything else, and anything it can't work out, builds: a mistake here should cost a build, never leave the site
// stale. The list is paths to skip, not paths to build, for the same reason: the site reads files outside its folder
// at build time (CHANGELOG.md, ideas/, packages/mcp/package.json, every package it imports), and a list of what to
// build would miss the next one.
//
//   node scripts/ignore-build.mjs                          as Vercel runs it (reads VERCEL_GIT_PREVIOUS_SHA and git)
//   node scripts/ignore-build.mjs --files a/b.ts c/d.rs    decide for these paths instead (tests, and checking a list)
import { execFileSync } from "node:child_process";

/**
 * Paths the site's build never reads: the wager program, research notes, every package's tests and scripts, and CI's
 * own files. Whole folders only, never a file type: a `.rs` file under apps/web/public would be something the site
 * serves.
 */
export const SKIPPABLE = [/^programs\//, /^docs\/research\//, /^packages\/[^/]+\/test\//, /^packages\/[^/]+\/scripts\//, /^\.github\//];

/** Whether a build may be skipped for these changed paths (from the repository's root): all of them skippable, and at least one. */
export function maySkip(files) {
  return files.length > 0 && files.every((f) => SKIPPABLE.some((re) => re.test(f)));
}

const say = (line) => console.log(`[ignore-build] ${line}`);

/** The paths changed between the last deployed commit and this one, or null when that can't be known. */
function changedSinceLastDeploy() {
  const previous = process.env.VERCEL_GIT_PREVIOUS_SHA;
  // No earlier deployment of this branch, or not on Vercel at all.
  if (!previous) return say("no earlier deployment to compare with"), null;
  if (!/^[0-9a-f]{7,64}$/.test(previous)) return say("the earlier deployment's commit isn't a commit id"), null;
  try {
    // Vercel's clone is shallow: an older commit may simply not be there.
    execFileSync("git", ["cat-file", "-e", `${previous}^{commit}`], { stdio: "ignore" });
    const out = execFileSync("git", ["diff", "--name-only", "-z", "--no-renames", previous, "HEAD"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return out.split("\0").filter(Boolean);
  } catch {
    return say(`can't compare with ${previous.slice(0, 12)} (not in this clone, or git failed)`), null;
  }
}

const at = process.argv.indexOf("--files");
const files = at >= 0 ? process.argv.slice(at + 1) : changedSinceLastDeploy();

if (files === null) {
  say("building");
  process.exit(1);
}
if (maySkip(files)) {
  say(`skipping: all ${files.length} changed file(s) are outside what the site reads`);
  process.exit(0);
}
const seen = files.filter((f) => !SKIPPABLE.some((re) => re.test(f)));
// No change at all is a redeploy asked for on purpose (a setting changed): build it.
say(files.length ? `building: ${seen.length} of ${files.length} changed file(s) may reach the site, e.g. ${seen[0]}` : "building: nothing changed, so this is a redeploy");
process.exit(1);
