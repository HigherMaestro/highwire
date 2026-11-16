import { PublicKey } from "@solana/web3.js";
import type { AuditLog, ExecuteResult, LocalSigner } from "highwire-agent";
import { type Cluster } from "highwire-core";
import type { LinkBattleAccount, LinkResult } from "./link-codec.ts";
import type { LinkWagerConfig } from "./link-codec.ts";
import { buildLinkExit, buildLinkSettle, isLinkResultFor, linkStakesProgram, readLinkBattlesAt, type LinkStakes, type SignedLinkResult } from "./link-tx.ts";
import { LINK_KIND } from "./signing.ts";

// What a wallet owes its staked link battles once they're on-chain (docs/link-wager.md 3.5, 3.6), for the tools and
// for the daemon (`highwire-wager run`): settle a battle the referee has signed a result for, cancel an opening
// nobody accepted, refund a battle that never got a result. Nothing here stakes: it only brings stakes home.

export type LinkStakeAction = { kind: "settle"; signed: SignedLinkResult } | { kind: "cancel" } | { kind: "refund" };

/**
 * Seconds past a deadline before acting on it, for the gap between this machine's clock and the chain's. The program
 * refuses anything early (a battle closes only after its ticket has expired, a refund only from its `refund_at`), and
 * an early try fails in simulation and is never sent, so the margin only saves a wasted try.
 */
export const LINK_CLOCK_MARGIN_SECONDS = 10;
/**
 * Both sides' daemons see the result, and only one settle can land. The winner's (A's, for a draw or a void) sends at
 * once; the other waits this long after it first saw the result, in case the first is down.
 */
export const LINK_SETTLE_GRACE_SECONDS = 30;

/**
 * What this wallet should do now for one staked battle. Pure: the chain's account, the time, and the referee's result.
 * `result` must already be one the program would take (`isLinkResultFor`): anything else is dropped before this, so a
 * result that can't settle never stands in the way of the refund.
 */
export function nextLinkStakeAction(
  b: LinkBattleAccount,
  wallet: string,
  now: number,
  o: { result?: SignedLinkResult; /** When the result was first seen (seconds); omit to settle at once. */ resultSeenAt?: number } = {},
): LinkStakeAction | null {
  const me = b.playerA === wallet ? "A" : b.playerB === wallet ? "B" : null;
  if (!me) return null;
  // Nothing closes a battle while its ticket still runs.
  if (now <= b.ticketExpiry + LINK_CLOCK_MARGIN_SECONDS) return null;
  if (b.status === "open") return { kind: "cancel" };
  const r = o.result;
  if (r && r.result.battleId === b.battleId && r.result.playerA === b.playerA && r.result.playerB === b.playerB) {
    const first = r.result.outcome === "a" ? me === "A" : r.result.outcome === "b" ? me === "B" : me === "A";
    if (first || o.resultSeenAt === undefined || now >= o.resultSeenAt + LINK_SETTLE_GRACE_SECONDS) return { kind: "settle", signed: r };
    return null;
  }
  if (now >= b.refundAt + LINK_CLOCK_MARGIN_SECONDS) return { kind: "refund" };
  return null;
}

/**
 * The battles this wallet has a stake in: every link stake its audit log shows it sent in the last 30 days whose
 * account is still on-chain. Read by address, never by scanning the program (public RPCs throttle that).
 */
export async function walletLinkBattles(s: LinkStakes, audit: AuditLog, wallet: string, cluster: Cluster): Promise<LinkBattleAccount[]> {
  const since = audit.nowMs() - 30 * 86_400_000;
  const stakes = [`${LINK_KIND}open`, `${LINK_KIND}accept`];
  const addresses = [
    ...new Set(
      audit
        .entries()
        .filter((e) => e.action === "wager" && e.cluster === cluster && e.wallet === wallet && !!e.wager && stakes.includes(e.wager) && (e.outcome === "sent" || e.outcome === "confirmed") && e.series && Date.parse(e.time) >= since)
        .map((e) => e.series!),
    ),
  ];
  if (addresses.length === 0) return [];
  return (await readLinkBattlesAt(s, addresses)).filter((b) => b.playerA === wallet || b.playerB === wallet);
}

/** A signed result as the referee serves it (`/api/link/stake/results`), checked for shape; null for anything else. */
export function signedResultOf(x: unknown): SignedLinkResult | null {
  const o = (x ?? {}) as { result?: Record<string, unknown>; signature?: unknown };
  const r = o.result ?? {};
  const outcome = r.outcome;
  if (typeof r.battleId !== "string" || !/^[0-9a-f]{64}$/.test(r.battleId)) return null;
  if (typeof r.playerA !== "string" || typeof r.playerB !== "string" || typeof o.signature !== "string" || !/^[0-9a-f]{128}$/.test(o.signature)) return null;
  if (outcome !== "a" && outcome !== "b" && outcome !== "draw" && outcome !== "void") return null;
  if (typeof r.keyId !== "number" || !Number.isInteger(r.keyId)) return null;
  try {
    new PublicKey(r.playerA);
    new PublicKey(r.playerB);
  } catch {
    return null;
  }
  const result: LinkResult = { battleId: r.battleId, playerA: r.playerA, playerB: r.playerB, outcome, keyId: r.keyId };
  return { result, signature: o.signature };
}

/** The referee's results the program would take now, by battle: each checked against the config's key and its own battle. */
export function usableResults(s: LinkStakes, config: Pick<LinkWagerConfig, "resultKey" | "resultKeyId">, battles: readonly LinkBattleAccount[], served: ReadonlyMap<string, SignedLinkResult>): Map<string, SignedLinkResult> {
  const program = linkStakesProgram(s);
  const out = new Map<string, SignedLinkResult>();
  for (const b of battles) {
    const r = served.get(b.battleId);
    if (r && isLinkResultFor(program, config, b, r)) out.set(b.battleId, r);
  }
  return out;
}

type Signer = Pick<LocalSigner, "wallet" | "publicKey" | "execute">;

/** Builds and executes one action for a staked battle through the local signer: a move that stakes nothing. */
export async function actOnLinkBattle(s: LinkStakes, signer: Signer, tool: string, battleId: string, action: LinkStakeAction): Promise<ExecuteResult> {
  const built =
    action.kind === "settle"
      ? await buildLinkSettle(s, { wallet: signer.publicKey, ...action.signed })
      : await buildLinkExit(s, { wallet: signer.publicKey, battleId, kind: action.kind });
  return signer.execute(s.chain.connection, { tool, intent: { action: "wager", cluster: s.chain.cluster, solOut: 0n, wager: { kind: `${LINK_KIND}${action.kind}` } }, envelope: built.envelope });
}

export interface LinkStakeRunnerOptions {
  wallet: string;
  /** The wallet's staked battles on-chain. */
  battles: () => Promise<LinkBattleAccount[]>;
  /**
   * The referee's signed results the program would take, for these battles, by battle id (`usableResults`: checked
   * against the config's result key). Asked only when a battle is live.
   */
  results: (battles: LinkBattleAccount[]) => Promise<Map<string, SignedLinkResult>>;
  act: (battleId: string, action: LinkStakeAction) => Promise<string>;
  stopped: () => boolean;
  /** Why nothing should be sent now (a dry-run policy, or one without wagers), or null. */
  idle?: () => string | null;
  log: (line: string) => void;
  /** Seconds. */
  now?: () => number;
  intervalMs?: number;
}

const RETRY_MS = 15_000;
const RETRY_MAX_MS = 5 * 60_000;

/**
 * The daemon's pass over the wallet's staked link battles: it settles, cancels and refunds, and never stakes. Only the
 * kill switch (STOP) halts it; STOP-WAGERS doesn't, since it means "finish what's open".
 */
export class LinkStakeRunner {
  private readonly tried = new Map<string, { at: number; failures: number }>();
  private readonly seen = new Map<string, number>();

  constructor(private readonly o: LinkStakeRunnerOptions) {}

  private now() {
    return this.o.now ? this.o.now() : Math.floor(Date.now() / 1000);
  }

  /** One pass. Returns the actions taken. Never throws. */
  async tick(): Promise<{ battleId: string; action: LinkStakeAction["kind"]; result: string }[]> {
    if (this.o.stopped() || this.o.idle?.()) return [];
    let battles: LinkBattleAccount[];
    try {
      battles = await this.o.battles();
    } catch (err) {
      this.o.log(`couldn't read the wallet's staked battles: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    const open = new Set(battles.map((b) => b.battleId));
    for (const k of this.tried.keys()) if (!open.has(k.slice(0, 64))) this.tried.delete(k);
    for (const k of this.seen.keys()) if (!open.has(k)) this.seen.delete(k);
    if (battles.length === 0) return [];
    let results = new Map<string, SignedLinkResult>();
    if (battles.some((b) => b.status === "live")) {
      // Without the referee's answer nothing is settled this pass; a refund past its time still goes.
      results = await this.o.results(battles.filter((b) => b.status === "live")).catch(() => new Map());
    }
    const now = this.now();
    const out: { battleId: string; action: LinkStakeAction["kind"]; result: string }[] = [];
    for (const b of battles) {
      const result = results.get(b.battleId);
      if (result && !this.seen.has(b.battleId)) this.seen.set(b.battleId, now);
      const action = nextLinkStakeAction(b, this.o.wallet, now, { result, resultSeenAt: this.seen.get(b.battleId) });
      if (!action) continue;
      const key = `${b.battleId}:${action.kind}`;
      const last = this.tried.get(key);
      if (last && Date.now() - last.at < Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** last.failures)) continue;
      this.tried.set(key, { at: Date.now(), failures: last ? last.failures + 1 : 0 });
      try {
        const said = await this.o.act(b.battleId, action);
        this.o.log(`link battle ${b.battleId.slice(0, 8)}: ${action.kind}: ${said}`);
        out.push({ battleId: b.battleId, action: action.kind, result: said });
      } catch (err) {
        this.o.log(`link battle ${b.battleId.slice(0, 8)}: ${action.kind} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick().catch((err) => this.o.log(`link pass failed: ${err instanceof Error ? err.message : String(err)}`));
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.o.intervalMs ?? 15_000);
        signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
    }
  }
}
