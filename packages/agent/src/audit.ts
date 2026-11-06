import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname } from "node:path";
import type { Cluster } from "highwire-core";
import type { Action } from "./policy.ts";

// The audit log: one JSON line per execute, whether it was refused, a dry run or
// signed. Signed entries are written as each transaction is sent, before it
// confirms, so a crash can't hide a spend. The daily limit is counted from here.

/** signed_in: the signer signed higher.fun's sign-in message for a launch's uploads; it moves no funds. */
export type Outcome = "refused" | "dry_run" | "sent" | "confirmed" | "failed" | "signed_in";

export interface AuditEntry {
  time: string;
  tool: string;
  action: Action;
  cluster: Cluster;
  wallet: string;
  outcome: Outcome;
  /** SOL the execute spends, as counted against the policy (a decimal string, in SOL). */
  sol: string;
  /** Lamports, for the daily count. */
  lamports: string;
  mint?: string;
  recipient?: string;
  label?: string;
  signature?: string;
  reason?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function endsWithNewline(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

export class AuditLog {
  constructor(
    readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  append(entry: Omit<AuditEntry, "time">): AuditEntry {
    const full: AuditEntry = { time: this.now().toISOString(), ...entry };
    const fresh = !existsSync(this.path);
    if (fresh) mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // If a crash left a torn last line, start on a new one, or this entry would be lost with it.
    const torn = !fresh && !endsWithNewline(this.path);
    appendFileSync(this.path, (torn ? "\n" : "") + JSON.stringify(full) + "\n", { mode: 0o600 });
    if (fresh) chmodSync(this.path, 0o600);
    return full;
  }

  entries(): AuditEntry[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const out: AuditEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as AuditEntry);
      } catch {
        /* a torn last line */
      }
    }
    return out;
  }

  /**
   * Lamports spent in the last 24 hours on `cluster`: every sent transaction counts, confirmed or not, since one that
   * didn't confirm may still land. Each send is counted once (its "sent" line), with its share of the execute's spend.
   */
  spentSince(cluster: Cluster, ms = DAY_MS): bigint {
    const since = this.now().getTime() - ms;
    let total = 0n;
    for (const e of this.entries()) {
      if (e.outcome !== "sent" || e.cluster !== cluster) continue;
      if (Date.parse(e.time) < since) continue;
      total += BigInt(e.lamports);
    }
    return total;
  }
}
