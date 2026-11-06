import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Keypair } from "@solana/web3.js";
import { HigherError } from "highwire-core";

// Loads the local signer's keypair from the file HIGHWIRE_KEYPAIR_PATH names, in
// the Solana CLI's format (a JSON array of 64 bytes). The key is only ever read
// from that file: never from a tool argument or an environment value. Errors
// never include the file's contents.

/**
 * Makes a new keypair file in the Solana CLI's format, readable only by the user, for `highwire wallet new`. It never
 * overwrites a file (an existing wallet may hold funds) and returns only the public address: the key stays in the file.
 */
export function createKeypairFile(path: string): { address: string; written: boolean } {
  try {
    return { address: loadKeypair(path).keypair.publicKey.toBase58(), written: false };
  } catch (err) {
    if (!(err instanceof HigherError) || err.code !== "no_keypair") throw err;
  }
  const keypair = Keypair.generate();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)) + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return { address: keypair.publicKey.toBase58(), written: true };
}

export interface LoadedKeypair {
  keypair: Keypair;
  /** Set when other users on the machine can read the file. */
  warning?: string;
}

export function loadKeypair(path: string): LoadedKeypair {
  let text: string;
  let mode: number;
  try {
    mode = statSync(path).mode;
    text = readFileSync(path, "utf8");
  } catch {
    throw new HigherError(`Can't read the keypair file at ${path}.`, { code: "no_keypair" });
  }
  let bytes: unknown;
  try {
    bytes = JSON.parse(text);
  } catch {
    bytes = null;
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new HigherError(`The keypair file at ${path} isn't a Solana CLI keypair (a JSON array of 64 numbers).`, { code: "bad_keypair" });
  }
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
  } catch {
    throw new HigherError(`The keypair file at ${path} doesn't hold a valid keypair.`, { code: "bad_keypair" });
  }
  const warning =
    process.platform !== "win32" && (mode & 0o077) !== 0
      ? `${path} can be read by other users on this machine; run chmod 600 on it.`
      : undefined;
  return { keypair, ...(warning ? { warning } : {}) };
}
