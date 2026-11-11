import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname } from "node:path";
import type { Cluster } from "highwire-core";
import type { Action } from "./policy.ts";

/** Posts aren't an execute action: the policy's `posts` section allows them. */
export type AuditAction = Action | "post";

// The audit log: one JSON line per execute, whether it was refused, a dry run or
// signed. Signed entries are written as each transaction is sent, before it
// confirms, so a crash can't hide a spend. The daily limit is counted from here.

/**
 * signed_in: the signer signed higher.fun's sign-in message for a launch's uploads or a post; it moves no funds. order:
 * a standing order was placed, cancelled or closed (its fills are logged like any trade). posted: a comment or chat
 * message went up on higher.fun. not_landed: a protected send that provably never landed (the block engine refused it,
 * or its blockhash expired unseen), so its "sent" line no longer counts against the daily limit.
 */
export type Outcome = "refused" | "dry_run" | "sent" | "confirmed" | "failed" | "not_landed" | "signed_in" | "order" | "posted";

export interface AuditEntry {
  time: string;
  tool: string;
  action: AuditAction;
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
  /** The standing order this came from. */
  order?: string;
  /** A post's text, and where it went ("comment" or "chat"). */
  text?: string;
  where?: string;
  /** How a send went out: "jito" (a protected send) or "rpc"; its tip in lamports, and the block engine's bundle id. */
  route?: string;
  tip?: string;
  bundle?: string;
  /** A wager's series account. */
  series?: string;
  /** A wager's instruction ("open", "reveal", ...). */
  wager?: string;
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
    const entries = this.entries();
    // A send that provably never landed spent nothing.
    const unlanded = new Set(entries.filter((e) => e.outcome === "not_landed" && e.signature).map((e) => e.signature));
    let total = 0n;
    for (const e of entries) {
      if (e.outcome !== "sent" || e.cluster !== cluster) continue;
      if (e.signature && unlanded.has(e.signature)) continue;
      if (Date.parse(e.time) < since) continue;
      total += BigInt(e.lamports);
    }
    return total;
  }

  /** The log's clock, in milliseconds: what "the last 24 hours" is measured from. */
  nowMs(): number {
    return this.now().getTime();
  }

  /** Posts sent in the last 24 hours, for the policy's daily cap: each counts once (its "sent" line), up or not. */
  postsSince(ms = DAY_MS): number {
    const since = this.now().getTime() - ms;
    return this.entries().filter((e) => e.action === "post" && e.outcome === "sent" && Date.parse(e.time) >= since).length;
  }
}
