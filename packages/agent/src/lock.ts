import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { HigherError } from "highwire-core";

// One execute at a time across every Highwire process on this machine that shares a HIGHWIRE_HOME: two MCP clients
// running their own servers would otherwise both check the daily limit before either had logged its send. The lock
// is a file created with O_EXCL, holding the owner's pid. A lock whose process is gone, or that is older than any
// execute could take, is taken over.

const STALE_MS = 10 * 60 * 1000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function stale(path: string, now: number): boolean {
  try {
    const { pid, at } = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; at?: number };
    if (typeof pid !== "number" || typeof at !== "number") return true;
    return !alive(pid) || now - at > STALE_MS;
  } catch {
    // Unreadable or half-written: give its writer a moment, then treat it as abandoned.
    return false;
  }
}

/** Runs `fn` holding the lock at `path`, waiting up to `waitMs` for another process to release it. */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, waitMs = 90_000): Promise<T> {
  const deadline = Date.now() + waitMs;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(path, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (stale(path, Date.now())) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new HigherError(`Another Highwire process is executing (lock ${path}). Try again when it's done.`, { code: "signer_busy" });
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    closeSync(fd);
    rmSync(path, { force: true });
  }
}

/** The pid holding a process lock, if that process is still running. */
export function lockHolder(path: string): number | null {
  try {
    const { pid } = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
    return typeof pid === "number" && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Holds the lock at `path` for as long as this process wants it, unlike withFileLock's short holds: it's stale only
 * once its process is gone. Returns the release, or throws when another live process holds it.
 */
export function holdProcessLock(path: string, what: string): () => void {
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        if (lockHolder(path) === process.pid) rmSync(path, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = lockHolder(path);
      if (pid !== null || attempt > 0) {
        throw new HigherError(`${what} is already running${pid !== null ? ` (pid ${pid})` : ""}; only one may run at a time (lock ${path}).`, { code: "already_running" });
      }
      rmSync(path, { force: true });
    }
  }
}
