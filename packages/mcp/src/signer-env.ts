import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { agentPaths, loadKeypair, loadPolicy, LocalSigner, POLICY_TEMPLATE, policyWarnings, type AgentPaths } from "highwire-agent";

// The local signer, for the stdio server only: turned on by HIGHWIRE_KEYPAIR_PATH, which names a keypair file on the
// user's machine. The hosted route never imports this file.

type Env = Record<string, string | undefined>;

/** The signer HIGHWIRE_KEYPAIR_PATH asks for, or undefined. Warnings go to stderr, never the key. */
export function signerFromEnv(env: Env = process.env, warn: (msg: string) => void = console.error): LocalSigner | undefined {
  const path = env.HIGHWIRE_KEYPAIR_PATH?.trim();
  if (!path) return undefined;
  const { keypair, warning } = loadKeypair(path);
  if (warning) warn(`[highwire] ${warning}`);
  const paths = agentPaths(env);
  if (!existsSync(paths.policy)) warn(`[highwire] Local signer on for ${keypair.publicKey.toBase58()}, but there's no policy at ${paths.policy}, so nothing executes. Run: highwire policy init`);
  try {
    for (const w of policyWarnings(loadPolicy(paths.policy))) warn(`[highwire] ${w}`);
  } catch {
    /* no usable policy: said above, or by get_signer_status */
  }
  // Anyone who can write the policy or the audit log can raise the limits or reset the day's count.
  for (const [what, path] of [["policy", paths.policy], ["folder", paths.home]] as const) {
    try {
      const st = statSync(path);
      if (st.mode & 0o022) warn(`[highwire] Your signer ${what} ${path} can be changed by other users on this machine. Run: chmod go-w ${path}`);
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) warn(`[highwire] Your signer ${what} ${path} belongs to another user.`);
    } catch {
      /* missing: said above */
    }
  }
  return new LocalSigner(keypair, paths, warning);
}

/** Writes the starting policy (devnet, dry run) unless one exists. Returns where it is and whether it was written. */
export function initPolicy(paths: AgentPaths = agentPaths()): { path: string; written: boolean } {
  if (existsSync(paths.policy)) return { path: paths.policy, written: false };
  mkdirSync(dirname(paths.policy), { recursive: true, mode: 0o700 });
  writeFileSync(paths.policy, JSON.stringify(POLICY_TEMPLATE, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(paths.policy, 0o600);
  return { path: paths.policy, written: true };
}

/**
 * The local server's launch secret: HIGHWIRE_LAUNCH_SECRET if set, else a random one kept in HIGHWIRE_HOME
 * (`launch-secret`, readable only by the user), made on first use. Launch mints derive from it, so a retried launch
 * finds the coin it already created even after the server restarted, instead of making a second one.
 */
export function localLaunchSecret(env: Env = process.env, paths: AgentPaths = agentPaths(env)): string {
  if (env.HIGHWIRE_LAUNCH_SECRET) return env.HIGHWIRE_LAUNCH_SECRET;
  const file = join(paths.home, "launch-secret");
  try {
    const kept = readFileSync(file, "utf8").trim();
    if (kept.length >= 32) return kept;
  } catch {
    /* not made yet */
  }
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("hex");
  try {
    writeFileSync(file, secret + "\n", { mode: 0o600, flag: "wx" });
  } catch {
    // Another process made it first: use theirs.
    return readFileSync(file, "utf8").trim();
  }
  return secret;
}
