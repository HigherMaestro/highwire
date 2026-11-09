import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { rate, START, type Rating } from "highwire-core/arena";
import type { Clock } from "../clock.ts";
import { fail } from "../errors.ts";
import { randomHex } from "../registration.ts";
import { update, type Store } from "../store.ts";
import type { Fighter, Tally } from "./types.ts";

// The wager desk (docs/wager-mode.md 7.4): pairs two fighters at the same stake tier and signs the matchmaker's ticket
// that the wager program requires to open and accept their series. It never holds or sees money, and can't affect a
// series once both have staked: the series is played and paid on-chain. It keeps a wager rating apart from the free
// one, read from the chain's outcome of each series it ticketed.
//
// - One queue for every tier, in one document, so pairing and the per-pair weekly count change together.
// - A tier pairs only when at least `minQueue` different owners are waiting at it, and each entry waits a random few
//   seconds first: two colluders who join together aren't simply paired with each other.
// - Never two fighters of one owner; at most `perPairPerWeek` series a week between two owners; the closest wager
//   ratings, the allowed gap widening with the wait. The house never plays for stakes; operator fighters never wager.

/** What the deployment tells the desk about the chain: where each series it ticketed stands. */
export interface WagerChain {
  /**
   * none: never opened. open: A staked, waiting for B. live: both staked. closed: the account is gone, and how; unknown:
   * it closed but its last transaction couldn't be read (asked again later).
   */
  status(seriesId: string, ticket: WagerTicketRecord): Promise<
    | { state: "none" | "open" | "live" | "unknown" }
    | { state: "closed"; how: "settled"; winner: "A" | "B" | null }
    | { state: "closed"; how: "cancelled" | "refunded" }
  >;
}

export interface WagerConfig {
  /** The wager program's id (base58) and the cluster it's on. */
  programId: string;
  cluster: "devnet" | "mainnet";
  /** The matchmaker's Ed25519 secret (32 bytes) and the key id the program's config holds for it. */
  ticketSecret: Uint8Array;
  keyId: number;
  /** Stake tiers, lamports a side; the program's config must hold each. */
  tiers: bigint[];
  chain: WagerChain;
  /** Different owners waiting at a tier before it pairs. Default 4 (the spec's); a quiet devnet can set 2. */
  minQueue?: number;
  /** B's time to accept, and A's to open, from the pairing. Default 5 minutes and 2 minutes. */
  acceptSeconds?: number;
  openSeconds?: number;
  perPairPerWeek?: number;
  longPollMs?: number;
}

/** The ticket as the program reads it (wager-codec.ts `WagerTicket`), the stake as a decimal string for JSON. */
export interface WagerTicketRecord {
  seriesId: string;
  playerA: string;
  playerB: string;
  stake: string;
  acceptDeadline: number;
  expiry: number;
  keyId: number;
}

export interface WagerSeries {
  id: string;
  ticket: WagerTicketRecord;
  /** The matchmaker's signature over the ticket message, hex. */
  signature: string;
  fighters: { A: string; B: string };
  createdAt: number;
  status: "ticketed" | "done";
  /** How it ended, once the chain says. */
  result?: { how: "settled"; winner: "A" | "B" | null } | { how: "cancelled" | "refunded" | "expired" };
}

/** A fighter's wager standing: its own rating and record, and the series it's in (null when free to queue). */
export interface WagerStanding {
  rating: Rating;
  record: Tally;
  series: string | null;
}

interface Entry {
  fighter: string;
  owner: string;
  tier: string;
  rating: number;
  since: number;
  seen: number;
  /** Not paired before this: a random wait of a few seconds. */
  readyAt: number;
}

interface WagerQueue {
  entries: Entry[];
  /** Pairings just made, so the partner's poll finds its series. */
  paired: Record<string, { series: string; at: number }>;
  /** Series between two owners this week (key: the two wallets, sorted). */
  pairs: { week: number; counts: Record<string, number> };
}

const QUEUE = "arena:wager-queue";
const OPEN = "arena:wagers-open";
const series = (id: string) => `arena:wager:${id}`;
const fighterKey = (id: string) => `arena:fighter:${id}`;
const ALIVE_MS = 60_000;
const WEEK_MS = 7 * 86_400_000;
const TICKET_DOMAIN = new TextEncoder().encode("highwire-line-ticket-1");
const ratingGap = (waitedMs: number) => 150 + 100 * Math.floor(waitedMs / 30_000);
const pairKey = (x: string, y: string) => [x, y].sort().join(":");
const emptyTally = (): Tally => ({ win: 0, draw: 0, loss: 0 });

const le = (n: bigint, bytes: number) => {
  const out = new Uint8Array(bytes);
  let v = BigInt.asUintN(bytes * 8, n);
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(v & 255n);
    v >>= 8n;
  }
  return out;
};
const key32 = (k: string) => {
  const b = bs58.decode(k);
  if (b.length !== 32) fail("bad_request", "not a 32-byte address");
  return b;
};
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The bytes the program checks (programs/line-wager/src/ticket.rs, wager-codec.ts `ticketMessage`). */
export function wagerTicketMessage(programId: string, t: WagerTicketRecord): Uint8Array {
  const parts = [TICKET_DOMAIN, key32(programId), hexBytes(t.seriesId), key32(t.playerA), key32(t.playerB), le(BigInt(t.stake), 8), le(BigInt(t.acceptDeadline), 8), le(BigInt(t.expiry), 8), le(BigInt(t.keyId), 2)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export type WagerJoin =
  | { series: WagerSeriesView }
  | { waiting: true; tier: string; waitingAtTier: number; needed: number; waitedSeconds: number };

/** What a player sees of its series: everything it needs to stake, nothing about anyone else's. */
export interface WagerSeriesView {
  id: string;
  role: "A" | "B";
  ticket: WagerTicketRecord;
  signature: string;
  programId: string;
  cluster: string;
  status: WagerSeries["status"];
  result?: WagerSeries["result"];
  /** What to do next, in a sentence. */
  next: string;
}

export class WagerDesk {
  private minQueue: number;
  private acceptMs: number;
  private openMs: number;
  private perPair: number;
  private longPollMs: number;
  private tiers: Set<string>;
  readonly ticketKey: string;

  constructor(
    private store: Store,
    private clock: Clock,
    private cfg: WagerConfig,
    private spend: (f: Fighter, units: number) => Promise<void>,
  ) {
    if (cfg.ticketSecret.length !== 32) throw new Error("the ticket key is a 32-byte Ed25519 secret");
    this.minQueue = cfg.minQueue ?? 4;
    this.acceptMs = (cfg.acceptSeconds ?? 300) * 1000;
    this.openMs = (cfg.openSeconds ?? 120) * 1000;
    this.perPair = cfg.perPairPerWeek ?? 2;
    this.longPollMs = cfg.longPollMs ?? 40_000;
    this.tiers = new Set(cfg.tiers.map(String));
    this.ticketKey = bs58.encode(ed25519.getPublicKey(cfg.ticketSecret));
  }

  /** What any client needs to know before it stakes: the program, the cluster, the tiers and the ticket key. */
  info() {
    return { programId: this.cfg.programId, cluster: this.cfg.cluster, tiers: [...this.tiers], ticketKey: this.ticketKey, keyId: this.cfg.keyId, minQueue: this.minQueue, perPairPerWeek: this.perPair };
  }

  private standing(f: Fighter): WagerStanding {
    return f.wager ?? { rating: START, record: emptyTally(), series: null };
  }

  private view(s: WagerSeries, f: Fighter): WagerSeriesView {
    const role = s.fighters.A === f.id ? "A" : "B";
    const next =
      s.status === "done"
        ? "This series is over; join again for another."
        : role === "A"
          ? `Open the series: stake ${s.ticket.stake} lamports with this ticket before ${new Date(s.ticket.expiry * 1000).toISOString()}.`
          : `Wait for A to open, then accept: stake ${s.ticket.stake} lamports with this ticket before ${new Date(s.ticket.acceptDeadline * 1000).toISOString()}.`;
    return { id: s.id, role, ticket: s.ticket, signature: s.signature, programId: this.cfg.programId, cluster: this.cfg.cluster, status: s.status, ...(s.result ? { result: s.result } : {}), next };
  }

  /** The fighter's series, if it's in one. */
  async state(f: Fighter): Promise<WagerSeriesView | { none: true }> {
    await this.spend(f, 1);
    const id = (await this.store.get<Fighter>(fighterKey(f.id)))?.value.wager?.series;
    const s = id ? (await this.store.get<WagerSeries>(series(id)))?.value : null;
    return s ? this.view(s, f) : { none: true };
  }

  /**
   * Queues at a tier (lamports a side, as a decimal string) and waits up to the long-poll limit to be paired. Returns the
   * series with its signed ticket, or the queue's state ("call again within a minute to keep the place"). A fighter
   * already in a series gets that series back.
   */
  async join(f: Fighter, input: { stake?: unknown; wait?: unknown }): Promise<WagerJoin> {
    if (f.operator) fail("refused", "Highwire's and the maintainer's own fighters never wager against the public.");
    const current = await this.state(f);
    if (!("none" in current)) return { series: current };
    const tier = typeof input.stake === "string" ? input.stake : typeof input.stake === "number" ? String(input.stake) : "";
    if (!this.tiers.has(tier)) fail("bad_request", `stake is one of the tiers, in lamports a side: ${[...this.tiers].join(", ")}.`);
    const wait = input.wait !== false;
    await this.spend(f, wait ? 5 : 1);
    const lock = `arena:wager-poll:${f.id}`;
    if (wait && (await this.store.cas(lock, 0, 1, Math.ceil(this.longPollMs / 1000) + 5)) === null) fail("rate_limited", "One wager join at a time per fighter.");
    try {
      const until = this.clock.now() + (wait ? this.longPollMs : 0);
      let pause = 1000;
      for (;;) {
        const now = this.clock.now();
        const step = await this.step(f, tier, now);
        if (step.series) {
          const s = (await this.store.get<WagerSeries>(series(step.series)))?.value;
          if (s) return { series: this.view(s, f) };
        }
        if (now >= until) return { waiting: true, tier, waitingAtTier: step.atTier, needed: this.minQueue, waitedSeconds: Math.round(step.waited / 1000) };
        await this.clock.sleep(Math.min(pause, Math.max(0, until - now)));
        pause = Math.min(2000, pause * 1.25);
      }
    } finally {
      if (wait) await this.store.del(lock).catch(() => undefined);
    }
  }

  /** Leaves the queue. */
  async leave(f: Fighter): Promise<{ left: boolean }> {
    let left = false;
    await update<WagerQueue>(this.store, QUEUE, (cur) => {
      if (!cur?.entries.some((e) => e.fighter === f.id)) return undefined;
      left = true;
      return { ...cur, entries: cur.entries.filter((e) => e.fighter !== f.id) };
    });
    return { left };
  }

  /** One look at the queue: a pairing made by someone else's poll, a partner (the series is made here), or a place. */
  private async step(f: Fighter, tier: string, now: number): Promise<{ series?: string; atTier: number; waited: number }> {
    const me = (await this.store.get<Fighter>(fighterKey(f.id)))?.value;
    if (me?.wager?.series) return { series: me.wager.series, atTier: 0, waited: 0 };
    const id = randomHex(32);
    const week = Math.floor(now / WEEK_MS);
    let outcome: { series?: string; partner?: Entry; atTier: number; waited: number } = { atTier: 0, waited: 0 };
    await update<WagerQueue>(this.store, QUEUE, (cur) => {
      const q: WagerQueue = {
        entries: (cur?.entries ?? []).filter((e) => now - e.seen < ALIVE_MS),
        paired: Object.fromEntries(Object.entries(cur?.paired ?? {}).filter(([, v]) => now - v.at < 2 * ALIVE_MS)),
        pairs: cur?.pairs.week === week ? cur.pairs : { week, counts: {} },
      };
      const done = q.paired[f.id];
      if (done) {
        delete q.paired[f.id];
        outcome = { series: done.series, atTier: 0, waited: 0 };
        return q;
      }
      const mine = q.entries.find((e) => e.fighter === f.id);
      const entry: Entry = {
        fighter: f.id,
        owner: f.wallet,
        tier,
        rating: this.standing(f).rating.r,
        since: mine && mine.tier === tier ? mine.since : now,
        seen: now,
        readyAt: mine && mine.tier === tier ? mine.readyAt : now + 2_000 + Math.floor(Math.random() * 8_000),
      };
      const others = q.entries.filter((e) => e.fighter !== f.id);
      const atTier = others.filter((e) => e.tier === tier);
      const owners = new Set([entry.owner, ...atTier.map((e) => e.owner)]);
      const waited = now - entry.since;
      outcome = { atTier: atTier.length + 1, waited };
      if (owners.size < this.minQueue || now < entry.readyAt) return { ...q, entries: [...others, entry] };
      const fits = atTier
        .filter((e) => e.owner !== entry.owner && now >= e.readyAt)
        .filter((e) => (q.pairs.counts[pairKey(e.owner, entry.owner)] ?? 0) < this.perPair)
        .filter((e) => Math.abs(e.rating - entry.rating) <= ratingGap(Math.max(waited, now - e.since)))
        .sort((x, y) => Math.abs(x.rating - entry.rating) - Math.abs(y.rating - entry.rating) || x.since - y.since);
      const partner = fits[0];
      if (!partner) return { ...q, entries: [...others, entry] };
      const k = pairKey(partner.owner, entry.owner);
      outcome = { series: id, partner, atTier: atTier.length - 1, waited };
      return {
        entries: others.filter((e) => e.fighter !== partner.fighter),
        paired: { ...q.paired, [partner.fighter]: { series: id, at: now } },
        pairs: { week, counts: { ...q.pairs.counts, [k]: (q.pairs.counts[k] ?? 0) + 1 } },
      };
    });
    if (outcome.partner && !(await this.ticket(f, outcome.partner, id, tier, now))) return { atTier: outcome.atTier, waited: outcome.waited };
    return outcome;
  }

  /** Signs the ticket for a pairing and records the series. A plays first or second at random. */
  private async ticket(f: Fighter, partner: Entry, id: string, tier: string, now: number): Promise<boolean> {
    const other = (await this.store.get<Fighter>(fighterKey(partner.fighter)))?.value;
    if (!other || other.wager?.series) return false;
    const [a, b] = Math.random() < 0.5 ? [f, other] : [other, f];
    const secs = Math.floor(now / 1000);
    const ticket: WagerTicketRecord = {
      seriesId: id,
      playerA: a.wallet,
      playerB: b.wallet,
      stake: tier,
      acceptDeadline: secs + Math.floor(this.acceptMs / 1000),
      expiry: secs + Math.floor(this.openMs / 1000),
      keyId: this.cfg.keyId,
    };
    const signature = toHex(ed25519.sign(wagerTicketMessage(this.cfg.programId, ticket), this.cfg.ticketSecret));
    const record: WagerSeries = { id, ticket, signature, fighters: { A: a.id, B: b.id }, createdAt: now, status: "ticketed" };
    await this.store.cas(series(id), 0, record);
    for (const x of [a, b]) await update<Fighter>(this.store, fighterKey(x.id), (cur) => (cur ? { ...cur, wager: { ...this.standing(cur), series: id } } : undefined));
    await update<string[]>(this.store, OPEN, (cur) => [...(cur ?? []), id]);
    return true;
  }

  /**
   * The cron's pass over every ticketed series: asks the chain where each stands, and once it's closed (or its ticket
   * expired unopened) records the outcome, rates a decided or drawn series, and frees both fighters.
   */
  async sweep(): Promise<{ open: number; done: number }> {
    const ids = (await this.store.get<string[]>(OPEN))?.value ?? [];
    let done = 0;
    for (const id of ids) {
      const s = (await this.store.get<WagerSeries>(series(id)))?.value;
      if (!s || s.status === "done") {
        await this.close(id, null);
        done++;
        continue;
      }
      let st;
      try {
        st = await this.cfg.chain.status(id, s.ticket);
      } catch {
        continue;
      }
      const nowSecs = Math.floor(this.clock.now() / 1000);
      if (st.state === "none" && nowSecs > s.ticket.expiry + 60) {
        await this.close(id, { how: "expired" });
        done++;
      } else if (st.state === "closed") {
        await this.close(id, st.how === "settled" ? { how: "settled", winner: st.winner } : { how: st.how });
        done++;
      }
    }
    return { open: ids.length - done, done };
  }

  private async close(id: string, result: WagerSeries["result"] | null): Promise<void> {
    let first = false;
    const s = await update<WagerSeries>(this.store, series(id), (cur) => {
      if (!cur || cur.status === "done") return undefined;
      first = true;
      return { ...cur, status: "done", ...(result ? { result } : {}) };
    });
    if (first && s) {
      const [fa, fb] = await Promise.all([s.fighters.A, s.fighters.B].map(async (x) => (await this.store.get<Fighter>(fighterKey(x)))?.value));
      const score = result?.how === "settled" ? (result.winner === "A" ? 1 : result.winner === "B" ? 0 : 0.5) : null;
      for (const [me, them, mine] of [
        [fa, fb, score],
        [fb, fa, score === null ? null : 1 - score],
      ] as const) {
        if (!me) continue;
        await update<Fighter>(this.store, fighterKey(me.id), (cur) => {
          if (!cur) return undefined;
          const w = this.standing(cur);
          const next: WagerStanding = { ...w, series: w.series === id ? null : w.series };
          if (mine !== null && them) {
            next.rating = rate(w.rating, [{ opponent: this.standing(them).rating, score: mine as 0 | 0.5 | 1 }]);
            next.record = mine === 1 ? { ...w.record, win: w.record.win + 1 } : mine === 0 ? { ...w.record, loss: w.record.loss + 1 } : { ...w.record, draw: w.record.draw + 1 };
          }
          return { ...cur, wager: next };
        });
      }
    }
    await update<string[]>(this.store, OPEN, (cur) => (cur?.includes(id) ? cur.filter((x) => x !== id) : undefined));
  }
}
