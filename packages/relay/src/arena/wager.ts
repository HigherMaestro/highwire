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

/** What the deployment tells the desk about the chain: where each series it ticketed stands (`seriesOutcome`). */
export interface WagerChain {
  /**
   * open: A staked, waiting for B. live: both staked. closed: the program's own closing event for this series, and how.
   * none: no account and no closing event found: never opened, or closed out of reach (the desk tells which by what it
   * saw before).
   */
  status(seriesId: string): Promise<
    | { state: "none" | "open" | "live" }
    | { state: "closed"; how: "settled"; winner: "A" | "B" | null }
    | { state: "closed"; how: "cancelled" | "refunded" }
  >;
  /**
   * The program's config as it stands: whether new series are paused, and the ticket key id it accepts. Without it the
   * desk pairs regardless; with it, it pairs only when a ticket could open.
   */
  config?(): Promise<{ paused: boolean; keyId: number }>;
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
  /**
   * How long the ticket lives, from the pairing: A must open and B accept within it (the program takes one time for
   * both: an accept deadline no later than the expiry). Default 5 minutes. A is told to open at once.
   */
  acceptSeconds?: number;
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
  /** The last state the desk saw on-chain, and when (ms). */
  seen?: { state: "open" | "live"; at: number };
  /** Set when closing starts: the result and both ratings before it, so a close that's retried rates the same. */
  closing?: { result: WagerResult; before: { A: Rating; B: Rating } };
  /** How it ended. */
  result?: WagerResult;
}

/**
 * settled: the program's closing event (rated). cancelled, refunded: closed without a result (unrated). expired: never
 * opened. unaccepted: A opened and B never accepted; both are free, and A's daemon (or anyone) cancels on-chain. unread:
 * it went live, then its account closed without a closing event the desk could find: unrated.
 */
export type WagerResult = { how: "settled"; winner: "A" | "B" | null } | { how: "cancelled" | "refunded" | "expired" | "unaccepted" | "unread" };

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

/**
 * The desk's store keys. Devnet keeps the names it always had; mainnet's are apart, so nothing from practice (the
 * queue, a series, a pairing count) can reach a desk playing for real.
 */
function deskKeys(cluster: "devnet" | "mainnet") {
  const ns = cluster === "mainnet" ? "arena:mainnet:" : "arena:";
  return {
    queue: `${ns}wager-queue`,
    open: `${ns}wagers-open`,
    ticketed: `${ns}wagers-ticketed`,
    series: (id: string) => `${ns}wager:${id}`,
    poll: (fighter: string) => `${ns}wager-poll:${fighter}`,
  };
}
/** How many ticketed series the desk remembers for the wager pages (only a ticketed series can open). */
const TICKETED_MAX = 1000;
const fighterKey = (id: string) => `arena:fighter:${id}`;
const ALIVE_MS = 60_000;
/**
 * Past the ticket's time on the server's clock before "never opened" is believed: the chain's clock can lag, by seconds.
 * Until then both fighters are held by a ticket nobody can use, so it's short; an open that lags past it is still safe
 * (A's stake comes back through the cancel after the deadline).
 */
const EXPIRY_MARGIN_MS = 2 * 60_000;
/** A live series whose account vanished with no closing event found: unrated after this long. */
const UNREAD_AFTER_MS = 60 * 60_000;
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
  /** The store keys and the fighter's standing field for this desk's cluster: devnet's and mainnet's never mix. */
  private k: ReturnType<typeof deskKeys>;
  private field: "wager" | "wagerMainnet";
  private acceptMs: number;
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
    this.k = deskKeys(cfg.cluster);
    this.field = cfg.cluster === "mainnet" ? "wagerMainnet" : "wager";
    // Checked here, not when a pairing is signed: a bad value would otherwise spend pairs' weekly counts on tickets
    // that can't be made.
    if (cfg.ticketSecret.length !== 32) throw new Error("the ticket key is a 32-byte Ed25519 secret");
    if (bs58.decode(cfg.programId).length !== 32) throw new Error("the wager program id isn't an address");
    if (!Number.isInteger(cfg.keyId) || cfg.keyId < 0 || cfg.keyId > 65_535) throw new Error("the ticket key id is a whole number from 0 to 65535");
    if (cfg.tiers.length === 0 || cfg.tiers.some((t) => typeof t !== "bigint" || t <= 0n || t >= 2n ** 64n)) throw new Error("each tier is a positive number of lamports");
    this.minQueue = cfg.minQueue ?? 4;
    if (!Number.isInteger(this.minQueue) || this.minQueue < 2) throw new Error("minQueue is at least 2");
    this.acceptMs = (cfg.acceptSeconds ?? 300) * 1000;
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
    return f[this.field] ?? { rating: START, record: emptyTally(), series: null };
  }

  private view(s: WagerSeries, f: Fighter): WagerSeriesView {
    const role = s.fighters.A === f.id ? "A" : "B";
    const next =
      s.status === "done"
        ? "This series is over; join again for another."
        : role === "A"
          ? `Open the series now: stake ${s.ticket.stake} lamports with this ticket. B must accept by ${new Date(s.ticket.acceptDeadline * 1000).toISOString()}, so the sooner the better.`
          : `Wait for A to open, then accept: stake ${s.ticket.stake} lamports with this ticket by ${new Date(s.ticket.acceptDeadline * 1000).toISOString()}.`;
    return { id: s.id, role, ticket: s.ticket, signature: s.signature, programId: this.cfg.programId, cluster: this.cfg.cluster, status: s.status, ...(s.result ? { result: s.result } : {}), next };
  }

  /** The fighter's series, if it's in one. */
  async state(f: Fighter): Promise<(WagerSeriesView | { none: true }) & { you: { rating: number; record: Tally } }> {
    await this.spend(f, 1);
    const s = await this.activeSeries(f.id);
    const me = (await this.store.get<Fighter>(fighterKey(f.id)))?.value ?? f;
    const w = this.standing(me);
    const you = { rating: Math.round(w.rating.r), record: w.record };
    return s ? { ...this.view(s, f), you } : { none: true, you };
  }

  /**
   * The newest series the desk ticketed that reached the chain (opened, by what the desk saw, or closed), for the practice
   * pages' list: the wallets, when it paired them, the fighters, and how the desk recorded the end. The pages read each
   * series' moves and result from the chain; this only says which series to look for, so transactions that crowd the
   * program's accounts can't push a series off the list.
   */
  async ticketed(limit = 300): Promise<{ id: string; playerA: string; playerB: string; createdAt: number; result: WagerResult | null; fighters: Record<"A" | "B", { id: string; name: string; ticker: string }> }[]> {
    const ids = ((await this.store.get<string[]>(this.k.ticketed))?.value ?? []).slice(-Math.max(1, Math.min(limit, TICKETED_MAX))).reverse();
    const known = new Map<string, Fighter | null>();
    const show = async (fid: string) => {
      if (!known.has(fid)) known.set(fid, (await this.store.get<Fighter>(fighterKey(fid)))?.value ?? null);
      const f = known.get(fid);
      return { id: fid, name: f?.name ?? "A fighter", ticker: f?.ticker ?? "" };
    };
    const out = [];
    for (const id of ids) {
      const s = (await this.store.get<WagerSeries>(this.k.series(id)))?.value;
      if (!s) continue;
      // Reached the chain: the desk saw it open or live, or it closed in a way only an opened series can.
      const reached = s.seen !== undefined || (s.result !== undefined && s.result.how !== "expired" && s.result.how !== "unaccepted");
      if (!reached) continue;
      out.push({ id, playerA: s.ticket.playerA, playerB: s.ticket.playerB, createdAt: s.createdAt, result: s.result ?? null, fighters: { A: await show(s.fighters.A), B: await show(s.fighters.B) } });
    }
    return out;
  }

  /**
   * Who played each series the desk ticketed, for the practice pages: each side's fighter, its name and its ticker (coin
   * names: creator content, shown as text). Series it never ticketed are left out.
   */
  async fighters(ids: string[]): Promise<Record<string, Record<"A" | "B", { id: string; name: string; ticker: string }>>> {
    const out: Record<string, Record<"A" | "B", { id: string; name: string; ticker: string }>> = {};
    const known = new Map<string, Fighter | null>();
    const fighter = async (id: string) => {
      if (!known.has(id)) known.set(id, (await this.store.get<Fighter>(fighterKey(id)))?.value ?? null);
      return known.get(id)!;
    };
    for (const id of ids.filter((x) => /^[0-9a-f]{64}$/.test(x)).slice(0, 200)) {
      const s = (await this.store.get<WagerSeries>(this.k.series(id)))?.value;
      if (!s) continue;
      const [a, b] = [await fighter(s.fighters.A), await fighter(s.fighters.B)];
      const show = (f: Fighter | null, fid: string) => ({ id: fid, name: f?.name ?? "A fighter", ticker: f?.ticker ?? "" });
      out[id] = { A: show(a, s.fighters.A), B: show(b, s.fighters.B) };
    }
    return out;
  }

  private configRead: { at: number; value: Promise<{ paused: boolean; keyId: number } | null> } | null = null;

  /** The program's config, read at most every 30 seconds; null when the deployment can't say (pairing goes on). */
  private programConfig(): Promise<{ paused: boolean; keyId: number } | null> {
    const now = this.clock.now();
    if (!this.cfg.chain.config) return Promise.resolve(null);
    if (!this.configRead || now - this.configRead.at > 30_000) this.configRead = { at: now, value: this.cfg.chain.config().catch(() => null) };
    return this.configRead.value;
  }

  /** The series a fighter is in, if it's still being played: a pointer to a finished or missing series doesn't count. */
  private async activeSeries(fighter: string): Promise<WagerSeries | null> {
    const id = (await this.store.get<Fighter>(fighterKey(fighter)))?.value[this.field]?.series;
    if (!id) return null;
    const s = (await this.store.get<WagerSeries>(this.k.series(id)))?.value;
    return s && s.status !== "done" ? s : null;
  }

  /**
   * Queues at a tier (lamports a side, as a decimal string) and waits up to the long-poll limit to be paired. Returns the
   * series with its signed ticket, or the queue's state ("call again within a minute to keep the place"). A fighter
   * already in a series gets that series back.
   */
  async join(f: Fighter, input: { stake?: unknown; wait?: unknown }): Promise<WagerJoin> {
    if (f.operator) fail("refused", "Highwire's and the maintainer's own fighters never wager against the public.");
    const current = await this.activeSeries(f.id);
    if (current) return { series: this.view(current, f) };
    // A ticket the program would refuse (paused, or signed with a key it no longer holds) would only hold both fighters
    // and spend the pair's weekly count: don't pair until it could open.
    const onChain = await this.programConfig();
    if (onChain?.paused) fail("refused", "Wagering is paused: no new series for now. Try again later.");
    if (onChain && onChain.keyId !== this.cfg.keyId) fail("refused", "The matchmaker's key is being changed: no new series for a few minutes. Try again later.");
    const tier = typeof input.stake === "string" ? input.stake : typeof input.stake === "number" ? String(input.stake) : "";
    if (!this.tiers.has(tier)) fail("bad_request", `stake is one of the tiers, in lamports a side: ${[...this.tiers].join(", ")}.`);
    const wait = input.wait !== false;
    await this.spend(f, wait ? 5 : 1);
    // One join at a time per fighter, waiting or not: two at once could queue it again after the other paired it.
    const lock = this.k.poll(f.id);
    if ((await this.store.cas(lock, 0, 1, Math.ceil(this.longPollMs / 1000) + 5)) === null) fail("rate_limited", "One wager join at a time per fighter.");
    try {
      const until = this.clock.now() + (wait ? this.longPollMs : 0);
      let pause = 1000;
      for (;;) {
        const now = this.clock.now();
        const step = await this.step(f, tier, now);
        if (step.series) {
          const s = (await this.store.get<WagerSeries>(this.k.series(step.series)))?.value;
          if (s) return { series: this.view(s, f) };
        }
        if (now >= until) return { waiting: true, tier, waitingAtTier: step.atTier, needed: this.minQueue, waitedSeconds: Math.round(step.waited / 1000) };
        await this.clock.sleep(Math.min(pause, Math.max(0, until - now)));
        pause = Math.min(2000, pause * 1.25);
      }
    } finally {
      await this.store.del(lock).catch(() => undefined);
    }
  }

  /** Leaves the queue. */
  async leave(f: Fighter): Promise<{ left: boolean }> {
    let left = false;
    await update<WagerQueue>(this.store, this.k.queue, (cur) => {
      if (!cur?.entries.some((e) => e.fighter === f.id)) return undefined;
      left = true;
      return { ...cur, entries: cur.entries.filter((e) => e.fighter !== f.id) };
    });
    return { left };
  }

  /** One look at the queue: a pairing made by someone else's poll, a partner (the series is made here), or a place. */
  private async step(f: Fighter, tier: string, now: number): Promise<{ series?: string; atTier: number; waited: number }> {
    const mine = await this.activeSeries(f.id);
    if (mine) return { series: mine.id, atTier: 0, waited: 0 };
    // A pairing note from someone else's poll, if its series is still on (a note can outlive a series that ended fast).
    const note = (await this.store.get<WagerQueue>(this.k.queue))?.value.paired[f.id];
    const noted = note ? (await this.store.get<WagerSeries>(this.k.series(note.series)))?.value : null;
    const id = randomHex(32);
    const week = Math.floor(now / WEEK_MS);
    let outcome: { series?: string; partner?: Entry; atTier: number; waited: number } = { atTier: 0, waited: 0 };
    await update<WagerQueue>(this.store, this.k.queue, (cur) => {
      const q: WagerQueue = {
        entries: (cur?.entries ?? []).filter((e) => now - e.seen < ALIVE_MS),
        paired: Object.fromEntries(Object.entries(cur?.paired ?? {}).filter(([, v]) => now - v.at < 2 * ALIVE_MS)),
        pairs: cur?.pairs.week === week ? cur.pairs : { week, counts: {} },
      };
      const done = q.paired[f.id];
      if (done) {
        delete q.paired[f.id];
        if (done.series === noted?.id && noted.status !== "done") {
          outcome = { series: done.series, atTier: 0, waited: 0 };
          return q;
        }
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
    if (outcome.partner) {
      const made = await this.ticket(f, outcome.partner, id, tier, now).catch(() => false);
      if (!made) {
        // No series: give the pair its weekly count back, and drop the partner's note.
        const k = pairKey(outcome.partner.owner, f.wallet);
        await update<WagerQueue>(this.store, this.k.queue, (cur) => {
          if (!cur) return undefined;
          const paired = { ...cur.paired };
          if (paired[outcome.partner!.fighter]?.series === id) delete paired[outcome.partner!.fighter];
          const counts = { ...cur.pairs.counts };
          if (cur.pairs.week === week && (counts[k] ?? 0) > 0) counts[k] = counts[k]! - 1;
          return { ...cur, paired, pairs: { ...cur.pairs, counts } };
        }).catch(() => undefined);
        return { atTier: outcome.atTier, waited: outcome.waited };
      }
    }
    return outcome;
  }

  /**
   * Signs the ticket for a pairing and records the series. A plays first or second at random. Written so a failure at
   * any point leaves nothing the sweep can't finish: the open list first, then the series, then the fighters' pointers.
   */
  private async ticket(f: Fighter, partner: Entry, id: string, tier: string, now: number): Promise<boolean> {
    const other = (await this.store.get<Fighter>(fighterKey(partner.fighter)))?.value;
    if (!other || (await this.activeSeries(other.id))) return false;
    const [a, b] = Math.random() < 0.5 ? [f, other] : [other, f];
    // One time for both: the program refuses an accept deadline later than the expiry.
    const until = Math.floor((now + this.acceptMs) / 1000);
    const ticket: WagerTicketRecord = { seriesId: id, playerA: a.wallet, playerB: b.wallet, stake: tier, acceptDeadline: until, expiry: until, keyId: this.cfg.keyId };
    const signature = toHex(ed25519.sign(wagerTicketMessage(this.cfg.programId, ticket), this.cfg.ticketSecret));
    await update<string[]>(this.store, this.k.open, (cur) => [...(cur ?? []), id]);
    await update<string[]>(this.store, this.k.ticketed, (cur) => [...(cur ?? []), id].slice(-TICKETED_MAX));
    await this.store.cas(this.k.series(id), 0, { id, ticket, signature, fighters: { A: a.id, B: b.id }, createdAt: now, status: "ticketed" } satisfies WagerSeries);
    for (const x of [a, b]) await update<Fighter>(this.store, fighterKey(x.id), (cur) => (cur ? { ...cur, [this.field]: { ...this.standing(cur), series: id } } : undefined));
    return true;
  }

  /**
   * The cron's pass over every ticketed series: asks the chain where each stands and, once it's over, records the
   * outcome, rates a settled series, and frees both fighters. Every way a series can stall ends: a ticket never used
   * expires, a series B never accepted frees both, and one that vanished without a closing event the desk could read
   * closes unrated after an hour.
   */
  async sweep(): Promise<{ open: number; done: number }> {
    const ids = (await this.store.get<string[]>(this.k.open))?.value ?? [];
    let done = 0;
    for (const id of ids) {
      try {
        if (await this.sweepOne(id)) done++;
      } catch {
        /* the chain or the store didn't answer: next minute */
      }
    }
    return { open: ids.length - done, done };
  }

  private async sweepOne(id: string): Promise<boolean> {
    const s = (await this.store.get<WagerSeries>(this.k.series(id)))?.value;
    if (!s) {
      await update<string[]>(this.store, this.k.open, (cur) => (cur?.includes(id) ? cur.filter((x) => x !== id) : undefined));
      return true;
    }
    if (s.status === "done") {
      await this.close(s, s.result ?? { how: "unread" });
      return true;
    }
    const now = this.clock.now();
    if (s.closing) {
      await this.close(s, s.closing.result);
      return true;
    }
    const st = await this.cfg.chain.status(id);
    if (st.state === "closed") {
      await this.close(s, st.how === "settled" ? { how: "settled", winner: st.winner } : { how: st.how });
      return true;
    }
    if (st.state === "open" || st.state === "live") {
      const state = st.state;
      // Refreshed every pass: "unread" counts from the last time the series was seen on-chain.
      await update<WagerSeries>(this.store, this.k.series(id), (cur) => (cur ? { ...cur, seen: { state, at: now } } : undefined));
      if (state === "open" && now > s.ticket.acceptDeadline * 1000 + EXPIRY_MARGIN_MS) {
        await this.close(s, { how: "unaccepted" });
        return true;
      }
      return false;
    }
    // none: never opened, or closed out of reach.
    if (!s.seen && now > s.ticket.expiry * 1000 + EXPIRY_MARGIN_MS) {
      await this.close(s, { how: "expired" });
      // Never played: the pair gets its weekly count back, as when a ticket can't be made.
      const week = Math.floor(s.createdAt / WEEK_MS);
      const k = pairKey(s.ticket.playerA, s.ticket.playerB);
      await update<WagerQueue>(this.store, this.k.queue, (cur) => {
        if (!cur || cur.pairs.week !== week || !(cur.pairs.counts[k]! > 0)) return undefined;
        return { ...cur, pairs: { ...cur.pairs, counts: { ...cur.pairs.counts, [k]: cur.pairs.counts[k]! - 1 } } };
      }).catch(() => undefined);
      return true;
    }
    if (s.seen && now - s.seen.at > UNREAD_AFTER_MS) {
      await this.close(s, { how: s.seen.state === "open" ? "unaccepted" : "unread" });
      return true;
    }
    return false;
  }

  /**
   * Closes a series, safely retried: the result and both ratings before it are recorded first; each fighter is updated
   * only while it still points at this series (so its rating changes once); then the series is done and leaves the
   * open list. A failure anywhere leaves it for the next sweep to finish.
   */
  private async close(s: WagerSeries, result: WagerResult): Promise<void> {
    const id = s.id;
    const read = async (x: string) => (await this.store.get<Fighter>(fighterKey(x)))?.value;
    let closing = s.closing;
    if (!closing) {
      const [fa, fb] = [await read(s.fighters.A), await read(s.fighters.B)];
      const before = { A: fa ? this.standing(fa).rating : START, B: fb ? this.standing(fb).rating : START };
      const set = await update<WagerSeries>(this.store, this.k.series(id), (cur) => (cur && !cur.closing ? { ...cur, closing: { result, before } } : undefined));
      closing = set?.closing ?? { result, before };
    }
    const score = closing.result.how === "settled" ? (closing.result.winner === "A" ? 1 : closing.result.winner === "B" ? 0 : 0.5) : null;
    for (const role of ["A", "B"] as const) {
      const other = role === "A" ? "B" : "A";
      const mine = score === null ? null : role === "A" ? score : 1 - score;
      await update<Fighter>(this.store, fighterKey(s.fighters[role]), (cur) => {
        if (!cur || cur[this.field]?.series !== id) return undefined;
        const w = this.standing(cur);
        const next: WagerStanding = { ...w, series: null };
        if (mine !== null) {
          next.rating = rate(closing!.before[role], [{ opponent: closing!.before[other], score: mine as 0 | 0.5 | 1 }]);
          next.record = mine === 1 ? { ...w.record, win: w.record.win + 1 } : mine === 0 ? { ...w.record, loss: w.record.loss + 1 } : { ...w.record, draw: w.record.draw + 1 };
        }
        return { ...cur, [this.field]: next };
      });
    }
    await update<WagerSeries>(this.store, this.k.series(id), (cur) => (cur && cur.status !== "done" ? { ...cur, status: "done", result: closing!.result } : undefined));
    await update<string[]>(this.store, this.k.open, (cur) => (cur?.includes(id) ? cur.filter((x) => x !== id) : undefined));
  }
}
