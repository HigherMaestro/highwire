import { lstatSync } from "node:fs";
import { Buffer } from "node:buffer";
import { VersionedTransaction, type Connection, type Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import {
  checkPostText,
  checkSignInMessage,
  HigherError,
  isRefreshable,
  JITO_TIP_ACCOUNTS,
  jitoTipsOf,
  lamportsNumber,
  UnsafeTransactionError,
  withBlockhash,
  type Cluster,
  type Envelope,
  type JitoTip,
  type Posted,
  type PostWhere,
  type SignMessage,
} from "highwire-core";
import { AuditLog, type AuditAction } from "./audit.ts";
import { jitoClient, JitoRejected, tipFor, type JitoClient } from "./jito.ts";
import { withFileLock } from "./lock.ts";
import type { AgentPaths } from "./paths.ts";
import { checkPolicy, loadPolicy, plural, policyWarnings, type Action, type Intent, type Policy } from "./policy.ts";

// The local signer: signs and sends what Highwire built, for the one wallet whose
// keypair the user pointed it at, and only inside the user's policy. Dry run
// unless the policy says "live": true. Every execute, refused or not, is
// written to the audit log. Executes run one at a time, so two calls can't both
// fit under the daily limit.

/** A comment or chat message to post on higher.fun as the signer's wallet. */
export interface PostRequest {
  tool: string;
  cluster: Cluster;
  where: PostWhere;
  /** The coin, for a comment. */
  mint?: string;
  /** The coin's creator, read on-chain, for a comment. null when it couldn't be read. */
  creator?: string | null;
  text: string;
}

export type PostResult =
  | { status: "dry_run"; text: string; postsLeftToday: number }
  | { status: "posted"; post: Posted; postsLeftToday: number };

export interface ExecuteRequest {
  /** The tool that asked, for the audit log. */
  tool: string;
  intent: Intent;
  envelope: Envelope;
  /** The standing order this fills, for the audit log. */
  order?: string;
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
  /** How it went out: "jito" (a protected send, with its tip in SOL) or "rpc". */
  route?: "jito" | "rpc";
  tipSol?: number;
  /** false: a protected send that provably never landed, so it spent nothing. */
  landed?: false;
}

export interface ExecuteResult {
  /** not_landed: a protected send the block engine refused, or whose blockhash expired unseen. Nothing was spent. */
  status: "dry_run" | "sent" | "partly_sent" | "not_landed";
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

/** How an action's sends go out: Jito's route covers trades and claims (the sends worth front-running); launches and transfers go the ordinary way. */
export const routeOf = (policy: Policy, action: Action): "jito" | "rpc" => (policy.send?.route === "jito" && (action === "trade" || action === "claim") ? "jito" : "rpc");

const refused = (rule: string, reason: string) => new HigherError(`The policy refused this: ${reason}.`, { code: "policy_refused", body: { rule } });

export class LocalSigner {
  readonly audit: AuditLog;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly verifiedRpcs = new WeakSet<Connection>();
  private tipAccountsChecked = false;

  constructor(
    private readonly keypair: Keypair,
    readonly paths: AgentPaths,
    readonly keypairWarning?: string,
    now: () => Date = () => new Date(),
    private readonly jito: JitoClient = jitoClient(),
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

  /**
   * The tip a build should carry for a protected send, when the policy routes through Jito; undefined otherwise. 1.2
   * times Jito's recent median landed tip, within the policy's max_tip_sol; on a live policy, Jito's tip accounts are
   * checked against Highwire's list first, once per process.
   */
  async jitoTip(cluster: Cluster, action: Action): Promise<JitoTip | undefined> {
    const policy = loadPolicy(this.paths.policy);
    if (routeOf(policy, action) !== "jito") return undefined;
    if (cluster !== "mainnet") throw refused("send.route", "Jito's route is mainnet only");
    const cap = lamportsOf(policy.send!.max_tip_sol);
    if (!policy.live) return { tipLamports: tipFor(null, cap), tipAccount: JITO_TIP_ACCOUNTS[0] };
    if (!this.tipAccountsChecked) {
      const listed = await this.jito.tipAccounts();
      const ours = new Set<string>(JITO_TIP_ACCOUNTS);
      if (listed.length !== ours.size || !listed.every((a) => ours.has(a))) {
        throw new HigherError("Jito's block engine lists different tip accounts than Highwire knows, so nothing is sent through it. Update Highwire, or set send.route to rpc.", { code: "unavailable" });
      }
      this.tipAccountsChecked = true;
    }
    const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!;
    return { tipLamports: tipFor(await this.jito.tipFloorLamports(), cap), tipAccount };
  }

  /** Checks the built envelope against the policy, then signs and sends it, or dry-runs it. */
  execute(connection: Connection, req: ExecuteRequest): Promise<ExecuteResult> {
    // One at a time in this process, and across processes through the lock file.
    const run = this.queue.then(() => withFileLock(this.paths.lock, () => this.executeNow(connection, req)));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private log(
    req: Pick<ExecuteRequest, "tool" | "intent" | "order">,
    outcome: "refused" | "dry_run" | "sent" | "confirmed" | "failed" | "not_landed",
    extra: { lamports?: bigint; label?: string; signature?: string; reason?: string; route?: string; tip?: bigint; bundle?: string } = {},
  ) {
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
      ...(req.order ? { order: req.order } : {}),
      ...(extra.route ? { route: extra.route } : {}),
      ...(extra.tip !== undefined ? { tip: extra.tip.toString() } : {}),
      ...(extra.bundle ? { bundle: extra.bundle } : {}),
    });
  }

  /** Logs a standing order being placed, cancelled or closed. Fills are logged by execute(), like any trade. */
  logOrder(tool: string, order: { id: string; cluster: Cluster; mint?: string; kind?: string }, reason: string) {
    this.audit.append({ tool, action: order.kind === "fee_claim" ? "claim" : "trade", cluster: order.cluster, wallet: this.wallet, outcome: "order", sol: "0", lamports: "0", ...(order.mint ? { mint: order.mint } : {}), order: order.id, reason });
  }

  private async executeNow(connection: Connection, req: ExecuteRequest): Promise<ExecuteResult> {
    const { intent, envelope: env } = req;
    let policy: Policy;
    try {
      policy = this.checkStatic(intent.action, intent.cluster);
      if (env.wallet !== this.wallet || env.cluster !== intent.cluster) throw new UnsafeTransactionError("the transactions aren't for this signer's wallet and cluster");
      const failed = env.transactions.find((t) => !t.simulation.ok && !t.simulation.skipped);
      if (failed) throw new HigherError(`Transaction ${failed.index + 1} (${failed.label}) failed simulation: ${failed.simulation.error}`, { code: "simulation_failed" });
      if (intent.action === "wager" && (intent.wager?.kind === "open" || intent.wager?.kind === "accept") && stopped(this.paths.stopWagers)) {
        throw new HigherError(`No new wagers: ${this.paths.stopWagers} exists. Open series still play out.`, { code: "signer_stopped" });
      }
      const refusal = checkPolicy(policy, intent, this.audit.spentSince(intent.cluster));
      if (refusal) throw refused(refusal.rule, refusal.reason);
      const route = routeOf(policy, intent.action);
      const cap = lamportsOf(policy.send?.max_tip_sol ?? 0);
      for (const t of env.transactions) {
        const tips = jitoTipsOf(VersionedTransaction.deserialize(Buffer.from(t.base64, "base64")));
        if (route === "jito" && (tips.length !== 1 || tips[0]! > cap)) throw refused("send.route", `transaction ${t.index + 1} wasn't built with one tip of at most ${policy.send!.max_tip_sol} SOL for Jito's route; build it again`);
        if (route === "rpc" && tips.length > 0) throw refused("send.route", `transaction ${t.index + 1} tips Jito's block engine, and the policy sends the ordinary way`);
      }
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

    const route = routeOf(policy, intent.action);
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
        const tip = jitoTipsOf(tx)[0];
        let via: "jito" | "rpc" = route;
        // Logged, and counted, before it's sent: if the send's answer is lost, the spend still counts.
        this.log(req, "sent", { lamports: cost, label: t.label, signature, route, ...(tip !== undefined ? { tip } : {}) });
        charged += cost;
        const done: ExecutedTransaction = { index: t.index, label: t.label, signature, confirmed: false, route, ...(tip !== undefined ? { tipSol: lamportsNumber(tip) } : {}) };
        sent.push(done);
        // A protected send that provably never landed: give the spend back, and say so.
        const notLanded = (reason: string): ExecuteResult => {
          done.landed = false;
          done.error = reason;
          this.log(req, "not_landed", { lamports: cost, label: t.label, signature, reason });
          charged -= cost;
          return this.unlanded(intent, sent, summary, reason, dayLeft, charged);
        };
        let bundle: string | undefined;
        if (route === "jito") {
          try {
            bundle = (await this.jito.send(Buffer.from(tx.serialize()).toString("base64"))).bundleId;
          } catch (err) {
            if (err instanceof JitoRejected && policy.send?.fallback === "rpc") {
              via = "rpc";
              this.log(req, "failed", { label: t.label, signature, route: "jito", reason: `${err.message}; sending it the ordinary way, as the policy's fallback says` });
            } else if (err instanceof JitoRejected) {
              return notLanded(`${err.message}, so nothing was sent`);
            }
            // No answer at all: it may have been accepted. Watch for it until its blockhash expires.
          }
        }
        if (via === "rpc") {
          try {
            await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
            if (route === "jito") done.route = "rpc";
          } catch (err) {
            done.error = `the RPC didn't accept it (${err instanceof Error ? err.message : String(err)}); it may still land: check ${signature} before retrying`;
            this.log(req, "failed", { label: t.label, signature, reason: done.error });
            return this.partial(intent, sent, summary, done.error, dayLeft, charged);
          }
        }
        try {
          const res = await connection.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight }, "confirmed");
          if (res.value.err) throw new Error(JSON.stringify(res.value.err));
        } catch (err) {
          // A bundle-only send never enters the public queue, so once its blockhash has expired without it, it can't land.
          if (via === "jito" && (await this.neverLanded(connection, signature, lastValidBlockHeight))) {
            return notLanded("Jito's block engine didn't land it before its blockhash expired; nothing was spent");
          }
          done.error = err instanceof Error ? err.message : String(err);
          this.log(req, "failed", { label: t.label, signature, reason: done.error });
          return this.partial(intent, sent, summary, `transaction ${t.index + 1} didn't confirm: ${done.error}`, dayLeft, charged);
        }
        done.confirmed = true;
        this.log(req, "confirmed", { label: t.label, signature, route: via, ...(bundle ? { bundle } : {}) });
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

  /**
   * Signs higher.fun's sign-in message, and nothing else, so a launch can upload its image and metadata or look up an
   * X or GitHub account, or a post can go up. The message is checked to be exactly higher.fun's, for this wallet, from
   * just now; it moves no funds. The tool must have passed precheck("launch") first (post() checks its own policy).
   * Logged like everything else.
   */
  signInMessage(message: Uint8Array, tool: string, action: AuditAction = "launch"): Uint8Array {
    if (stopped(this.paths.stop)) throw new HigherError(`Stopped: ${this.paths.stop} exists, so nothing is signed.`, { code: "signer_stopped" });
    checkSignInMessage(new TextDecoder().decode(message), this.wallet);
    const signature = ed25519.sign(message, this.keypair.secretKey.subarray(0, 32));
    this.audit.append({ tool, action, cluster: "mainnet", wallet: this.wallet, outcome: "signed_in", sol: "0", lamports: "0", reason: "signed higher.fun's sign-in message" });
    return signature;
  }

  /**
   * Posts a comment or a chat message on higher.fun as this wallet, if the policy's `posts` section allows it: the
   * kill switch, mainnet, where it goes (a comment on one of the wallet's own coins unless `comments` is "any"; chat
   * only with `chat`), the text (no links, no addresses, higher.fun's length limits) and the daily cap. A dry run
   * unless the policy is live. `publish` signs in (through signInMessage) and posts; it's called only once all of that
   * passes, and the post is logged before it goes up, so it counts against the cap even if the answer is lost.
   */
  post(req: PostRequest, publish: (text: string, signIn: SignMessage) => Promise<Posted>): Promise<PostResult> {
    const run = this.queue.then(() => withFileLock(this.paths.lock, () => this.postNow(req, publish)));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async postNow(req: PostRequest, publish: (text: string, signIn: SignMessage) => Promise<Posted>): Promise<PostResult> {
    const entry = (outcome: "refused" | "dry_run" | "sent" | "posted" | "failed", extra: { text?: string; reason?: string; label?: string } = {}) =>
      this.audit.append({
        tool: req.tool,
        action: "post",
        cluster: req.cluster,
        wallet: this.wallet,
        outcome,
        sol: "0",
        lamports: "0",
        where: req.where,
        ...(req.mint ? { mint: req.mint } : {}),
        ...extra,
      });
    let text: string;
    let left: number;
    let policy: Policy;
    try {
      if (stopped(this.paths.stop)) throw new HigherError(`Stopped: ${this.paths.stop} exists, so nothing is posted until the user removes it.`, { code: "signer_stopped" });
      policy = loadPolicy(this.paths.policy);
      if (policy.cluster !== req.cluster) throw refused("cluster", `the policy is for ${policy.cluster}, and this server is on ${req.cluster}`);
      if (req.cluster !== "mainnet") throw refused("cluster", "higher.fun's comments and chat are on mainnet");
      const posts = policy.posts;
      if (!posts) throw refused("posts", "the policy has no posts section, so it doesn't allow posting");
      if (req.where === "chat" && !posts.chat) throw refused("posts.chat", "the policy doesn't allow posting to higher.fun's chat");
      if (req.where === "comment") {
        if (!req.mint) throw new HigherError("A comment needs the coin's mint.", { code: "bad_post" });
        if (posts.comments === "none") throw refused("posts.comments", "the policy doesn't allow comments");
        if (posts.comments === "own" && req.creator !== this.wallet) {
          throw refused("posts.comments", req.creator === null ? "the coin's creator can't be read on-chain, and the policy allows comments only on this wallet's own coins" : "the policy allows comments only on coins this wallet launched");
        }
      }
      text = checkPostText(req.text, req.where);
      const used = this.audit.postsSince();
      if (used >= posts.max_per_day) throw refused("posts.max_per_day", `${used} posts in the last 24 hours already, the policy's most`);
      left = posts.max_per_day - used;
    } catch (err) {
      entry("refused", { text: req.text.slice(0, 500), reason: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    if (!policy.live) {
      entry("dry_run", { text });
      return { status: "dry_run", text, postsLeftToday: left };
    }
    entry("sent", { text });
    try {
      const post = await publish(text, (m) => this.signInMessage(m, req.tool, "post"));
      entry("posted", { label: post.id });
      return { status: "posted", post, postsLeftToday: left - 1 };
    } catch (err) {
      entry("failed", { reason: err instanceof Error ? err.message : String(err) });
      throw err;
    }
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

  /** After its blockhash expired: true when the network has no record of the transaction at all. */
  private async neverLanded(connection: Connection, signature: string, lastValidBlockHeight: number): Promise<boolean> {
    try {
      if ((await connection.getBlockHeight("confirmed")) <= lastValidBlockHeight) return false;
      const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      return value[0] === null;
    } catch {
      return false;
    }
  }

  /** The first transaction never landed (nothing sent before it: not_landed), or a later one didn't (partly sent). */
  private unlanded(intent: Intent, sent: ExecutedTransaction[], summary: string[][], reason: string, dayLeft: (spent: bigint) => number, charged: bigint): ExecuteResult {
    if (sent.length > 1) return this.partial(intent, sent, summary, reason, dayLeft, charged);
    return { status: "not_landed", wallet: this.wallet, cluster: intent.cluster, transactions: sent, summary, spentSol: 0, dayLeftSol: dayLeft(this.audit.spentSince(intent.cluster)) };
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
