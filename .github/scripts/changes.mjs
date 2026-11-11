// Decides whether a push or pull request needs the wager program's tests (`npm run test:program`: the Rust toolchain,
// several minutes). They run when anything they depend on changed, and whenever this can't tell. No dependencies: it
// runs before the install.
//
//   node .github/scripts/changes.mjs                 in CI: BASE is the commit to compare with; writes to GITHUB_OUTPUT
//   node .github/scripts/changes.mjs --files a b c   decide for these paths (tests); prints program=true or program=false
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/** What the program's tests read: the program, the rules it mirrors, the codec, the fixture writers, and CI itself. */
export const PROGRAM_INPUTS = [
  /^programs\//,
  /^packages\/core\/src\/arena\//,
  /^packages\/wager\/src\/codec\.ts$/,
  /^packages\/core\/scripts\/wager-fixtures\.ts$/,
  /^packages\/wager\/scripts\/wager-instructions\.ts$/,
  /^packages\/core\/test\/fixtures\/wager-codec\.json$/,
  /^package(-lock)?\.json$/,
  /^\.github\//,
];

export const touchesProgram = (files) => files.some((f) => PROGRAM_INPUTS.some((re) => re.test(f)));

function changed() {
  const base = process.env.BASE;
  // A new branch's first push has no commit before it (forty zeros), and a missing one can't be compared with.
  if (!base || !/^[0-9a-f]{40,64}$/.test(base) || /^0+$/.test(base)) return null;
  try {
    // Three dots: what this branch changed since it left the base, not what the base gained meanwhile.
    return execFileSync("git", ["diff", "--name-only", "-z", "--no-renames", `${base}...HEAD`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

const at = process.argv.indexOf("--files");
const files = at >= 0 ? process.argv.slice(at + 1) : changed();
const program = files === null ? true : touchesProgram(files);
console.log(files === null ? "can't tell what changed: running the program's tests" : `${files.length} file(s) changed`);
console.log(`program=${program}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `program=${program}\n`);
