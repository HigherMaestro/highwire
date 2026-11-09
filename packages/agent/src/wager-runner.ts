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
    // B can accept up to the deadline; after it, A gets its stake back.
    return { action: me === "A" && now > h.acceptDeadline + DEADLINE_MARGIN_SECONDS ? { kind: "cancel" } : null };
  }
  const x = s.series;
  if (!x) return { action: null };
  if (x.ending) return { action: { kind: "settle" } };
  const mine = sideIndexOf(me, x.match);
  const round = x.round[mine];
  if (x.phase === "reveal") {
    if (round.pull === null) {
      if (round.owesFallback) {
        const fb = secrets.fallback(h.seriesId, me, x.fallbackHash[me]);
        if (fb) return { action: { kind: "revealFallback", fallback: fb.fallback, salt: fb.salt } };
        return { action: null, warning: `series ${h.seriesId.slice(0, 8)}: no saved salt for this wallet's fallback, so it can't be revealed and this match will be forfeited` };
      }
      if (round.hash) {
        const m = secrets.move(h.seriesId, round.hash);
        if (m) return { action: { kind: "reveal", pull: m.pull, nonce: m.nonce } };
        return { action: null, warning: `series ${h.seriesId.slice(0, 8)}: no saved nonce for this wallet's commitment, so it can't be revealed and this match will be forfeited` };
      }
    }
    if (past(revealDeadline(x) + 1)) return { action: { kind: "timeout" } };
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
  log: (line: string) => void;
  now?: () => number;
  intervalMs?: number;
}

/** How long before trying the same action on the same series again after a failure. */
const RETRY_MS = 10_000;

export class WagerRunner {
  private readonly tried = new Map<string, number>();
  private readonly warned = new Set<string>();

  constructor(private readonly o: WagerRunnerOptions) {}

  private now() {
    return this.o.now ? this.o.now() : Math.floor(Date.now() / 1000);
  }

  /** One pass over the wallet's series. Returns the actions taken. */
  async tick(): Promise<{ seriesId: string; action: WagerAction; result: string }[]> {
    if (this.o.stopped()) return [];
    const done: { seriesId: string; action: WagerAction; result: string }[] = [];
    let series: SeriesAccountData[];
    try {
      series = await this.o.list();
    } catch (err) {
      this.o.log(`couldn't read the wallet's series: ${err instanceof Error ? err.message : String(err)}`);
      return done;
    }
    const now = this.now();
    for (const s of series) {
      const id = s.header.seriesId;
      const { action, warning } = nextWagerAction(s, this.o.wallet, now, this.o.secrets);
      if (warning && !this.warned.has(warning)) {
        this.warned.add(warning);
        this.o.log(`WARNING ${warning}`);
      }
      if (!action) continue;
      const key = `${id}:${action.kind}:${s.series?.match ?? "-"}:${s.series?.game.rounds ?? "-"}:${s.series?.phase ?? "-"}`;
      const last = this.tried.get(key);
      if (last !== undefined && Date.now() - last < RETRY_MS) continue;
      this.tried.set(key, Date.now());
      try {
        const result = await this.o.act(id, action);
        done.push({ seriesId: id, action, result });
        this.o.log(`series ${id.slice(0, 8)}: ${action.kind}: ${result}`);
      } catch (err) {
        this.o.log(`series ${id.slice(0, 8)}: ${action.kind} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return done;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick();
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.o.intervalMs ?? 3_000);
        signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
    }
  }
}
