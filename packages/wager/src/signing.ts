import { Buffer } from "node:buffer";
import { PublicKey, type Connection, type Keypair } from "@solana/web3.js";
import { solToLamports, UnsafeTransactionError, type Cluster, type Envelope } from "highwire-core";
import { LocalSigner, policyRefused as refused, stopped, type ActionExtension, type AgentPaths, type AuditLog, type Intent, type Policy, type Refusal } from "highwire-agent";
import { decodeSeriesAccount, wagerProgram } from "./codec.ts";
import { wagerFacts } from "./guard.ts";
import { decodeLinkBattle, linkWagerProgram } from "./link-codec.ts";
import { linkWagerFacts } from "./link-guard.ts";

// What the local signer needs to know about a wager, as its extension for the "wager" action (highwire-agent's
// extension.ts, docs/boundaries.md 5.2): what the transaction stakes, read from its bytes and the chain rather than
// from the caller; how many series the wallet already has open; which of the policy's `wagers` rules apply; and the
// STOP-WAGERS switch. The signer has none of this itself, and refuses a wager without it. Everything else stays the
// signer's and applies as to any transaction: the policy's cluster and actions, the per-transaction and daily limits,
// the simulation, the audit log, and the cap on what a move may spend.

/**
 * A link battle's stake instructions are logged and checked under their own names ("link_open", "link_settle"...), so
 * the audit log says which game a stake was on and nothing that lists The Line's series picks up a battle.
 */
export const LINK_KIND = "link_";

/** Opening and accepting stake; every other wager instruction is a move that spends only its network fee. */
export const STAKE_KINDS: readonly string[] = ["open", "accept", `${LINK_KIND}open`, `${LINK_KIND}accept`];

/** How long a stake that was sent counts as an open series, whether or not the chain shows it yet. */
const RECENT_STAKE_MS = 10 * 60 * 1000;
/** A recent stake confirmed this long ago whose series account is gone has closed (the account is visible by then). */
const CLOSED_AFTER_MS = 30_000;

/**
 * Series this wallet staked in (open or accept sent) in the last `ms`: on-chain counts can lag a send that hasn't
 * confirmed yet, so the open-series count adds these.
 */
export function stakedSeriesSince(audit: AuditLog, cluster: Cluster, ms: number): string[] {
  const since = audit.nowMs() - ms;
  return audit
    .entries()
    .filter((e) => e.action === "wager" && e.outcome === "sent" && e.cluster === cluster && !!e.wager && STAKE_KINDS.includes(e.wager) && e.series && Date.parse(e.time) >= since)
    .map((e) => e.series!);
}

/**
 * For each series staked in (open or accept) in the last `ms`: when its latest stake was sent, and its latest confirmed
 * stake (time and signature), if any. A send after the last confirmation is a stake still in flight.
 */
export function recentStakes(audit: AuditLog, cluster: Cluster, ms: number): Map<string, { sent: number; confirmed?: { at: number; signature: string } }> {
  const since = audit.nowMs() - ms;
  const out = new Map<string, { sent: number; confirmed?: { at: number; signature: string } }>();
  for (const e of audit.entries()) {
    if (e.action !== "wager" || e.cluster !== cluster || !e.wager || !STAKE_KINDS.includes(e.wager) || !e.series) continue;
    const at = Date.parse(e.time);
    if (at < since) continue;
    const cur = out.get(e.series) ?? { sent: 0 };
    if (e.outcome === "sent") cur.sent = Math.max(cur.sent, at);
    if (e.outcome === "confirmed" && e.signature && at >= (cur.confirmed?.at ?? 0)) cur.confirmed = { at, signature: e.signature };
    out.set(e.series, cur);
  }
  return out;
}

/** Whether a series account is gone as of a slot no earlier than the stake that created or filled it: closed. */
async function closedSince(connection: Connection, programs: readonly PublicKey[], series: string, stakeSignature: string): Promise<boolean> {
  try {
    const slot = (await connection.getSignatureStatuses([stakeSignature], { searchTransactionHistory: true })).value[0]?.slot;
    if (!slot) return false;
    const info = await connection.getAccountInfo(new PublicKey(series), { commitment: "confirmed", minContextSlot: slot });
    return !info || !programs.some((p) => info.owner.equals(p));
  } catch {
    return false;
  }
}

/** The staking programs on a cluster: The Line's, and link battles' (the codec's, unless one is handed in, in code). */
function stakingPrograms(cluster: Cluster, linkProgram?: PublicKey): PublicKey[] {
  return [wagerProgram(cluster), linkProgram ?? linkWagerProgram(cluster)].filter((p): p is PublicKey => !!p);
}

/**
 * The series this wallet has money in, staked link battles among them (the policy's `max_open` is across both games):
 * every stake its audit log shows it sent in the last 30 days whose account is still on-chain (one
 * getMultipleAccounts, never getProgramAccounts, which public RPCs throttle), plus any sent in the last ten minutes,
 * which the chain may not show yet.
 */
export async function openSeries(connection: Connection, audit: AuditLog, cluster: Cluster, linkProgram?: PublicKey): Promise<number> {
  const programs = stakingPrograms(cluster, linkProgram);
  if (programs.length === 0) throw refused("wagers", `wagering isn't deployed on ${cluster}`);
  // Open: a series staked in whose account is still the program's, and any recent stake unless it has provably closed:
  // its latest send confirmed a while ago, and its account gone at a slot no earlier than that confirmation's (an RPC
  // that lags, or a load balancer's other node, can't make an open series look closed).
  const recent = recentStakes(audit, cluster, RECENT_STAKE_MS);
  const staked = [...new Set(stakedSeriesSince(audit, cluster, 30 * 86_400_000))];
  const open = new Set<string>();
  const now = Date.now();
  for (let i = 0; i < staked.length; i += 100) {
    const chunk = staked.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk.map((a) => new PublicKey(a)), "confirmed");
    chunk.forEach((a, j) => {
      if (programs.some((p) => infos[j]?.owner.equals(p)) || recent.has(a)) open.add(a);
    });
  }
  for (const [a, r] of recent) {
    if (!open.has(a)) continue;
    const c = r.confirmed;
    if (!c || c.at < r.sent || now - c.at <= CLOSED_AFTER_MS) continue;
    if (await closedSince(connection, programs, a, c.signature)) open.delete(a);
  }
  return open.size;
}

/** The policy's `wagers` rules: the tier, the most a side, how many series at once, and whether retiring is allowed. */
export function checkWagerPolicy(policy: Policy, intent: Intent): Refusal | null {
  const no = (rule: string, reason: string): Refusal => ({ rule, reason });
  const w = policy.wagers;
  if (!w) return no("wagers", "the policy has no wagers section, so it doesn't allow wagering");
  const kind = intent.wager?.kind;
  if (!kind) return no("wagers", "the wager's instruction isn't known");
  if (STAKE_KINDS.includes(kind)) {
    const stake = intent.wager?.stake;
    if (stake === undefined || !w.tiers.some((t) => solToLamports(t) === stake)) return no("wagers.tiers", `the stake isn't one of the policy's tiers (${w.tiers.join(", ")} SOL)`);
    if (stake > solToLamports(w.max_stake_sol)) return no("wagers.max_stake_sol", `the stake is over the policy's ${w.max_stake_sol} SOL`);
    const open = intent.wager?.openSeries;
    if (open === undefined) return no("wagers.max_open", "the wallet's open series couldn't be counted on-chain");
    if (open >= w.max_open) return no("wagers.max_open", `${open} series already open, the policy's most`);
  }
  if (kind === "retire" && !w.allow_retire) return no("wagers.allow_retire", "the policy doesn't allow retiring from a staked series");
  return null;
}

/** What a wager envelope is: one of The Line's instructions, or one of link battles' (never both, never two). */
function eitherFacts(env: Envelope, cluster: Cluster, linkProgram?: PublicKey): { link: boolean; kind: string; subject: string; stake?: bigint } {
  const lp = linkProgram ?? linkWagerProgram(cluster);
  const lf = lp ? linkWagerFacts(env, lp) : null;
  if (!lf) {
    const f = wagerFacts(env, cluster);
    return { link: false, kind: f.kind, subject: f.series, stake: f.stake };
  }
  let line = true;
  try {
    wagerFacts(env, cluster);
  } catch {
    line = false;
  }
  if (line) throw new UnsafeTransactionError("the transaction stakes on a link battle and plays The Line at once");
  return { link: true, kind: `${LINK_KIND}${lf.kind}`, subject: lf.battle, stake: lf.stake };
}

export interface WagerSigningOptions {
  /**
   * Link battles' practice-stake program, for a signer that isn't on a cluster the codec lists one for: the tests and
   * the local rehearsal. Passed in code only; nothing reads it from the environment or a tool argument.
   */
  linkProgram?: PublicKey;
}

/**
 * The local signer's extension for wagers: The Line's series and link battles' practice stakes, under the one "wager"
 * action and the policy's one `wagers` section. highwire-wager's server and daemon pass it; nothing else has it.
 */
export function wagerSigningFor(opts: WagerSigningOptions = {}): ActionExtension {
  return {
    action: "wager",
    facts(env, cluster) {
      const f = eitherFacts(env, cluster, opts.linkProgram);
      return { kind: f.kind, subject: f.subject };
    },
    stakes: (kind) => STAKE_KINDS.includes(kind),
    /**
     * A wager's intent, from the transaction's bytes and the chain rather than the caller: its instruction, the stake
     * (an open's from its data, an accept's from the series or battle account), and for a stake, the wallet's open
     * series counted now, under the lock.
     */
    async intent({ connection, req, audit }) {
      const { intent } = req;
      const f = eitherFacts(req.envelope, intent.cluster, opts.linkProgram);
      if (intent.wager?.kind && intent.wager.kind !== f.kind) throw new UnsafeTransactionError(`the transaction is a wager ${f.kind}, not the ${intent.wager.kind} it says`);
      if (!STAKE_KINDS.includes(f.kind)) {
        if (intent.solOut !== 0n) throw new UnsafeTransactionError("a wager move stakes nothing");
        return { ...intent, wager: { kind: f.kind } };
      }
      let stake = f.stake;
      if (stake === undefined) {
        // An accept: the stake is whatever the account it accepts holds, and that account must be the program's own.
        const acc = await connection.getAccountInfo(new PublicKey(f.subject), "confirmed");
        if (!acc) throw refused("wagers", `the ${f.link ? "battle" : "series"} to accept isn't on-chain`);
        if (f.link) {
          const lp = opts.linkProgram ?? linkWagerProgram(intent.cluster);
          if (!lp || !acc.owner.equals(lp)) throw refused("wagers", "the battle to accept isn't the staking program's account");
          stake = decodeLinkBattle(Buffer.from(acc.data)).stake;
        } else stake = decodeSeriesAccount(Buffer.from(acc.data)).header.stake;
      }
      const solOut = stake > intent.solOut ? stake : intent.solOut;
      return { ...intent, solOut, wager: { kind: f.kind, stake, openSeries: await openSeries(connection, audit, intent.cluster, opts.linkProgram) } };
    },
    check: checkWagerPolicy,
    stopped: (paths) => (stopped(paths.stopWagers) ? `No new wagers: ${paths.stopWagers} exists. Open series and battles still play out.` : null),
  };
}

/** The extension for the clusters the codec lists: what highwire-wager's bin passes. */
export const wagerSigning: ActionExtension = wagerSigningFor();

/** A local signer that can check wagers: highwire-agent's, with the wager extension. */
export const wagerSigner = (keypair: Keypair, paths: AgentPaths, keypairWarning?: string, now?: () => Date, opts?: WagerSigningOptions): LocalSigner =>
  new LocalSigner(keypair, paths, keypairWarning, now, undefined, [wagerSigningFor(opts)]);
