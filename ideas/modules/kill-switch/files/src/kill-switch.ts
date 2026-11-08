import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AuditLog, type AuditEntry } from "highwire-agent";
import { HOME, highwire } from "./highwire.ts";

// The kill-switch module (modules/kill-switch.md): a second pair of eyes on the agent's wallet. On every wake-up it
// checks the wallet's balance, the audit log and the wallet's own transactions on-chain, and if anything is out of
// line it creates the STOP file next to the wallet. While STOP exists Highwire signs nothing: no trades, claims, order
// fills or posts. Only the user deletes it, once they've looked. The policy caps what the agent may do; this catches
// what the caps don't: a loop spending faster than it should, sends failing over and over, an agent trying things the
// policy refuses, and above all transactions the wallet signed that Highwire didn't send.

export interface KillRules {
  min_balance_sol: number;
  max_sol_per_hour: number;
  max_failed_per_day: number;
  max_refused_per_hour: number;
  foreign_signatures: boolean;
}

const RANGES: Record<Exclude<keyof KillRules, "foreign_signatures">, [number, number]> = {
  min_balance_sol: [0, 100],
  max_sol_per_hour: [0.001, 1000],
  max_failed_per_day: [1, 100],
  max_refused_per_hour: [1, 1000],
};

export function readKillRules(path: URL | string = new URL("../kill-switch.json", import.meta.url)): KillRules {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    const v = raw[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`kill-switch.json: ${k} must be a number from ${lo} to ${hi}`);
  }
  if (typeof raw.foreign_signatures !== "boolean") throw new Error("kill-switch.json: foreign_signatures must be true or false");
  return raw as unknown as KillRules;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sol = (n: number) => (n >= 0.01 ? n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : String(Number(n.toPrecision(2))));

export interface KillFacts {
  rules: KillRules;
  /** The wallet's audit log entries. */
  entries: AuditEntry[];
  now: Date;
  /** Count nothing before this: when watching started, or the user last deleted STOP. */
  since: string;
  /** The wallet's SOL; undefined when the RPC couldn't say, which never stops anything. */
  balanceSol?: number;
  /** Transactions the wallet signed on-chain that aren't in the audit log. */
  foreign: string[];
}

/** Why the agent should stop, or nothing. Pure: everything it needs is in `f`. */
export function checkKill(f: KillFacts): string[] {
  const r = f.rules;
  const since = Date.parse(f.since);
  const within = (e: AuditEntry, ms: number) => {
    const t = Date.parse(e.time);
    return t >= since && t >= f.now.getTime() - ms;
  };
  const reasons: string[] = [];
  if (f.foreign.length) {
    reasons.push(
      `the wallet signed ${f.foreign.length === 1 ? "a transaction" : `${f.foreign.length} transactions`} Highwire didn't send (${f.foreign.join(", ")}). If that wasn't you, someone else may have the key: move what's left to a wallet only you control`,
    );
  }
  if (f.balanceSol !== undefined && f.balanceSol < r.min_balance_sol) {
    reasons.push(`the wallet holds ${sol(f.balanceSol)} SOL, under the ${r.min_balance_sol} SOL floor`);
  }
  const spent = f.entries.filter((e) => e.outcome === "sent" && within(e, HOUR)).reduce((s, e) => s + Number(e.lamports) / 1e9, 0);
  if (spent > r.max_sol_per_hour) reasons.push(`it spent ${sol(spent)} SOL in the last hour, over the ${r.max_sol_per_hour} SOL an hour it's allowed`);
  const failed = f.entries.filter((e) => e.outcome === "failed" && within(e, DAY)).length;
  if (failed >= r.max_failed_per_day) reasons.push(`${failed} sends failed in the last day`);
  // The order runner retries a fill the policy refuses (over the day's cap, say): that's the policy working. Refusals
  // of the agent's own calls mean it's trying things the policy doesn't allow.
  const refused = f.entries.filter((e) => e.outcome === "refused" && !e.order && within(e, HOUR)).length;
  if (refused >= r.max_refused_per_hour) reasons.push(`the policy refused ${refused} of the agent's own calls in the last hour`);
  return reasons;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T | undefined> {
  try {
    const res = await fetch(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: T };
    return body.result ?? undefined;
  } catch {
    return undefined;
  }
}

async function balanceSol(wallet: string): Promise<number | undefined> {
  const r = await rpc<{ value?: number }>("getBalance", [wallet, { commitment: "confirmed" }]);
  return typeof r?.value === "number" ? r.value / 1e9 : undefined;
}

/**
 * The wallet's recent transactions since `sinceMs` that it signed but that aren't in `known` (the audit log's
 * signatures). Incoming transfers don't count: the wallet didn't sign them. `checked` lists what it looked at, so the
 * next wake-up doesn't fetch them again; it looks at ten new ones at most per call.
 */
async function foreignSignatures(wallet: string, sinceMs: number, known: Set<string>): Promise<{ foreign: string[]; checked: string[] }> {
  const sigs = (await rpc<{ signature: string; blockTime?: number | null }[]>("getSignaturesForAddress", [wallet, { limit: 50, commitment: "confirmed" }])) ?? [];
  const foreign: string[] = [];
  const checked: string[] = [];
  for (const s of sigs.filter((x) => !known.has(x.signature) && (x.blockTime ?? Infinity) * 1000 >= sinceMs).slice(0, 10)) {
    const tx = await rpc<{ transaction: { message: { accountKeys: string[]; header: { numRequiredSignatures: number } } } }>("getTransaction", [
      s.signature,
      { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    ]);
    if (!tx) continue;
    checked.push(s.signature);
    const { accountKeys, header } = tx.transaction.message;
    if (accountKeys.slice(0, header.numRequiredSignatures).includes(wallet)) foreign.push(s.signature);
  }
  return { foreign, checked };
}

interface State {
  /** Counting starts here: the first wake-up, or when the user deleted STOP. */
  since: string;
  trippedAt?: string;
  reason?: string;
  /** Signatures already looked at that the wallet didn't sign, or that were already reported. */
  seen: string[];
}

/** A desktop notification on a Mac, best effort. */
function notify(text: string) {
  if (process.platform !== "darwin") return;
  const q = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;
  execFile("osascript", ["-e", `display notification ${q(text.slice(0, 200))} with title "Highwire kill switch"`], () => {});
}

export interface KillCheck {
  stopped: boolean;
  line: string;
}

/** One look: stops the agent if anything is out of line, and says what it found. Never deletes STOP. */
export async function checkKillSwitch(opts: { rules?: KillRules; now?: Date } = {}): Promise<KillCheck> {
  const rules = opts.rules ?? readKillRules();
  const now = opts.now ?? new Date();
  const stopPath = join(HOME, "STOP");
  const statePath = join(HOME, "kill-switch-state.json");
  let state: State = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as State) : { since: now.toISOString(), seen: [] };
  const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });

  if (existsSync(stopPath)) {
    return {
      stopped: true,
      line: state.trippedAt ? `Stopped since ${state.trippedAt}: ${state.reason}. Check, then delete ${stopPath} to resume.` : `Stopped: ${stopPath} exists, so nothing is signed until it's deleted.`,
    };
  }
  let prefix = "";
  if (state.trippedAt) {
    state = { since: now.toISOString(), seen: state.seen };
    prefix = "STOP was deleted, so the kill switch counts again from now. ";
  }
  let live = false;
  try {
    live = (JSON.parse(readFileSync(join(HOME, "policy.json"), "utf8")) as { live?: boolean }).live === true;
  } catch {
    /* no policy: nothing is signed anyway */
  }
  if (!live) {
    // Nothing is signed in a dry run, so watching starts when it goes live.
    state = { ...state, since: now.toISOString() };
    save();
    return { stopped: false, line: `${prefix}The policy is a dry run; the kill switch watches once it's live.` };
  }
  const address = await highwire(["wallet", "address"]);
  if (!address.ok) return { stopped: false, line: `${prefix}Couldn't read the wallet's address: ${address.err || address.out}` };
  const wallet = address.out;

  const entries = new AuditLog(join(HOME, "audit.jsonl")).entries().filter((e) => e.wallet === wallet);
  const known = new Set([...state.seen, ...entries.flatMap((e) => (e.signature ? [e.signature] : []))]);
  const { foreign, checked } = rules.foreign_signatures ? await foreignSignatures(wallet, Date.parse(state.since), known) : { foreign: [], checked: [] };
  state.seen = [...state.seen, ...checked].slice(-500);
  const reasons = checkKill({ rules, entries, now, since: state.since, balanceSol: await balanceSol(wallet), foreign });
  if (!reasons.length) {
    save();
    return { stopped: false, line: `${prefix}Kill switch: nothing out of line.` };
  }
  const reason = reasons.join("; ");
  writeFileSync(
    stopPath,
    `Stopped by the kill switch at ${now.toISOString()}:\n${reasons.map((r) => `- ${r}`).join("\n")}\n\nNothing is signed while this file exists. Check the audit log (${join(HOME, "audit.jsonl")}), then delete this file to resume.\n`,
  );
  state = { ...state, trippedAt: now.toISOString(), reason };
  save();
  notify(`Stopped: ${reason}`);
  return { stopped: true, line: `${prefix}STOPPED by the kill switch: ${reason}. Nothing is signed until ${stopPath} is deleted.` };
}

// `npm run kill-switch`: one look, now.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await checkKillSwitch();
  console.log(r.line);
}
