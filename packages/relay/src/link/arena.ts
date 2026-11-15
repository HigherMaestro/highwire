import { checkTableTalk, conservative, PROVISIONAL_RD, rate, START, type Rating } from "highwire-core/arena";
import type { Clock } from "../clock.ts";
import { fail, RelayError } from "../errors.ts";
import { randomHex } from "../registration.ts";
import { update, type Store } from "../store.ts";
import type { Fighter, Outage, Tally } from "../arena/types.ts";
import { activeMs } from "../arena/match.ts";
import type { LinkEngine } from "./referee.ts";
import { linkMatchId, parseAction, type LinkAction } from "./common.ts";

// Rated link battles (docs/link-battles.md 4.2, 6, 8.2, 9): agent against agent, or against the house when nobody's
// there to pair with. The battle runs in the engine the site passes in; this is the referee around it.
//
// A match is one small document (`link:match:<id>`), written by compare-and-set, and its packed battle under its own key
// per write. Each decision point opens with both sides' views, which side is asked, each asked agent's fallback and the
// house's decision. An agent's decision is held in the document and never served (nor whether it has arrived) until the
// turn resolves. When every asked side has decided, the turn is marked resolving and the answer goes back at once; the
// turn itself runs after the response (the host's `defer`), under a lock, and its result is committed by
// compare-and-set, re-applied over any change that left the turn alone. A resolution that died is run again by the
// sweep (the dice are dealt afresh: nothing was kept); one that keeps failing voids the battle.
//
// Clocks (4.2): each side has a bank, charged only while it's asked and hasn't decided. An empty bank takes the fallback
// at once. A side asked and silent for two minutes forfeits (both: void). The cap and draws are the engine's and 4.2's.
// Neither clock counts an outage of the store (The Line's record of them): nobody loses time it couldn't play.
//
// Fighters are claimed by compare-and-set before a battle is made, so none is ever in two at once. Public reads (the
// pages) never write: they show the battle with its clocks played forward in memory, and only agents' calls and the
// minute's sweep move a battle on, so the emulator never runs in a page's function.

export type FallbackKind = "first" | "strongest" | "random";
const FALLBACKS: FallbackKind[] = ["first", "strongest", "random"];

/** How the engine is told who plays each side (highwire-link's RatedSides). */
export interface RatedSidesSpec {
  kinds: [{ house: true } | { house: false; fallback: FallbackKind }, { house: true } | { house: false; fallback: FallbackKind }];
  seed: string;
}

/** One step of a rated battle, as the engine returns it. Views are built by the engine; the referee only stores them. */
export interface LinkMatchStep {
  state: unknown;
  packed: Uint8Array | null;
  turn: number;
  asked: [boolean, boolean];
  /** Each side's own view: served only to that side. */
  views: [unknown, unknown];
  spectator: unknown;
  /** Held, never served. */
  fallbacks: [LinkAction | null, LinkAction | null];
  house: [LinkAction | null, LinkAction | null];
  chosen: number;
  ended: null | { reason: "knockout" | "draw" | "void"; winner: 0 | 1 | null; message?: string };
  format: string;
  version: string;
  film?: unknown;
}

/** The engine's rated half (the site's engine has both): it starts a battle and resolves its turns. */
export interface RatedEngine {
  startMatch(sides: RatedSidesSpec, labels: [string, string], trainers: [string, string]): Promise<LinkMatchStep>;
  resolveMatch(state: unknown, packed: Uint8Array, decisions: [LinkAction | null, LinkAction | null], sides: RatedSidesSpec, labels: [string, string]): Promise<LinkMatchStep>;
}

type Side = 0 | 1;
const SIDES = [0, 1] as const;

interface MatchSide {
  kind: "fighter" | "house";
  /** The coin's mint, or "house". */
  id: string;
  name: string;
  ticker: string;
  /** The wallet that registered it (never paired with its own owner's fighters). */
  owner: string | null;
  fallback: FallbackKind | null;
  /** Clock left, in ms: charged when the side decides. */
  bank: number;
  /** The clock as the decision point opened: what the public page shows, since a clock that just stopped would say the side had decided. */
  bankAtOpen?: number;
  /** The last time this side called the referee. */
  seen: number;
  /** Decisions it was asked for, and made itself (not by fallback): draws are rated only when both made half (4.2). */
  asked: number;
  own: number;
}

export type LinkEnding = {
  reason: "knockout" | "draw" | "void" | "forfeit";
  winner: Side | null;
  message?: string;
  /** The sides that stopped answering, for a forfeit or void by silence. */
  silent?: Side[];
};

export interface LinkMatchDoc {
  id: string;
  format: string;
  version: string;
  rated: boolean;
  house: boolean;
  seed: string;
  startedAt: number;
  updatedAt: number;
  sides: [MatchSide, MatchSide];
  /** Turns played, and turns where somebody chose. */
  turn: number;
  chosen: number;
  status: "deciding" | "resolving" | "over";
  /** When the decision point opened: clocks run from here. */
  openedAt: number;
  resolvingSince: number | null;
  /** Resolutions of this turn started (by the answer and the sweep): past MAX_RESOLVES, the battle is voided. */
  attempts?: number;
  asked: [boolean, boolean];
  /** Held until the turn resolves; never served. */
  decided: [LinkAction | null, LinkAction | null];
  fallbacks: [LinkAction | null, LinkAction | null];
  /** Table talk by turn: a line is served once its turn has resolved. */
  lines: { turn: number; side: Side; line: string }[];
  state: unknown;
  stateKey: string | null;
  views: [unknown, unknown];
  spectator: unknown;
  ended: LinkEnding | null;
  /** Each side's rating change from this battle, once it's settled (null: none, the house, or not rated). */
  ratings?: [number | null, number | null];
  houseCounted?: boolean;
  settled: boolean;
}

/** A fighter's link battles record and rating: its own ladder (`colosseum-1`), beside The Line's. */
export interface LinkFighter {
  id: string;
  name: string;
  ticker: string;
  wallet: string;
  operator: boolean;
  rating: Rating;
  record: { rated: Tally; unrated: Tally; house: Tally };
  recent: { opponent: string; at: number; rated: boolean; score: number }[];
  establishedOpponents: string[];
  opponentOwners: string[];
  /** The battle it's in, claimed (with `claimedAt`) before the battle's document exists. */
  match: string | null;
  claimedAt?: number;
  /** The battle it played last: link_state shows how it ended until the next one starts (the end arrives after the last move). */
  last?: string | null;
  /** It stopped answering in a battle: it may not join again until then. */
  cooldownUntil?: number;
}

export interface LinkArenaConfig {
  /** Each side's clock, in ms (4.2: 8 minutes). */
  bankMs?: number;
  /** Asked and silent this long: a forfeit (4.2: 2 minutes). */
  goneMs?: number;
  /** Unpaired this long: the house plays (9: 2 minutes). */
  houseAfterMs?: number;
  /** How long a long-poll waits, in ms. */
  longPollMs?: number;
  /** Battles against the house running at once, across every fighter (each runs real Game Boys). */
  maxHouse?: number;
}

const MATCH = (id: string) => `link:match:${id}`;
const STATE = (id: string, turn: number) => `link:mstate:${id}:${turn}:${linkMatchId()}`;
const RESOLVING = (id: string) => `link:resolving:${id}`;
const FIGHTER = (id: string) => `link:fighter:${id}`;
const FIGHTER_MATCHES = (id: string) => `link:fighter-matches:${id}`;
const FIGHTERS = "link:fighters";
const OPEN = "link:open";
const RECENT = "link:recent";
const QUEUE = "link:queue";
const HOUSE_TALLY = "link:house";
const HOUSE_OPEN = "link:house-open";
const RECENT_MAX = 60;
const FIGHTER_MATCHES_MAX = 50;
/** A queue place lives this long after its last call: about one long-poll, so an agent that stopped isn't paired. */
const QUEUE_ALIVE_MS = 45_000;
const RATED_PER_WEEK = 3;
const WEEK_MS = 7 * 86_400_000;
/** A resolution not committed after this long died with its function: the sweep runs it again. */
const STALE_RESOLVE_MS = 120_000;
/** Resolutions of one turn started before the battle is voided as one that can't go on. */
const MAX_RESOLVES = 4;
/** A claim whose battle never appeared (its function died making it) is let go after this long. */
const CLAIM_STALE_MS = 120_000;
/** A fighter that stopped answering in a battle waits this long to join again. */
const COOLDOWN_MS = 5 * 60_000;
/** Matches are kept this long after their last write; a packed battle only a day (a live one is rewritten every turn). */
const MATCH_TTL = 30 * 86_400;
const STATE_TTL = 86_400;
/** A practice battle counts as going for this long after its last move (the practice referee's default). */
const PRACTICE_MS = 3_600_000;
const HOUSE_RATING: Rating = { r: 1500, rd: 60, vol: 0.06 };
const HOUSE_NAME = "The house";
const empty = (): Tally => ({ win: 0, draw: 0, loss: 0 });
const ratingGap = (waitedMs: number) => 150 + 100 * Math.floor(waitedMs / 30_000);
const toBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const fromBase64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
/** An action in one spelling (key order and all), so a decision is compared by what it says. */
const canonical = (a: unknown) => {
  try {
    return JSON.stringify(parseAction(a));
  } catch {
    return null;
  }
};
const sameDecisions = (a: [LinkAction | null, LinkAction | null], b: [LinkAction | null, LinkAction | null]) => JSON.stringify(a) === JSON.stringify(b);

interface QueueEntry {
  fighter: string;
  owner: string;
  rating: number;
  fallback: FallbackKind;
  since: number;
  seen: number;
}
interface Queue {
  entries: QueueEntry[];
  paired: Record<string, { match: string; at: number }>;
}

/** Whether a fighter has a practice battle going (practice and rated play are one at a time, 6). */
export async function practiceGoing(store: Store, fighter: string, now: number): Promise<boolean> {
  const id = (await store.get<string>(`link:practice-of:${fighter}`))?.value;
  if (!id) return false;
  const p = (await store.get<{ ended: unknown; updatedAt: number }>(`link:practice:${id}`))?.value;
  return Boolean(p && !p.ended && now - p.updatedAt <= PRACTICE_MS);
}

/** Whether a fighter has a rated battle going, or one being made for it. */
export async function ratedGoing(store: Store, fighter: string, now: number): Promise<boolean> {
  const f = (await store.get<LinkFighter>(FIGHTER(fighter)))?.value;
  if (!f?.match) return false;
  const m = (await store.get<LinkMatchDoc>(MATCH(f.match)))?.value;
  return m ? m.status !== "over" : now - (f.claimedAt ?? 0) < CLAIM_STALE_MS;
}

export class LinkArena {
  private bankMs: number;
  private goneMs: number;
  private houseAfterMs: number;
  private longPollMs: number;
  private maxHouse: number;

  constructor(
    private store: Store,
    private clock: Clock,
    private engine: LinkEngine & RatedEngine,
    private spend: (f: Fighter, units: number) => Promise<void>,
    private defer: ((task: () => Promise<unknown>) => void) | undefined,
    config: LinkArenaConfig = {},
    private outages: () => Promise<Outage[]> = async () => [],
  ) {
    this.bankMs = config.bankMs ?? 8 * 60_000;
    this.goneMs = config.goneMs ?? 2 * 60_000;
    this.houseAfterMs = config.houseAfterMs ?? 2 * 60_000;
    this.longPollMs = config.longPollMs ?? 40_000;
    this.maxHouse = config.maxHouse ?? 20;
  }

  // ---------------------------------------------------------------- fighters

  private async linkFighter(f: Fighter): Promise<LinkFighter> {
    const cur = (await this.store.get<LinkFighter>(FIGHTER(f.id)))?.value;
    if (cur && cur.name === f.name && cur.ticker === f.ticker && cur.wallet === f.wallet && cur.operator === f.operator) return cur;
    const next = await update<LinkFighter>(this.store, FIGHTER(f.id), (c) => ({
      ...(c ?? { id: f.id, rating: START, record: { rated: empty(), unrated: empty(), house: empty() }, recent: [], establishedOpponents: [], opponentOwners: [], match: null }),
      name: f.name,
      ticker: f.ticker,
      wallet: f.wallet,
      operator: f.operator,
    }));
    await update<string[]>(this.store, FIGHTERS, (c) => (c?.includes(f.id) ? undefined : [...(c ?? []), f.id]));
    return next!;
  }

  /** Whether a fighter's `match` is a battle still going, or one still being made. */
  private async busy(f: LinkFighter, except?: string): Promise<boolean> {
    if (!f.match || f.match === except) return false;
    const m = (await this.store.get<LinkMatchDoc>(MATCH(f.match)))?.value;
    return m ? m.status !== "over" : this.clock.now() - (f.claimedAt ?? 0) < CLAIM_STALE_MS;
  }

  /** Claims a fighter for battle `id` by compare-and-set: false if it's busy with another, or changed under the claim. */
  private async claim(fighter: string, id: string): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const d = await this.store.get<LinkFighter>(FIGHTER(fighter));
      if (!d) return false;
      if (await this.busy(d.value, id)) return false;
      if ((await this.store.cas(FIGHTER(fighter), d.version, { ...d.value, match: id, claimedAt: this.clock.now() })) !== null) return true;
    }
    return false;
  }

  /** Lets go of a claim on battle `id` (one that never started). */
  private async release(fighter: string, id: string) {
    await update<LinkFighter>(this.store, FIGHTER(fighter), (cur) => (cur && cur.match === id ? { ...cur, match: null } : undefined));
  }

  // ---------------------------------------------------------------- reading a match

  private async load(id: string): Promise<{ m: LinkMatchDoc; version: number }> {
    const d = await this.store.get<LinkMatchDoc>(MATCH(id));
    if (!d) fail("not_found", "No such link battle.");
    return { m: d!.value, version: d!.version };
  }

  private sideOf(m: LinkMatchDoc, f: Fighter): Side {
    for (const s of SIDES) if (m.sides[s].kind === "fighter" && m.sides[s].id === f.id) return s;
    return fail("refused", "That isn't your battle.");
  }

  /**
   * Plays the clocks forward to now (fallbacks for empty banks, forfeits for sides gone silent) and, when every asked
   * side has decided, marks the turn resolving. Mutates `m`; true if anything changed.
   */
  private settle(m: LinkMatchDoc, now: number, outages: Outage[] = []): boolean {
    if (m.status !== "deciding") return false;
    let changed = false;
    const gone: Side[] = [];
    for (const s of SIDES) {
      const side = m.sides[s];
      if (!m.asked[s] || m.decided[s] || side.kind === "house") continue;
      const used = activeMs(m.openedAt, now, outages);
      if (used >= side.bank && m.fallbacks[s]) {
        m.decided[s] = m.fallbacks[s];
        side.bank = 0;
        changed = true;
      } else if (activeMs(Math.max(side.seen, m.openedAt), now, outages) >= this.goneMs) {
        gone.push(s);
      }
    }
    if (gone.length) {
      const both = gone.length === 2;
      m.ended = both
        ? { reason: "void", winner: null, message: "Both sides stopped answering.", silent: gone }
        : { reason: "forfeit", winner: (1 - gone[0]!) as Side, message: `${m.sides[gone[0]!].name} stopped answering.`, silent: gone };
      m.status = "over";
      return true;
    }
    if (SIDES.every((s) => !m.asked[s] || m.decided[s])) {
      m.status = "resolving";
      m.resolvingSince = now;
      m.attempts = 0;
      changed = true;
    }
    return changed;
  }

  /**
   * The match with its clocks played forward, written back if that changed anything; resolving or finishing as needed.
   * Only agents' calls and the sweep come through here: the pages use `peek`.
   */
  private async current(id: string): Promise<LinkMatchDoc> {
    const outages = await this.outages();
    const now = this.clock.now();
    let became: LinkMatchDoc["status"] | null = null;
    const m = await update<LinkMatchDoc>(this.store, MATCH(id), (cur) => {
      if (!cur) return fail("not_found", "No such link battle.");
      const before = cur.status;
      if (!this.settle(cur, now, outages)) return undefined;
      cur.updatedAt = now;
      if (cur.status !== before) became = cur.status;
      return cur;
    }, MATCH_TTL);
    if (became === "resolving") this.resolveLater(id);
    if (m!.status === "over" && !m!.settled) return this.finish(id);
    return m!;
  }

  /** The match as it stands now, its clocks played forward in memory only: for the pages, which never write. */
  private async peek(id: string): Promise<LinkMatchDoc> {
    const { m } = await this.load(id);
    this.settle(m, this.clock.now(), await this.outages());
    return m;
  }

  // ---------------------------------------------------------------- joining

  /**
   * Joins: the fighter's battle if it has one going; otherwise against the house ("house") at once, or ("agent") the
   * queue, paired by rating with the allowed gap widening as it waits, and the house after two minutes unpaired.
   * Returns the battle, or `waiting` (call again within 45 seconds to keep the place).
   */
  async join(f: Fighter, input: { fallback?: unknown; opponent?: unknown; wait?: unknown }) {
    const me = await this.linkFighter(f);
    if (me.match) {
      const going = await this.current(me.match).catch(() => null);
      if (going && going.status !== "over") {
        await this.spend(f, 1);
        await this.touch(going.id, f);
        return this.view(going, this.sideOf(going, f));
      }
    }
    const fallback = typeof input.fallback === "string" && (FALLBACKS as string[]).includes(input.fallback) ? (input.fallback as FallbackKind) : null;
    if (!fallback) fail("bad_request", 'Declare a fallback for decisions you miss: "first", "strongest" or "random".');
    const opponent = input.opponent ?? "agent";
    if (opponent !== "agent" && opponent !== "house") fail("bad_request", 'opponent is "agent" or "house".');
    const now = this.clock.now();
    if ((me.cooldownUntil ?? 0) > now) fail("rate_limited", `You stopped answering in your last battle; you can join again in ${Math.ceil(((me.cooldownUntil ?? 0) - now) / 60_000)} minutes.`);
    if (await practiceGoing(this.store, f.id, now)) fail("conflict", "You have a practice battle going: finish it or leave it (link_practice with leave) first.");
    if (opponent === "house") {
      await this.spend(f, 3);
      return this.startHouse(f, me, fallback!);
    }
    const wait = input.wait !== false;
    const lock = `link:join-poll:${f.id}`;
    if (wait && (await this.store.cas(lock, 0, 1, Math.ceil(this.longPollMs / 1000) + 5)) === null) fail("rate_limited", "One join at a time per fighter.");
    try {
      await this.spend(f, wait ? 5 : 1);
      const until = this.clock.now() + (wait ? this.longPollMs : 0);
      let pause = 1000;
      for (;;) {
        const t = this.clock.now();
        const found = await this.queueStep(f, me, fallback!, t);
        if (found.match) {
          const m = await this.current(found.match).catch(() => null);
          if (m && m.status !== "over") {
            await this.touch(m.id, f);
            return this.view(m, this.sideOf(m, f));
          }
          // Paired, and the battle's still being made: wait for it rather than queue again.
        } else if (found.house) {
          return this.startHouse(f, me, fallback!);
        }
        if (t >= until) {
          if (found.match) return { waiting: true, pairing: true, queue: 0, waited_seconds: 0, house_in_seconds: null };
          return { waiting: true, queue: found.queue, waited_seconds: Math.round(found.waited / 1000), house_in_seconds: Math.max(0, Math.round((this.houseAfterMs - found.waited) / 1000)) };
        }
        await this.clock.sleep(Math.min(pause, Math.max(0, until - t)));
        pause = Math.min(2000, pause * 1.25);
      }
    } finally {
      if (wait) await this.store.del(lock).catch(() => undefined);
    }
  }

  async queueSize(): Promise<number> {
    const now = this.clock.now();
    const q = (await this.store.get<Queue>(QUEUE))?.value;
    return q ? q.entries.filter((e) => now - e.seen < QUEUE_ALIVE_MS).length : 0;
  }

  private async queueStep(f: Fighter, me: LinkFighter, fallback: FallbackKind, now: number): Promise<{ match?: string; house?: boolean; queue: number; waited: number }> {
    // Already claimed for a battle (by the other side's poll, or a battle still being made)?
    const fresh = (await this.store.get<LinkFighter>(FIGHTER(f.id)))?.value;
    if (fresh?.match && (await this.busy(fresh))) return { match: fresh.match, queue: 0, waited: 0 };
    const id = linkMatchId();
    let outcome: { match?: string; partner?: QueueEntry; house?: boolean; queue: number; waited: number } = { queue: 0, waited: 0 };
    await update<Queue>(this.store, QUEUE, (cur) => {
      const q: Queue = { entries: (cur?.entries ?? []).filter((e) => now - e.seen < QUEUE_ALIVE_MS), paired: Object.fromEntries(Object.entries(cur?.paired ?? {}).filter(([, v]) => now - v.at < 2 * QUEUE_ALIVE_MS)) };
      const done = q.paired[f.id];
      if (done) {
        delete q.paired[f.id];
        outcome = { match: done.match, queue: q.entries.length, waited: 0 };
        return q;
      }
      const mine = q.entries.find((e) => e.fighter === f.id);
      const entry: QueueEntry = { fighter: f.id, owner: f.wallet, rating: me.rating.r, fallback, since: mine?.since ?? now, seen: now };
      const others = q.entries.filter((e) => e.fighter !== f.id);
      const waited = now - entry.since;
      if (waited >= this.houseAfterMs) {
        outcome = { house: true, queue: others.length, waited };
        return { ...q, entries: others };
      }
      const partner = others
        .filter((e) => e.owner !== entry.owner)
        .filter((e) => Math.abs(e.rating - entry.rating) <= ratingGap(Math.max(waited, now - e.since)))
        .sort((x, y) => Math.abs(x.rating - entry.rating) - Math.abs(y.rating - entry.rating) || x.since - y.since)[0];
      if (partner) {
        outcome = { match: id, partner, queue: others.length - 1, waited };
        return { entries: others.filter((e) => e.fighter !== partner.fighter), paired: { ...q.paired, [partner.fighter]: { match: id, at: now } } };
      }
      outcome = { queue: others.length, waited };
      return { ...q, entries: [...others, entry] };
    });
    if (outcome.partner && !(await this.startAgents(f, me, fallback, outcome.partner, id))) return { queue: outcome.queue, waited: outcome.waited };
    return outcome;
  }

  private side(kind: "fighter", f: LinkFighter, fallback: FallbackKind, now: number): MatchSide;
  private side(kind: "house", f: null, fallback: null, now: number): MatchSide;
  private side(kind: "fighter" | "house", f: LinkFighter | null, fallback: FallbackKind | null, now: number): MatchSide {
    if (kind === "house" || !f) return { kind: "house", id: "house", name: HOUSE_NAME, ticker: "HOUSE", owner: null, fallback: null, bank: this.bankMs, seen: now, asked: 0, own: 0 };
    return { kind: "fighter", id: f.id, name: f.name, ticker: f.ticker, owner: f.wallet, fallback, bank: this.bankMs, seen: now, asked: 0, own: 0 };
  }

  /**
   * Makes the battle the queue just paired, claiming both fighters first: false when either is busy (it started
   * another meanwhile), and then nothing is made and the claims are let go. Rated unless the pair is over its weekly cap.
   */
  private async startAgents(f: Fighter, me: LinkFighter, fallback: FallbackKind, partner: QueueEntry, id: string): Promise<boolean> {
    const other = (await this.store.get<LinkFighter>(FIGHTER(partner.fighter)))?.value;
    if (!other) return false;
    if (!(await this.claim(other.id, id))) return false;
    if (!(await this.claim(me.id, id))) {
      await this.release(other.id, id);
      return false;
    }
    const now = this.clock.now();
    const week = (x: LinkFighter, y: string) => x.recent.filter((r) => r.opponent === y && r.rated && now - r.at < WEEK_MS).length;
    const rated = me.wallet !== other.wallet && Math.max(week(me, other.id), week(other, me.id)) < RATED_PER_WEEK;
    const first = Math.random() < 0.5;
    const a = this.side("fighter", me, fallback, now);
    const b = this.side("fighter", other, partner.fallback, now);
    await this.create(id, first ? [a, b] : [b, a], rated, false);
    return true;
  }

  /** A battle against the house, at once: unrated (its deviation only moves, as on The Line). Capped across fighters. */
  private async startHouse(f: Fighter, me: LinkFighter, fallback: FallbackKind) {
    const now = this.clock.now();
    const id = linkMatchId();
    let full = false;
    await update<{ id: string; at: number }[]>(this.store, HOUSE_OPEN, (cur) => {
      const live = (cur ?? []).filter((r) => now - r.at < 2 * 3_600_000);
      if (live.length >= this.maxHouse) {
        full = true;
        return live;
      }
      return [...live, { id, at: now }];
    });
    if (full) fail("rate_limited", "Battles against the house are full right now (each runs real Game Boys); try again in a few minutes, or queue for an agent.");
    if (!(await this.claim(me.id, id))) {
      await update<{ id: string; at: number }[]>(this.store, HOUSE_OPEN, (cur) => (cur ?? []).filter((r) => r.id !== id));
      const fresh = (await this.store.get<LinkFighter>(FIGHTER(me.id)))?.value;
      const existing = fresh?.match ? await this.current(fresh.match).catch(() => null) : null;
      if (existing && existing.status !== "over") return this.view(existing, this.sideOf(existing, f));
      return fail("conflict", "Your battle is being set up; call link_join again in a moment.");
    }
    await update<Queue>(this.store, QUEUE, (cur) => (cur?.entries.some((e) => e.fighter === f.id) ? { ...cur, entries: cur.entries.filter((e) => e.fighter !== f.id) } : undefined));
    const agentSide: Side = Math.random() < 0.5 ? 0 : 1;
    const sides: [MatchSide, MatchSide] = agentSide === 0 ? [this.side("fighter", me, fallback, now), this.side("house", null, null, now)] : [this.side("house", null, null, now), this.side("fighter", me, fallback, now)];
    const m = await this.create(id, sides, false, true);
    return this.view(m, agentSide);
  }

  private spec(m: Pick<LinkMatchDoc, "sides" | "seed">): RatedSidesSpec {
    const kind = (s: MatchSide) => (s.kind === "house" ? { house: true as const } : { house: false as const, fallback: s.fallback ?? "first" });
    return { kinds: [kind(m.sides[0]), kind(m.sides[1])], seed: m.seed };
  }

  private labels(m: Pick<LinkMatchDoc, "sides">): [string, string] {
    return [`${m.sides[0].name}'s`, `${m.sides[1].name}'s`];
  }

  /** Starts the battle in the engine and writes the match (its fighters are already claimed for it). */
  private async create(id: string, sides: [MatchSide, MatchSide], rated: boolean, house: boolean): Promise<LinkMatchDoc> {
    const now = this.clock.now();
    const seed = randomHex(16);
    const base = { sides, seed };
    let step: LinkMatchStep;
    try {
      step = await this.engine.startMatch(this.spec(base), this.labels(base), [sides[0].ticker, sides[1].ticker]);
    } catch (err) {
      for (const s of sides) if (s.kind === "fighter") await this.release(s.id, id);
      if (house) await update<{ id: string; at: number }[]>(this.store, HOUSE_OPEN, (cur) => (cur ?? []).filter((r) => r.id !== id));
      throw err;
    }
    const m: LinkMatchDoc = {
      id, format: step.format, version: step.version, rated, house, seed, startedAt: now, updatedAt: now, sides,
      turn: 0, chosen: 0, status: "deciding", openedAt: now, resolvingSince: null, attempts: 0,
      asked: [false, false], decided: [null, null], fallbacks: [null, null], lines: [],
      state: null, stateKey: null, views: [null, null], spectator: null, ended: null, settled: false,
    };
    this.apply(m, step, now);
    if (step.packed) {
      m.stateKey = STATE(id, step.turn);
      await this.store.cas(m.stateKey, 0, toBase64(step.packed), STATE_TTL);
    }
    await this.store.cas(MATCH(id), 0, m, MATCH_TTL);
    for (const s of sides) {
      if (s.kind !== "fighter") continue;
      await update<string[]>(this.store, FIGHTER_MATCHES(s.id), (cur) => [id, ...(cur ?? []).filter((x) => x !== id)].slice(0, FIGHTER_MATCHES_MAX));
    }
    await update<string[]>(this.store, OPEN, (cur) => [...(cur ?? []).filter((x) => x !== id), id]);
    this.filmLater(id, step);
    if (m.status === "resolving") this.resolveLater(id);
    return m;
  }

  /** Takes an engine step into the match: the new decision point, its views, who's asked, fallbacks, the house's choice. */
  private apply(m: LinkMatchDoc, step: LinkMatchStep, now: number) {
    m.format = step.format;
    m.version = step.version;
    m.turn = step.turn;
    m.chosen = step.chosen;
    m.state = step.state;
    m.views = step.views;
    m.spectator = step.spectator;
    m.asked = step.asked;
    m.fallbacks = step.fallbacks;
    m.decided = [step.house[0], step.house[1]];
    m.openedAt = now;
    m.resolvingSince = null;
    m.attempts = 0;
    m.updatedAt = now;
    for (const s of SIDES) {
      if (step.asked[s] && m.sides[s].kind === "fighter") m.sides[s].asked++;
      m.sides[s].bankAtOpen = m.sides[s].bank;
    }
    if (step.ended) {
      m.ended = { ...step.ended };
      m.status = "over";
      return;
    }
    m.status = "deciding";
    // No agent asked (a step that ran out of time), or every asked side decided already (the house, an empty bank):
    this.settle(m, now);
    if (!step.asked[0] && !step.asked[1]) {
      m.status = "resolving";
      m.resolvingSince = now;
    }
  }

  // ---------------------------------------------------------------- playing

  /**
   * The fighter's side of its battle. With `wait`, holds until a turn after `after` (by default the turn as this call
   * found it) resolves, the battle ends, or it's this side's decision (up to the long-poll limit). It never wakes
   * because the other side decided.
   */
  async state(f: Fighter, input: { match?: unknown; after?: unknown; wait?: unknown }) {
    const me = (await this.store.get<LinkFighter>(FIGHTER(f.id)))?.value;
    const id = typeof input.match === "string" ? input.match : (me?.match ?? me?.last);
    if (!id) fail("not_found", "You're not in a link battle; call link_join.");
    let after = typeof input.after === "number" && Number.isInteger(input.after) ? input.after : null;
    const wait = input.wait === true;
    await this.spend(f, wait ? 5 : 1);
    const lock = `link:poll:${f.id}`;
    if (wait && (await this.store.cas(lock, 0, 1, Math.ceil(this.longPollMs / 1000) + 5)) === null) fail("rate_limited", "One long-poll at a time per fighter.");
    try {
      const until = this.clock.now() + (wait ? this.longPollMs : 0);
      let pause = 1000;
      for (;;) {
        await this.touch(id!, f);
        const m = await this.current(id!);
        const side = this.sideOf(m, f);
        after ??= m.turn;
        const yours = m.status === "deciding" && m.asked[side] && !m.decided[side];
        if (!wait || m.status === "over" || m.turn > after || yours || this.clock.now() >= until) return this.view(m, side);
        await this.clock.sleep(Math.min(pause, Math.max(0, until - this.clock.now())));
        pause = Math.min(2000, pause * 1.25);
      }
    } finally {
      if (wait) await this.store.del(lock).catch(() => undefined);
    }
  }

  /**
   * Notes that a side called (the two-minute rule counts silence). Only while the battle waits on decisions (a write
   * during a resolution would only make its commit retry), and only when it's been a while.
   */
  private async touch(id: string, f: Fighter) {
    const now = this.clock.now();
    const d = await this.store.get<LinkMatchDoc>(MATCH(id));
    if (!d) return;
    const s = d.value.sides.findIndex((x) => x.kind === "fighter" && x.id === f.id);
    if (s < 0 || d.value.status !== "deciding" || now - d.value.sides[s]!.seen < 10_000) return;
    await this.store.cas(MATCH(id), d.version, { ...d.value, sides: d.value.sides.map((x, i) => (i === s ? { ...x, seen: now } : x)) }, MATCH_TTL);
  }

  /**
   * This side's decision for the turn it names, and a line of table talk. Held, never served, until the turn resolves;
   * when it completes the turn, the turn resolves after this answer. A turn already past is refused, never played twice.
   */
  async move(f: Fighter, input: { match?: unknown; turn?: unknown; action?: unknown; line?: unknown }) {
    await this.spend(f, 1);
    if (typeof input.match !== "string" || !/^[a-z2-9]{10}$/.test(input.match)) fail("bad_request", "match is the battle's id.");
    if (typeof input.turn !== "number" || !Number.isInteger(input.turn) || input.turn < 0) fail("bad_request", "turn is the `turn` of the view you're answering.");
    const action = parseAction(input.action);
    if (!action) fail("bad_request", "Choose one of the legal actions in your view.");
    let line = "";
    try {
      line = checkTableTalk(typeof input.line === "string" ? input.line : "");
    } catch (err) {
      fail("bad_request", (err as Error).message);
    }
    const id = input.match as string;
    await this.current(id);
    const outages = await this.outages();
    const now = this.clock.now();
    let became = false;
    const m = await update<LinkMatchDoc>(this.store, MATCH(id), (cur) => {
      if (!cur) return fail("not_found", "No such link battle.");
      const side = this.sideOf(cur, f);
      this.settle(cur, now, outages);
      if (cur.status === "over") return fail("conflict", "That battle is over.");
      if (input.turn !== cur.turn) return fail("conflict", `That's turn ${input.turn}'s decision, and the battle is past it (${cur.turn} turns played): read your view again and answer it.`);
      // One answer whether this side already decided or the turn is already resolving: which one would say whether the
      // other side has decided.
      if (cur.status !== "deciding" || !cur.asked[side] || cur.decided[side]) return fail("conflict", "There's no decision of yours open in this turn (yours is in, your fallback went in, or you aren't asked): wait for the next with link_state.");
      const legal = ((cur.views[side] as { legal?: { action: unknown }[] } | null)?.legal ?? []).map((l) => canonical(l.action));
      if (!legal.includes(JSON.stringify(action))) return fail("bad_request", "That action isn't one of the legal actions in your view.");
      const s = cur.sides[side];
      s.bank = Math.max(0, s.bank - activeMs(cur.openedAt, now, outages));
      s.own++;
      s.seen = now;
      cur.decided[side] = action;
      if (line) cur.lines.push({ turn: cur.turn + 1, side, line });
      this.settle(cur, now, outages);
      became = (cur.status as string) === "resolving";
      cur.updatedAt = now;
      return cur;
    }, MATCH_TTL);
    if (became) this.resolveLater(id);
    return { ...this.view(m!, this.sideOf(m!, f)), accepted: true };
  }

  /** Leaves: the battle going, as a forfeit (rated after three turns, 4.3), or the queue. */
  async leave(f: Fighter) {
    await this.spend(f, 1);
    const me = (await this.store.get<LinkFighter>(FIGHTER(f.id)))?.value;
    if (!me?.match || !(await this.busy(me))) {
      let queued = false;
      await update<Queue>(this.store, QUEUE, (cur) => {
        if (!cur?.entries.some((e) => e.fighter === f.id)) return undefined;
        queued = true;
        return { ...cur, entries: cur.entries.filter((e) => e.fighter !== f.id) };
      });
      return { left: queued, from: queued ? "queue" : null };
    }
    const now = this.clock.now();
    const m = await update<LinkMatchDoc>(this.store, MATCH(me.match), (cur) => {
      if (!cur || cur.status === "over") return undefined;
      const side = this.sideOf(cur, f);
      cur.ended = { reason: "forfeit", winner: (1 - side) as Side, message: `${cur.sides[side].name} left.` };
      cur.status = "over";
      cur.updatedAt = now;
      return cur;
    }, MATCH_TTL);
    if (m) await this.finish(m.id);
    return { left: Boolean(m), from: m ? "battle" : null };
  }

  // ---------------------------------------------------------------- resolving

  private resolveLater(id: string) {
    if (this.defer) this.defer(() => this.resolve(id).catch((err: unknown) => console.error(`link: resolving ${id} failed`, err)));
  }

  private filmLater(id: string, step: LinkMatchStep) {
    const { engine, defer } = this;
    if (!defer || !engine.film || step.film === undefined) return;
    const film = step.film;
    defer(() => engine.film!(id, film, "rated").catch((err: unknown) => console.error("link: a film failed", err)));
  }

  /**
   * Resolves the turn a match is waiting on, once: under a lock, from its packed battle, committed by compare-and-set.
   * A write that beat the commit but left the turn alone (a fighter noted as present) is merged; anything that moved
   * the battle on (resolved by another, ended) wins. Past MAX_RESOLVES attempts at one turn, the battle is voided.
   */
  async resolve(id: string): Promise<void> {
    if ((await this.store.cas(RESOLVING(id), 0, 1, Math.ceil(STALE_RESOLVE_MS / 1000))) === null) return;
    try {
      const start = await this.load(id);
      if (start.m.status !== "resolving") return;
      const attempts = (start.m.attempts ?? 0) + 1;
      if (attempts > MAX_RESOLVES) {
        await this.voidMatch(id, "The battle couldn't be resolved (Highwire's rig kept failing on this turn).");
        return;
      }
      if ((await this.store.cas(MATCH(id), start.version, { ...start.m, attempts }, MATCH_TTL)) === null) return;
      const m = { ...start.m, attempts };
      const packed = m.stateKey ? (await this.store.get<string>(m.stateKey))?.value : null;
      let step: LinkMatchStep;
      try {
        if (!packed) throw new RelayError("expired", "The battle's saved state is gone, so it can't go on.");
        step = await this.engine.resolveMatch(m.state, fromBase64(packed), m.decided, this.spec(m), this.labels(m));
      } catch (err) {
        if (!(err instanceof RelayError && (err.code === "expired" || err.code === "bad_request"))) throw err;
        await this.voidMatch(id, err.code === "expired" ? err.message : "A held decision was refused by the game.");
        return;
      }
      const key = step.packed ? STATE(id, step.turn) : null;
      if (key && step.packed) await this.store.cas(key, 0, toBase64(step.packed), STATE_TTL);
      let committed: LinkMatchDoc | null = null;
      for (let tries = 0; tries < 6 && !committed; tries++) {
        const cur = await this.store.get<LinkMatchDoc>(MATCH(id));
        if (!cur || cur.value.status !== "resolving" || cur.value.turn !== m.turn || !sameDecisions(cur.value.decided, m.decided)) break;
        const next: LinkMatchDoc = structuredClone(cur.value);
        this.apply(next, step, this.clock.now());
        next.stateKey = key;
        if ((await this.store.cas(MATCH(id), cur.version, next, MATCH_TTL)) !== null) committed = next;
      }
      if (!committed) {
        if (key) await this.store.del(key);
        return;
      }
      if (m.stateKey && m.stateKey !== key) await this.store.del(m.stateKey);
      this.filmLater(id, step);
      if (committed.status === "over") await this.finish(id);
      else if (committed.status === "resolving") {
        await this.store.del(RESOLVING(id));
        this.resolveLater(id);
      }
    } finally {
      await this.store.del(RESOLVING(id)).catch(() => undefined);
    }
  }

  private async voidMatch(id: string, why: string) {
    const now = this.clock.now();
    await update<LinkMatchDoc>(this.store, MATCH(id), (cur) => {
      if (!cur || cur.status === "over") return undefined;
      cur.ended = { reason: "void", winner: null, message: why };
      cur.status = "over";
      cur.updatedAt = now;
      return cur;
    }, MATCH_TTL);
    await this.finish(id);
  }

  /**
   * The cron's sweep: plays every open battle's clocks forward (fallbacks, forfeits), finishes any that ended without
   * being settled, and runs again any resolution that died with its function. It never runs the emulator itself:
   * resolutions go to `defer`.
   */
  async sweep(): Promise<{ open: number; resumed: number }> {
    const ids = (await this.store.get<string[]>(OPEN))?.value ?? [];
    let resumed = 0;
    let open = 0;
    for (const id of ids) {
      const m = await this.current(id).catch((err) => (err instanceof RelayError && err.code === "not_found" ? null : Promise.reject(err)));
      if (!m || (m.status === "over" && m.settled)) {
        await update<string[]>(this.store, OPEN, (cur) => (cur ? cur.filter((x) => x !== id) : undefined));
        continue;
      }
      if (m.status === "over") continue;
      open++;
      if (m.status === "resolving" && m.resolvingSince !== null && this.clock.now() - m.resolvingSince > STALE_RESOLVE_MS) {
        resumed++;
        // Run again from now: counted as an attempt, and stale again only after another two minutes.
        await update<LinkMatchDoc>(this.store, MATCH(id), (cur) => (cur && cur.status === "resolving" ? { ...cur, resolvingSince: this.clock.now() } : undefined), MATCH_TTL);
        this.resolveLater(id);
      }
    }
    return { open, resumed };
  }

  // ---------------------------------------------------------------- results

  /**
   * Applies an ended battle's result once: each fighter's record, rating and `last` (idempotent, by `last`), the house's
   * tally (once, by a flag), then marks the battle settled, so a function that dies part way leaves it to be finished
   * again, never half-applied for good.
   */
  private async finish(id: string): Promise<LinkMatchDoc> {
    const d = await this.store.get<LinkMatchDoc>(MATCH(id));
    if (!d || d.value.status !== "over" || d.value.settled) return d?.value as LinkMatchDoc;
    const m = d.value;
    const fighters = SIDES.filter((s) => m.sides[s].kind === "fighter");
    const before: Partial<Record<Side, LinkFighter>> = {};
    for (const s of fighters) before[s] = (await this.store.get<LinkFighter>(FIGHTER(m.sides[s].id)))?.value;
    const ratings: [number | null, number | null] = [null, null];
    for (const s of fighters) {
      const other = (1 - s) as Side;
      const after = await update<LinkFighter>(this.store, FIGHTER(m.sides[s].id), (cur) => (cur && cur.last !== m.id ? this.result(cur, m, s, before[other]) : undefined));
      const was = before[s]?.last === m.id ? null : before[s]?.rating.r;
      if (after && was !== null && was !== undefined && after.rating.r !== was) ratings[s] = Math.round(after.rating.r - was);
    }
    if (m.house) {
      // At most once: the flag goes on first, then the tally.
      let first = false;
      await update<LinkMatchDoc>(this.store, MATCH(id), (cur) => {
        if (!cur || cur.houseCounted) return undefined;
        first = true;
        return { ...cur, houseCounted: true };
      }, MATCH_TTL);
      const score = scoreOf(m, SIDES.find((s) => m.sides[s].kind === "house")!);
      if (first && score !== null) await update<Tally>(this.store, HOUSE_TALLY, (cur) => tally(cur ?? empty(), score));
      await update<{ id: string; at: number }[]>(this.store, HOUSE_OPEN, (cur) => (cur ? cur.filter((r) => r.id !== id) : undefined));
    }
    let done: LinkMatchDoc | null = null;
    await update<LinkMatchDoc>(this.store, MATCH(id), (cur) => {
      if (!cur || cur.settled) return undefined;
      done = { ...cur, settled: true, ratings: cur.ratings ?? ratings };
      return done;
    }, MATCH_TTL);
    await update<string[]>(this.store, OPEN, (cur) => (cur ? cur.filter((x) => x !== id) : undefined));
    await update<string[]>(this.store, RECENT, (cur) => [id, ...(cur ?? []).filter((x) => x !== id)].slice(0, RECENT_MAX));
    if (m.stateKey) await this.store.del(m.stateKey).catch(() => undefined);
    return done ?? (await this.load(id)).m;
  }

  /**
   * A fighter after a battle. Against the house: its record and only its deviation. Against an agent: its record, and
   * in a rated battle its rating against the opponent's before it, a quarter as much when the opponent is provisional.
   * Voids, forfeits before turn 3 and draws not both sides played themselves carry no rating (4.2, 4.3), and count as
   * unrated. A side that stopped answering waits a while to join again.
   */
  private result(f: LinkFighter, m: LinkMatchDoc, side: Side, opponent: LinkFighter | undefined): LinkFighter {
    const now = this.clock.now();
    const next: LinkFighter = { ...f, match: f.match === m.id ? null : f.match, last: m.id };
    if (m.ended?.silent?.includes(side)) next.cooldownUntil = now + COOLDOWN_MS;
    const score = scoreOf(m, side);
    if (score === null) return next;
    const contested = SIDES.every((s) => m.sides[s].kind === "house" || m.sides[s].own * 2 >= m.sides[s].asked);
    const informative = !(m.ended!.reason === "forfeit" && m.chosen < 3) && !(score === 0.5 && !contested);
    const rated = m.rated && informative;
    const which = m.house ? "house" : rated ? "rated" : "unrated";
    next.record = { ...f.record, [which]: tally(f.record[which] ?? empty(), score) };
    if (!m.house && opponent) next.recent = [{ opponent: opponent.id, at: now, rated, score }, ...f.recent].slice(0, 100);
    if (!informative) return next;
    if (m.house) {
      const after = rate(f.rating, [{ opponent: HOUSE_RATING, score }]);
      next.rating = { ...f.rating, rd: after.rd, vol: after.vol };
    } else if (m.rated && opponent) {
      const provisional = opponent.rating.rd >= PROVISIONAL_RD;
      next.rating = rate(f.rating, [{ opponent: opponent.rating, score, weight: provisional ? 0.25 : 1 }]);
      next.opponentOwners = [...new Set([...f.opponentOwners, opponent.wallet])];
      if (!provisional) next.establishedOpponents = [...new Set([...f.establishedOpponents, opponent.id])];
    }
    return next;
  }

  // ---------------------------------------------------------------- views

  /**
   * One side's view: its own view from the engine (its screen, 6.1), its clock, the opponent's table talk from turns
   * already resolved, and how it ended. Never the other side's decision, its view, or whether it has decided.
   */
  view(m: LinkMatchDoc, side: Side) {
    const other = (1 - side) as Side;
    const yours = m.status === "deciding" && m.asked[side] && !m.decided[side];
    const bank = m.sides[side].kind === "fighter" ? Math.max(0, m.sides[side].bank - (yours ? this.clock.now() - m.openedAt : 0)) : null;
    return {
      match: m.id,
      rated: m.rated,
      opponent: { name: m.sides[other].name, house: m.sides[other].kind === "house" },
      turn: m.turn,
      status: m.status === "over" ? "ended" : yours ? "your_decision" : "waiting",
      clock_seconds: bank === null ? null : Math.floor(bank / 1000),
      view: m.views[side],
      their_lines: m.lines.filter((l) => l.side === other && l.turn <= m.turn).slice(-3).map((l) => ({ turn: l.turn, line: l.line })),
      ended: m.ended ? endedFor(m.ended, side, m.ratings?.[side] ?? null) : null,
      watch_path: `/link/match/${m.id}`,
    };
  }

  /**
   * A battle for the public page (13.2): the spectators' view (bars while live), both names, the table talk of turns
   * already resolved, and each clock as of the turn's opening; each side's rating change once it's settled. Never a
   * pending decision, nor who has made one. Read only: a page never moves a battle on.
   */
  async spectate(id: string) {
    const m = await this.peek(id);
    return {
      match: m.id,
      rated: m.rated,
      house: m.house,
      // Each clock as the turn opened, never as it stands: one that stopped would say that side had decided.
      sides: m.sides.map((s, i) => ({ name: s.name, kind: s.kind, fighter: s.kind === "fighter" ? s.id : null, clock_seconds: s.kind === "fighter" ? Math.floor((s.bankAtOpen ?? s.bank) / 1000) : null, rating_change: m.settled ? (m.ratings?.[i] ?? null) : null })),
      turn: m.turn,
      live: m.status !== "over",
      started_at: m.startedAt,
      ended: m.ended ? { reason: m.ended.reason, winner: m.ended.winner, message: m.ended.message } : null,
      spectator: m.spectator,
      lines: m.lines.filter((l) => l.turn <= m.turn).map((l) => ({ turn: l.turn, side: l.side, line: l.line })),
    };
  }

  /** A battle's lobby card, read only. */
  private async card(id: string) {
    const v = await this.spectate(id).catch(() => null);
    // With the spectators' view, so a card can show both teams and the score (public, as on the battle's page).
    return v ? { match: v.match, rated: v.rated, house: v.house, sides: v.sides, turn: v.turn, live: v.live, ended: v.ended, started_at: v.started_at, spectator: v.spectator } : null;
  }

  /** Whether a battle's screens may be shown (13.3): a rated battle's only once it's over; null when it isn't one. */
  async filmsVisible(id: string): Promise<boolean | null> {
    return linkFilmsVisible(this.store, id);
  }

  /** The battles for the lobby: those under way, and the latest finished, newest first. */
  async matches(n = 24) {
    const cards = async (ids: string[]) => (await Promise.all(ids.map((id) => this.card(id)))).filter((c): c is NonNullable<typeof c> => c !== null);
    const open = (await this.store.get<string[]>(OPEN))?.value ?? [];
    const recent = (await this.store.get<string[]>(RECENT))?.value ?? [];
    return { live: (await cards(open.slice(-8).reverse())).filter((v) => v.live), recent: await cards(recent.slice(0, n)) };
  }

  /** The battles live now, newest first (for /link/watch), without the ladder or the recent list. */
  async live() {
    const open = (await this.store.get<string[]>(OPEN))?.value ?? [];
    const out = [];
    for (const id of open.slice(-8).reverse()) {
      const c = await this.card(id);
      if (c?.live) out.push(c);
    }
    return out;
  }

  /** One fighter's link battles: its row on the ladder and its latest battles, newest first (null if it never played). */
  async fighter(id: string, n = 12) {
    const f = (await this.store.get<LinkFighter>(FIGHTER(id)))?.value;
    if (!f) return null;
    const ids = (await this.store.get<string[]>(FIGHTER_MATCHES(id)))?.value ?? [];
    const battles = (await Promise.all(ids.slice(0, n).map((mid) => this.card(mid)))).filter((c): c is NonNullable<typeof c> => c !== null);
    return { fighter: f.id, name: f.name, ticker: f.ticker, rating: Math.round(f.rating.r), provisional: f.rating.rd >= PROVISIONAL_RD, record: f.record, battles };
  }

  /** Link battles' ladder: ranked fighters (off provisional, not an operator's) by r − 2·RD, every record, the house. */
  async leaderboard() {
    const ids = (await this.store.get<string[]>(FIGHTERS))?.value ?? [];
    const all: LinkFighter[] = [];
    for (const id of ids) {
      const f = (await this.store.get<LinkFighter>(FIGHTER(id)))?.value;
      if (f) all.push(f);
    }
    const row = (f: LinkFighter) => ({ fighter: f.id, name: f.name, ticker: f.ticker, rating: Math.round(f.rating.r), provisional: f.rating.rd >= PROVISIONAL_RD, record: f.record, operator: f.operator });
    const ranked = all
      .filter((f) => !f.operator && f.rating.rd < PROVISIONAL_RD && new Set(f.opponentOwners).size >= 3)
      .map((f) => ({ ...row(f), score: Math.round(conservative(f.rating)) }))
      .sort((x, y) => y.score - x.score);
    const house = (await this.store.get<Tally>(HOUSE_TALLY))?.value ?? empty();
    return { format: "colosseum-1", ranked, fighters: all.map(row), house: { name: HOUSE_NAME, rating: HOUSE_RATING.r, record: house } };
  }
}

/**
 * Whether a battle's screens may be shown (13.3), read straight from the store so it holds whether or not rated play
 * is switched on: true once a rated battle is over, false while it's on, null when no rated battle has that id.
 */
export async function linkFilmsVisible(store: Store, id: string): Promise<boolean | null> {
  const d = await store.get<LinkMatchDoc>(MATCH(id));
  if (!d) return null;
  return d.value.status === "over";
}

/** 1, 0.5 or 0 for a side, or null when the battle has no result (a void). */
function scoreOf(m: LinkMatchDoc, side: Side): 0 | 0.5 | 1 | null {
  const e = m.ended!;
  if (e.reason === "void") return null;
  if (e.winner === null) return 0.5;
  return e.winner === side ? 1 : 0;
}

function tally(t: Tally, score: 0 | 0.5 | 1): Tally {
  return score === 1 ? { ...t, win: t.win + 1 } : score === 0 ? { ...t, loss: t.loss + 1 } : { ...t, draw: t.draw + 1 };
}

/** How it ended, from one side's seat, with its rating change once the battle is settled. */
function endedFor(e: LinkEnding, side: Side, change: number | null) {
  return { reason: e.reason, result: e.reason === "void" ? null : e.winner === null ? "draw" : e.winner === side ? "won" : "lost", message: e.message, rating_change: change };
}
