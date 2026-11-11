// The audit freeze (docs/boundaries.md 5.4). Once a commit has been sent to the auditors and tagged
// `audit/line-wager-<n>`, a pull request that changes what they were sent is flagged: it fails this check until the
// maintainer adds the label below, which is their say-so. Before any such tag exists, it passes and says so. No
// dependencies.
//
//   node .github/scripts/freeze.mjs    in CI: BASE is the pull request's base commit, LABELS its labels as JSON
import { execFileSync } from "node:child_process";

/** What the auditors are sent (docs/audit/line-wager.md, "Scope"), and what decides the binary they check. */
export const AUDITED = [/^programs\/line-wager\/src\//, /^programs\/line-wager\/Cargo\.(toml|lock)$/];
export const LABEL = "audited-program-change";
export const TAG_PATTERN = "audit/line-wager-*";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** The decision for a pull request: what it changed, whether an audit tag exists, and its labels. */
export function decide({ tags, files, labels }) {
  if (!tags.length) return { ok: true, why: `no ${TAG_PATTERN} tag yet: nothing is frozen` };
  const touched = files.filter((f) => AUDITED.some((re) => re.test(f)));
  if (!touched.length) return { ok: true, why: `nothing sent to the auditors (${tags[0]}) is changed` };
  if (labels.includes(LABEL)) return { ok: true, why: `changes the audited program, with the maintainer's "${LABEL}" label: ${touched.join(", ")}` };
  return {
    ok: false,
    why: `this changes what the auditors were sent (${tags[0]}): ${touched.join(", ")}. It needs the maintainer's say-so: the "${LABEL}" label on this pull request, and a note to the auditors.`,
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const base = process.env.BASE ?? "";
  let labels = [];
  try {
    labels = JSON.parse(process.env.LABELS || "[]");
  } catch {
    labels = [];
  }
  let tags = [], files = [];
  try {
    tags = git("tag", "--list", TAG_PATTERN, "--sort=-creatordate").split("\n").filter(Boolean);
    // If the base can't be compared with, treat everything audited as changed: the label decides.
    files = /^[0-9a-f]{40,64}$/.test(base) ? git("diff", "--name-only", "-z", "--no-renames", `${base}...HEAD`).split("\0").filter(Boolean) : ["programs/line-wager/src/ (the base commit is unknown)"];
  } catch (err) {
    console.log(`::error::the freeze check couldn't read the repository: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const d = decide({ tags, files, labels: Array.isArray(labels) ? labels.map(String) : [] });
  console.log(d.ok ? d.why : `::error::${d.why}`);
  process.exit(d.ok ? 0 : 1);
}
