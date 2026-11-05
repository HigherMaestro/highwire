import { existsSync } from "node:fs";
import { Buffer } from "node:buffer";
import { VersionedTransaction, type Connection, type Keypair } from "@solana/web3.js";
import {
  HigherError,
  isRefreshable,
  lamportsNumber,
  UnsafeTransactionError,
  withBlockhash,
  type Cluster,
  type Envelope,
} from "highwire-core";
import { AuditLog } from "./audit.ts";
import type { AgentPaths } from "./paths.ts";
import { checkPolicy, loadPolicy, plural, type Action, type Intent, type Policy } from "./policy.ts";

// The local signer: signs and sends what Highwire built, for the one wallet whose
// keypair the user pointed it at, and only inside the user's policy. Dry run
// unless the policy says "live": true. Every execute, refused or not, is
// written to the audit log. Executes run one at a time, so two calls can't both
// fit under the daily limit.

export interface ExecuteRequest {
  /** The tool that asked, for the audit log. */
  tool: string;
  intent: Intent;
  envelope: Envelope;
}

export interface ExecutedTransaction {
  index: number;
  label: string;
  signature: string;
  confirmed: boolean;
  error?: string;
  /** The wallet's SOL balance change, fees included, once confirmed. */
  solChange?: number;
  /** The wallet's balance change in the coin traded or sent, in whole tokens. */
  tokenChange?: number;
}

export interface ExecuteResult {
  status: "dry_run" | "sent" | "partly_sent";
  wallet: string;
  cluster: Cluster;
  /** What was signed and sent; empty on a dry run. */
  transactions: ExecutedTransaction[];
  /** What would be signed, decoded from the bytes (on a dry run, what was checked). */
  summary: string[][];
  /** SOL counted against the daily limit, and what's left of it. */
  spentSol: number;
  dayLeftSol: number;
}

export interface SignerStatus {
  wallet: string;
  keypairWarning?: string;
  policyPath: string;
  auditPath: string;
  stopped: boolean;
  policy: Policy | null;
  policyProblem?: string;
  /** SOL spent in the last 24 hours on the policy's cluster. */
  spentTodaySol?: number;
  dayLeftSol?: number;
}

const refused = (rule: string, reason: string) => new HigherError(`The policy refused this: ${reason}.`, { code: "policy_refused", body: { rule } });

export class LocalSigner {
  readonly audit: AuditLog;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly keypair: Keypair,
    readonly paths: AgentPaths,
    readonly keypairWarning?: string,
    now: () => Date = () => new Date(),
  ) {
    this.audit = new AuditLog(paths.audit, now);
  }

  get wallet(): string {
    return this.keypair.publicKey.toBase58();
  }

  get publicKey() {
    return this.keypair.publicKey;
  }

  status(): SignerStatus {
    const base = { wallet: this.wallet, keypairWarning: this.keypairWarning, policyPath: this.paths.policy, auditPath: this.paths.audit, stopped: existsSync(this.paths.stop) };
    try {
      const policy = loadPolicy(this.paths.policy);
      const spent = this.audit.spentSince(policy.cluster);
      const day = Math.max(0, policy.max_sol_per_day - lamportsNumber(spent));
      return { ...base, policy, spentTodaySol: lamportsNumber(spent), dayLeftSol: Math.round(day * 1e9) / 1e9 };
    } catch (err) {
      return { ...base, policy: null, policyProblem: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * The checks that need no build: the kill switch, a usable policy, the cluster and the action. Throws when refused;
   * with `tool`, the refusal goes in the audit log.
   */
  precheck(action: Action, cluster: Cluster, tool?: string): Policy {
    try {
      return this.checkStatic(action, cluster);
    } catch (err) {
      if (tool) this.log({ tool, intent: { action, cluster, solOut: 0n } }, "refused", { reason: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  private checkStatic(action: Action, cluster: Cluster): Policy {
    if (existsSync(this.paths.stop)) {
      throw new HigherError(`Stopped: ${this.paths.stop} exists, so nothing executes until the user removes it.`, { code: "signer_stopped" });
    }
    const policy = loadPolicy(this.paths.policy);
    if (policy.cluster !== cluster) throw refused("cluster", `the policy is for ${policy.cluster}, and this server builds on ${cluster}`);
    if (!policy.actions.includes(action)) throw refused("actions", `the policy doesn't allow ${plural(action)}`);
    return policy;
  }

  /** Checks the built envelope against the policy, then signs and sends it, or dry-runs it. */
  execute(connection: Connection, req: ExecuteRequest): Promise<ExecuteResult> {
    const run = this.queue.then(() => this.executeNow(connection, req));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private log(req: Pick<ExecuteRequest, "tool" | "intent">, outcome: "refused" | "dry_run" | "sent" | "confirmed" | "failed", extra: { lamports?: bigint; label?: string; signature?: string; reason?: string } = {}) {
    const lamports = extra.lamports ?? 0n;
    this.audit.append({
      tool: req.tool,
      action: req.intent.action,
      cluster: req.intent.cluster,
      wallet: this.wallet,
      outcome,
      sol: String(lamportsNumber(lamports)),
      lamports: lamports.toString(),
      ...(req.intent.mint ? { mint: req.intent.mint } : {}),
      ...(req.intent.recipient ? { recipient: req.intent.recipient } : {}),
      ...(extra.label ? { label: extra.label } : {}),
      ...(extra.signature ? { signature: extra.signature } : {}),
      ...(extra.reason ? { reason: extra.reason } : {}),
    });
  }

  private async executeNow(connection: Connection, req: ExecuteRequest): Promise<ExecuteResult> {
    const { intent, envelope: env } = req;
    let policy: Policy;
    try {
      policy = this.checkStatic(intent.action, intent.cluster);
      if (env.wallet !== this.wallet || env.cluster !== intent.cluster) throw new UnsafeTransactionError("the transactions aren't for this signer's wallet and cluster");
      const failed = env.transactions.find((t) => !t.simulation.ok && !t.simulation.skipped);
      if (failed) throw new HigherError(`Transaction ${failed.index + 1} (${failed.label}) failed simulation: ${failed.simulation.error}`, { code: "simulation_failed" });
      const refusal = checkPolicy(policy, intent, this.audit.spentSince(intent.cluster));
      if (refusal) throw refused(refusal.rule, refusal.reason);
    } catch (err) {
      this.log(req, "refused", { lamports: intent.solOut, reason: err instanceof Error ? err.message : String(err) });
      throw err;
    }

    const summary = env.transactions.map((t) => t.summary);
    const dayLeft = (spent: bigint) => Math.max(0, Math.round((policy.max_sol_per_day - lamportsNumber(spent)) * 1e9) / 1e9);
    if (!policy.live) {
      this.log(req, "dry_run", { lamports: intent.solOut });
      const spent = this.audit.spentSince(intent.cluster);
      return { status: "dry_run", wallet: this.wallet, cluster: intent.cluster, transactions: [], summary, spentSol: 0, dayLeftSol: dayLeft(spent) };
    }

    const sent: ExecutedTransaction[] = [];
    for (const t of env.transactions) {
      let tx = VersionedTransaction.deserialize(Buffer.from(t.base64, "base64"));
      if (!tx.message.staticAccountKeys[0]?.equals(this.publicKey)) throw new UnsafeTransactionError("a transaction isn't paid by this signer's wallet");
      // A later transaction waited for the one before to confirm; give it a fresh blockhash when only the wallet signs.
      let lastValidBlockHeight = t.lastValidBlockHeight;
      if (t.index > 0 && isRefreshable(tx, this.wallet)) {
        const latest = await connection.getLatestBlockhash("confirmed");
        tx = withBlockhash(tx, this.wallet, latest.blockhash);
        lastValidBlockHeight = latest.lastValidBlockHeight;
      }
      // Simulate again right before signing: the chain may have moved since the build, and a dependent transaction
      // couldn't be simulated until the one before it landed.
      const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
      if (sim.value.err) {
        const reason = `transaction ${t.index + 1} (${t.label}) no longer simulates: ${JSON.stringify(sim.value.err)}`;
        this.log(req, "failed", { label: t.label, reason });
        if (sent.length === 0) throw new HigherError(`Nothing was sent: ${reason}.`, { code: "simulation_failed", body: { logs: (sim.value.logs ?? []).slice(-12) } });
        return this.partial(intent, sent, summary, reason, dayLeft);
      }
      tx.sign([this.keypair]);
      const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
      // Counted the moment it's sent: the whole spend goes on the first transaction.
      this.log(req, "sent", { lamports: sent.length === 0 ? intent.solOut : 0n, label: t.label, signature });
      const done: ExecutedTransaction = { index: t.index, label: t.label, signature, confirmed: false };
      sent.push(done);
      try {
        const res = await connection.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight }, "confirmed");
        if (res.value.err) throw new Error(JSON.stringify(res.value.err));
      } catch (err) {
        done.error = err instanceof Error ? err.message : String(err);
        this.log(req, "failed", { label: t.label, signature, reason: done.error });
        return this.partial(intent, sent, summary, `transaction ${t.index + 1} didn't confirm: ${done.error}`, dayLeft);
      }
      done.confirmed = true;
      this.log(req, "confirmed", { label: t.label, signature });
      Object.assign(done, await this.fills(connection, signature, intent.mint));
    }
    return { status: "sent", wallet: this.wallet, cluster: intent.cluster, transactions: sent, summary, spentSol: lamportsNumber(intent.solOut), dayLeftSol: dayLeft(this.audit.spentSince(intent.cluster)) };
  }

  private partial(intent: Intent, sent: ExecutedTransaction[], summary: string[][], reason: string, dayLeft: (spent: bigint) => number): ExecuteResult {
    if (sent.length === 0) throw new HigherError(reason, { code: "send_failed" });
    const last = sent[sent.length - 1]!;
    last.error ??= reason;
    return {
      status: "partly_sent",
      wallet: this.wallet,
      cluster: intent.cluster,
      transactions: sent,
      summary,
      spentSol: lamportsNumber(intent.solOut),
      dayLeftSol: dayLeft(this.audit.spentSince(intent.cluster)),
    };
  }

  /** The wallet's balance changes in a confirmed transaction. Best effort: a missing answer just leaves them out. */
  private async fills(connection: Connection, signature: string, mint?: string): Promise<Pick<ExecutedTransaction, "solChange" | "tokenChange">> {
    try {
      const got = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const meta = got?.meta;
      if (!meta) return {};
      const out: Pick<ExecutedTransaction, "solChange" | "tokenChange"> = {
        solChange: lamportsNumber(BigInt(meta.postBalances[0]! - meta.preBalances[0]!)),
      };
      if (mint) {
        const sum = (list: typeof meta.preTokenBalances) =>
          (list ?? []).filter((b) => b.mint === mint && b.owner === this.wallet).reduce((n, b) => n + (b.uiTokenAmount.uiAmount ?? 0), 0);
        out.tokenChange = Math.round((sum(meta.postTokenBalances) - sum(meta.preTokenBalances)) * 1e6) / 1e6;
      }
      return out;
    } catch {
      return {};
    }
  }
}
