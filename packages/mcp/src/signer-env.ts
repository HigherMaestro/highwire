import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { agentPaths, loadKeypair, LocalSigner, POLICY_TEMPLATE, type AgentPaths } from "highwire-agent";

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
