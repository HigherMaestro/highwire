import { lstatSync } from "node:fs";
import { Buffer } from "node:buffer";
import { VersionedTransaction, type Connection, type Keypair } from "@solana/web3.js";
import bs58 from "bs58";
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
import { withFileLock } from "./lock.ts";
import type { AgentPaths } from "./paths.ts";
import { checkPolicy, loadPolicy, plural, policyWarnings, type Action, type Intent, type Policy } from "./policy.ts";

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
  /** What the policy leaves open that the user may not mean to. */
  warnings?: string[];
  /** SOL spent in the last 24 hours on the policy's cluster. */
  spentTodaySol?: number;
  dayLeftSol?: number;
}

/** Each cluster's genesis hash: the RPC must be on the cluster the policy names, not just say so. */
export const GENESIS_HASHES: Record<Cluster, string> = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

/**
 * What a transaction may cost beyond the policy's per-transaction amount: rent for the accounts a trade or launch
 * opens, and network and priority fees. Everything the wallet actually spends still counts against the daily limit.
 */
export const RENT_AND_FEE_ALLOWANCE_LAMPORTS = 30_000_000n;

/** The kill switch: a STOP file, or anything else at that path, even a dangling link. */
function stopped(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

const lamportsOf = (sol: number) => BigInt(Math.round(sol * 1e9));

const refused = (rule: string, reason: string) => new HigherError(`The policy refused this: ${reason}.`, { code: "policy_refused", body: { rule } });

export class LocalSigner {
  readonly audit: AuditLog;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly verifiedRpcs = new WeakSet<Connection>();

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
    const base = { wallet: this.wallet, keypairWarning: this.keypairWarning, policyPath: this.paths.policy, auditPath: this.paths.audit, stopped: stopped(this.paths.stop) };
    try {
      const policy = loadPolicy(this.paths.policy);
      const spent = this.audit.spentSince(policy.cluster);
      const day = Math.max(0, policy.max_sol_per_day - lamportsNumber(spent));
      const warnings = policyWarnings(policy);
      return { ...base, policy, ...(warnings.length ? { warnings } : {}), spentTodaySol: lamportsNumber(spent), dayLeftSol: Math.round(day * 1e9) / 1e9 };
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
    if (stopped(this.paths.stop)) {
      throw new HigherError(`Stopped: ${this.paths.stop} exists, so nothing executes until the user removes it.`, { code: "signer_stopped" });
    }
    const policy = loadPolicy(this.paths.policy);
    if (policy.cluster !== cluster) throw refused("cluster", `the policy is for ${policy.cluster}, and this server builds on ${cluster}`);
    if (!policy.actions.includes(action)) throw refused("actions", `the policy doesn't allow ${plural(action)}`);
    return policy;
  }

  /** Checks the built envelope against the policy, then signs and sends it, or dry-runs it. */
  execute(connection: Connection, req: ExecuteRequest): Promise<ExecuteResult> {
    // One at a time in this process, and across processes through the lock file.
    const run = this.queue.then(() => withFileLock(this.paths.lock, () => this.executeNow(connection, req)));
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

    await this.checkRpcCluster(connection, intent.cluster);
    for (const t of env.transactions) {
      const tx = VersionedTransaction.deserialize(Buffer.from(t.base64, "base64"));
      if (!tx.message.staticAccountKeys[0]?.equals(this.publicKey)) throw new UnsafeTransactionError("a transaction isn't paid by this signer's wallet");
    }

    const perTx = lamportsOf(policy.max_sol_per_tx) + RENT_AND_FEE_ALLOWANCE_LAMPORTS;
    const perDay = lamportsOf(policy.max_sol_per_day);
    const sent: ExecutedTransaction[] = [];
    let charged = 0n;
    for (const t of env.transactions) {
      try {
        let tx = VersionedTransaction.deserialize(Buffer.from(t.base64, "base64"));
        // A later transaction waited for the one before to confirm; give it a fresh blockhash when only the wallet signs.
        let lastValidBlockHeight = t.lastValidBlockHeight;
        if (t.index > 0 && isRefreshable(tx, this.wallet)) {
          const latest = await connection.getLatestBlockhash("confirmed");
          tx = withBlockhash(tx, this.wallet, latest.blockhash);
          lastValidBlockHeight = latest.lastValidBlockHeight;
        }
        if (stopped(this.paths.stop)) throw new HigherError(`Stopped: ${this.paths.stop} appeared, so nothing more is sent.`, { code: "signer_stopped" });
        // Simulate again right before signing: the chain may have moved since the build, and a dependent transaction
        // couldn't be simulated until the one before it landed. The simulation also says what the wallet really spends,
        // rent and fees included, which is what counts against the limits.
        const [before, sim] = await Promise.all([
          connection.getBalance(this.publicKey, "confirmed"),
          connection.simulateTransaction(tx, {
            sigVerify: false,
            replaceRecentBlockhash: true,
            commitment: "confirmed",
            accounts: { encoding: "base64", addresses: [this.wallet] },
          }),
        ]);
        if (sim.value.err) {
          const reason = `transaction ${t.index + 1} (${t.label}) no longer simulates: ${JSON.stringify(sim.value.err)}`;
          this.log(req, "failed", { label: t.label, reason });
          if (sent.length === 0) throw new HigherError(`Nothing was sent: ${reason}.`, { code: "simulation_failed", body: { logs: (sim.value.logs ?? []).slice(-12) } });
          return this.partial(intent, sent, summary, reason, dayLeft, charged);
        }
        const after = sim.value.accounts?.[0]?.lamports;
        const delta = after == null ? 0n : BigInt(before) - BigInt(after);
        const simulated = delta > 0n ? delta : 0n;
        // What the simulation shows leaving the wallet, and never less than the intended spend on the first transaction.
        const floor = sent.length === 0 ? intent.solOut : 0n;
        const cost = simulated > floor ? simulated : floor;
        if (charged + cost > perTx) {
          throw refused("max_sol_per_tx", `it would spend ${lamportsNumber(charged + cost)} SOL, rent and fees included, past the policy's ${policy.max_sol_per_tx} SOL per transaction (plus ${lamportsNumber(RENT_AND_FEE_ALLOWANCE_LAMPORTS)} SOL for rent and fees)`);
        }
        if (this.audit.spentSince(intent.cluster) + cost > perDay) {
          throw refused("max_sol_per_day", `it would take the last 24 hours past the policy's ${policy.max_sol_per_day} SOL, rent and fees included`);
        }

        tx.sign([this.keypair]);
        const signature = bs58.encode(tx.signatures[0]!);
        // Logged, and counted, before it's sent: if the send's answer is lost, the spend still counts.
        this.log(req, "sent", { lamports: cost, label: t.label, signature });
        charged += cost;
        const done: ExecutedTransaction = { index: t.index, label: t.label, signature, confirmed: false };
        sent.push(done);
        try {
          await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
        } catch (err) {
          done.error = `the RPC didn't accept it (${err instanceof Error ? err.message : String(err)}); it may still land: check ${signature} before retrying`;
          this.log(req, "failed", { label: t.label, signature, reason: done.error });
          return this.partial(intent, sent, summary, done.error, dayLeft, charged);
        }
        try {
          const res = await connection.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight }, "confirmed");
          if (res.value.err) throw new Error(JSON.stringify(res.value.err));
        } catch (err) {
          done.error = err instanceof Error ? err.message : String(err);
          this.log(req, "failed", { label: t.label, signature, reason: done.error });
          return this.partial(intent, sent, summary, `transaction ${t.index + 1} didn't confirm: ${done.error}`, dayLeft, charged);
        }
        done.confirmed = true;
        this.log(req, "confirmed", { label: t.label, signature });
        Object.assign(done, await this.fills(connection, signature, intent.mint));
      } catch (err) {
        // After a send, any failure still returns what was sent, so the caller can check it before retrying.
        if (sent.length === 0) {
          if (err instanceof HigherError && err.code === "policy_refused") this.log(req, "refused", { lamports: intent.solOut, reason: err.message });
          throw err;
        }
        return this.partial(intent, sent, summary, err instanceof Error ? err.message : String(err), dayLeft, charged);
      }
    }
    return { status: "sent", wallet: this.wallet, cluster: intent.cluster, transactions: sent, summary, spentSol: lamportsNumber(charged), dayLeftSol: dayLeft(this.audit.spentSince(intent.cluster)) };
  }

  /** Once per RPC: its genesis hash must be the policy's cluster's, whatever HIGHWIRE_CLUSTER says. */
  private async checkRpcCluster(connection: Connection, cluster: Cluster): Promise<void> {
    if (this.verifiedRpcs.has(connection)) return;
    const genesis = await connection.getGenesisHash();
    if (genesis !== GENESIS_HASHES[cluster]) {
      throw refused("cluster", `the RPC is on a different cluster than ${cluster} (genesis hash ${genesis}); check SOLANA_RPC_URL`);
    }
    this.verifiedRpcs.add(connection);
  }

  private partial(intent: Intent, sent: ExecutedTransaction[], summary: string[][], reason: string, dayLeft: (spent: bigint) => number, charged: bigint): ExecuteResult {
    if (sent.length === 0) throw new HigherError(reason, { code: "send_failed" });
    const last = sent[sent.length - 1]!;
    last.error ??= reason;
    return {
      status: "partly_sent",
      wallet: this.wallet,
      cluster: intent.cluster,
      transactions: sent,
      summary,
      spentSol: lamportsNumber(charged),
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
