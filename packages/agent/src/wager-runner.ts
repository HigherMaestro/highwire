import { commitDeadline, revealDeadline, sideIndexOf, type SeriesAccountData } from "highwire-core";
import type { WagerFallback, WagerSecrets } from "./wager-secrets.ts";

// The reveal daemon (docs/wager-mode.md 7.3): `highwire line run` watches the wallet's wager series and, through the
// local signer and inside the policy, does what the series needs from this side and no more: reveals every committed
// move and every owed fallback from the secrets file, applies deadlines that have passed, settles a finished series,
// cancels an opened series nobody accepted, and refunds one idle for a day. It takes no instruction from the agent and
// never opens, accepts, commits or retires. Only the kill switch (STOP) halts it; STOP-WAGERS doesn't, since it means
// "finish what's open".

export type WagerAction =
  | { kind: "reveal"; pull: number; nonce: string }
  | { kind: "revealFallback"; fallback: WagerFallback; salt: string }
  | { kind: "timeout" }
  | { kind: "settle" }
  | { kind: "cancel" }
  | { kind: "emergencyRefund" };

/** Seconds past a deadline before acting on it, for the gap between this machine's clock and the chain's. */
export const DEADLINE_MARGIN_SECONDS = 3;
/**
 * Cancelling is different: the program lets A cancel at any time, so an early cancel would succeed and lose a series B
 * could still accept. The daemon waits this long past the accept deadline, for a chain clock that lags (7.2.3).
 */
export const CANCEL_MARGIN_SECONDS = 90;
const EMERGENCY_AFTER_SECONDS = 24 * 60 * 60;

export interface Decision {
  action: WagerAction | null;
  /** Something the owner should know: a secret that's missing, so a match will be forfeited. */
  warning?: string;
}

/** What this wallet should do now in one series. Pure: the chain's state, the time, and the secrets file. */
export function nextWagerAction(s: SeriesAccountData, wallet: string, now: number, secrets: Pick<WagerSecrets, "move" | "fallback">): Decision {
  const h = s.header;
  const me = h.playerA === wallet ? "A" : h.playerB === wallet ? "B" : null;
  if (!me) return { action: null };
  const past = (deadline: number) => now >= deadline + DEADLINE_MARGIN_SECONDS;
  if (h.status === "open") {
    // B can accept up to the deadline; after it, A gets its stake back. Either side's daemon sends the cancel (the
    // program lets anyone, after the deadline), so an opener who walks away can't keep the other waiting.
    return { action: now > h.acceptDeadline + CANCEL_MARGIN_SECONDS ? { kind: "cancel" } : null };
  }
  const x = s.series;
  if (!x) return { action: null };
  if (x.ending) return { action: { kind: "settle" } };
  const mine = sideIndexOf(me, x.match);
  const round = x.round[mine];
  if (x.phase === "reveal") {
    let warning: string | undefined;
    // Reveal while the window is open (a reveal may land at its end); after it, a reveal can only fail, so fall through
    // to the timeout that voids or awards the match, and the refund.
    if (round.pull === null && !past(revealDeadline(x) + 1)) {
      if (round.owesFallback) {
        const fb = secrets.fallback(h.seriesId, me, x.fallbackHash[me]);
        if (fb) return { action: { kind: "revealFallback", fallback: fb.fallback, salt: fb.salt } };
        warning = `series ${h.seriesId.slice(0, 8)}: no saved salt for this wallet's fallback, so it can't be revealed and this match will be forfeited`;
      } else if (round.hash) {
        const m = secrets.move(h.seriesId, round.hash);
        if (m) return { action: { kind: "reveal", pull: m.pull, nonce: m.nonce } };
        warning = `series ${h.seriesId.slice(0, 8)}: no saved nonce for this wallet's commitment, so it can't be revealed and this match will be forfeited`;
      }
    }
    if (past(revealDeadline(x) + 1)) return { action: { kind: "timeout" }, warning };
    if (warning) return { action: null, warning };
  } else {
    // A commit phase times out once every side still to commit is past its own deadline.
    const late = ([0, 1] as const).filter((side) => x.round[side].hash === null && !x.round[side].owesFallback);
    if (late.length > 0 && late.every((side) => past(commitDeadline(x, side)))) return { action: { kind: "timeout" } };
  }
  if (past(h.lastChange + EMERGENCY_AFTER_SECONDS)) return { action: { kind: "emergencyRefund" } };
  return { action: null };
}

export interface WagerRunnerOptions {
  wallet: string;
  /** The wallet's series on-chain. */
  list: () => Promise<SeriesAccountData[]>;
  /** Builds and executes one action through the local signer; resolves to a line for the log. */
  act: (seriesId: string, action: WagerAction) => Promise<string>;
  secrets: Pick<WagerSecrets, "move" | "fallback">;
  /** Whether the kill switch is on. */
  stopped: () => boolean;
  /** Why nothing should be sent now (a dry-run policy, or one without wagers), or null. Checked every pass. */
  idle?: () => string | null;
  log: (line: string) => void;
  now?: () => number;
  intervalMs?: number;
}

/** How long before trying the same action on the same series again after a failure: doubling from 5 s to 5 minutes. */
const RETRY_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

export class WagerRunner {
  /** Per series and state: when an action was last tried, and how many times it has failed. */
  private readonly tried = new Map<string, { at: number; failures: number }>();
  private readonly warned = new Set<string>();
  private idleSaid: string | null = null;

  constructor(private readonly o: WagerRunnerOptions) {}

  private now() {
    return this.o.now ? this.o.now() : Math.floor(Date.now() / 1000);
  }

  /** One pass over the wallet's series. Returns the actions taken. Never throws. */
  async tick(): Promise<{ seriesId: string; action: WagerAction; result: string }[]> {
    if (this.o.stopped()) return [];
    const idle = this.o.idle?.() ?? null;
    if (idle !== this.idleSaid) {
      if (idle) this.o.log(`not acting: ${idle}`);
      this.idleSaid = idle;
    }
    if (idle) return [];
    let series: SeriesAccountData[];
    try {
      series = await this.o.list();
    } catch (err) {
      this.o.log(`couldn't read the wallet's series: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    const now = this.now();
    const live = new Set(series.map((s) => s.header.seriesId));
    for (const k of this.tried.keys()) if (!live.has(k.slice(0, 64))) this.tried.delete(k);
    // Series run side by side: one slow confirmation mustn't hold up another series' reveal.
    const results = await Promise.all(series.map((s) => this.one(s, now)));
    return results.filter((r): r is { seriesId: string; action: WagerAction; result: string } => r !== null);
  }

  private async one(s: SeriesAccountData, now: number): Promise<{ seriesId: string; action: WagerAction; result: string } | null> {
    const id = s.header.seriesId;
    let kind = "deciding";
    try {
      const { action, warning } = nextWagerAction(s, this.o.wallet, now, this.o.secrets);
      if (warning && !this.warned.has(warning)) {
        this.warned.add(warning);
        this.o.log(`WARNING ${warning}`);
      }
      if (!action) return null;
      const key = `${id}:${action.kind}:${s.series?.match ?? "-"}:${s.series?.game.rounds ?? "-"}:${s.series?.phase ?? "-"}`;
      const last = this.tried.get(key);
      if (last && Date.now() - last.at < Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** last.failures)) return null;
      this.tried.set(key, { at: Date.now(), failures: last ? last.failures + 1 : 0 });
      kind = action.kind;
      const result = await this.o.act(id, action);
      this.o.log(`series ${id.slice(0, 8)}: ${action.kind}: ${result}`);
      return { seriesId: id, action, result };
    } catch (err) {
      this.o.log(`series ${id.slice(0, 8)}: ${kind} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (err) {
        this.o.log(`pass failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.o.intervalMs ?? 3_000);
        signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
    }
  }
}
