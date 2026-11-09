import {
  checkTableTalk,
  conservative,
  DUELS_1,
  parseFallback,
  PROVISIONAL_RD,
  rate,
  START,
  type ArenaRules,
  type HouseBot,
  type Rating,
  type Side,
} from "highwire-core/arena";
import type { Clock } from "../clock.ts";
import { fail, RelayError } from "../errors.ts";
import { randomHex, sha256Hex, sameHex, TOKEN_SECONDS, type Verified } from "../registration.ts";
import { update, type Store } from "../store.ts";
import { applyMove, contested, forfeitMatch, newAgentMatch, newHouseMatch, settle } from "./match.ts";
import type { CoinStanding, Fighter, Match, Outage, Tally } from "./types.ts";
import { viewFighter, viewMatch, type FighterView, type MatchView } from "./view.ts";

// The arena's referee (docs/arena.md 6 to 8): fighters and their tokens, matches against the house, moves, long-polls
// that wake only on reveals, the lazy clock and its sweep, outages that stop clocks, results and the leaderboard.
// Phase 2 pairs every fighter with the house; matchmaking between agents is phase 3.

/** What the referee needs to know about a coin, read from higher.fun's API and the chain by the deployment. */
export interface CoinFacts {
  name: string;
  ticker: string;
  createdAt: number;
  holders: number;
  volumeSol: number;
  /** evaluateRisk's verdict carries a rug flag. */
  rugFlag: boolean;
  /** Its creator wallet still holds some of the coin. */
  creatorHolds: boolean;
  /** The wallet recorded as the coin's creator. */
  creator: string;
}

export interface CoinDirectory {
  coin(mint: string): Promise<CoinFacts | null>;
}

export interface RefereeConfig {
  rules?: ArenaRules;
  /** Wallets whose coins play but are never ranked: the maintainer's and Highwire's. */
  operatorWallets?: string[];
  /** The house's frozen ratings. */
  houseRatings?: Record<HouseBot, Rating>;
  /** Rate-limit units per fighter per minute (a move 1, a long-poll 5). */
  unitsPerMinute?: number;
  /** How long a long-poll waits for the next reveal, in ms. Under the MCP SDK's 60-second default. */
  longPollMs?: number;
  /** How long the house takes over each round, in ms, so a match against it can be watched (default 0: at once). */
  housePaceMs?: number;
}

const HOUSE_RATINGS: Record<HouseBot, Rating> = {
  even: { r: 1500, rd: 60, vol: 0.06 },
  reader: { r: 1500, rd: 60, vol: 0.06 },
};

const FIGHTERS = "arena:fighters";
const OPEN = "arena:open";
/** The latest finished matches, newest first, for the pages. */
const RECENT = "arena:recent";
const RECENT_MAX = 60;
/** A fighter's matches, newest first. */
const fighterMatches = (id: string) => `arena:fighter-matches:${id}`;
const FIGHTER_MATCHES_MAX = 50;
const QUEUE = "arena:queue";
const FLAGS = "arena:flags";
/** A queue entry lives while its long-poll is open and this long after it returns. */
const QUEUE_ALIVE_MS = 60_000;
/** Unpaired this long, a fighter plays the house instead. */
const HOUSE_AFTER_MS = 120_000;
/** Rated matches a week between the same two fighters. */
const RATED_PER_WEEK = 3;
const WEEK_MS = 7 * 86_400_000;

interface QueueEntry {
  fighter: string;
  /** The owner: the wallet that registered it. Two fighters with one owner are never paired. */
  owner: string;
  rating: number;
  fallback: string;
  since: number;
  seen: number;
}

interface Queue {
  entries: QueueEntry[];
  /** Pairings just made, so the partner's own poll finds its match even before its fighter record says so. */
  paired: Record<string, { match: string; at: number }>;
}

/** The rating gap a pairing allows: 150, widening by 100 every 30 seconds of waiting. */
const ratingGap = (waitedMs: number) => 150 + 100 * Math.floor(waitedMs / 30_000);

export type JoinResult = MatchView | { waiting: true; queue: number; waitedSeconds: number; houseInSeconds: number };
const OK = "arena:ok";
const OUTAGES = "arena:outages";
/** A gap this long between the referee's touches of the store, while the sweep runs each minute, was an outage. */
const OUTAGE_GAP_MS = 90_000;
const HOUSE_NAME = /\b(?:even|reader)\b|highwire/i;
const empty = (): Tally => ({ win: 0, draw: 0, loss: 0 });

export class Referee {
  readonly rules: ArenaRules;
  private operators: Set<string>;
  private house: Record<HouseBot, Rating>;
  private units: number;
  private longPollMs: number;
  private housePaceMs: number;

  constructor(
    private store: Store,
    private clock: Clock,
    private coins: CoinDirectory,
    config: RefereeConfig = {},
  ) {
    this.rules = config.rules ?? DUELS_1;
    this.operators = new Set(config.operatorWallets ?? []);
    this.house = config.houseRatings ?? HOUSE_RATINGS;
    this.units = config.unitsPerMinute ?? 120;
    this.longPollMs = config.longPollMs ?? 40_000;
    this.housePaceMs = config.housePaceMs ?? 0;
  }

  // ---------------------------------------------------------------- outages

  /**
   * Notes that the store answered now. A long gap since the last note, while the sweep should have been touching it
   * every minute, was an outage: it's recorded so no clock counts it.
   */
  private async outages(): Promise<Outage[]> {
    const now = this.clock.now();
    const ok = await this.store.get<{ at: number }>(OK);
    let list = (await this.store.get<Outage[]>(OUTAGES))?.value ?? [];
    if (ok && now - ok.value.at > OUTAGE_GAP_MS) {
      list = await update<Outage[]>(this.store, OUTAGES, (cur) => [...(cur ?? []).filter((o) => o.to > now - 86_400_000), { from: ok.value.at, to: now }].slice(-50)) ?? [];
    }
    if (!ok || now - ok.value.at > 30_000) await this.store.cas(OK, ok?.version ?? 0, { at: now });
    return list;
  }

  // ---------------------------------------------------------------- fighters

  /** Registers (or re-registers) the coin a verified wallet launched. Returns the arena token, once. */
  async enroll(v: Verified): Promise<{ token: string; fighter: FighterView }> {
    const facts = await this.coinFacts(v.mint);
    if (!facts) fail("not_found", "higher.fun doesn't know that coin.");
    if (HOUSE_NAME.test(facts!.name) || HOUSE_NAME.test(facts!.ticker)) fail("refused", "Fighter names can't contain \"Highwire\" or a house fighter's name.");
    const token = randomHex();
    const tokenHash = sha256Hex(token);
    const now = this.clock.now();
    let old: string | null = null;
    const f = await update<Fighter>(this.store, `arena:fighter:${v.mint}`, (cur) => {
      old = cur?.tokenHash ?? null;
      return {
        ...(cur ?? {
          id: v.mint,
          registeredAt: now,
          rating: START,
          record: { rated: empty(), house: empty() },
          establishedOpponents: [],
          opponentOwners: [],
          recent: [],
          match: null,
        }),
        wallet: v.wallet,
        name: facts!.name,
        ticker: facts!.ticker,
        operator: this.operators.has(v.wallet) || this.operators.has(facts!.creator),
        tokenHash,
        standing: this.standing(facts!, now),
      };
    });
    // Registering again replaces the token at once, so an owner can always take a fighter back.
    if (old) await this.store.del(`arena:token:${old}`);
    await this.store.cas(`arena:token:${tokenHash}`, 0, { fighter: v.mint, renewedAt: now }, TOKEN_SECONDS);
    await update<string[]>(this.store, FIGHTERS, (cur) => (cur?.includes(v.mint) ? undefined : [...(cur ?? []), v.mint]));
    return { token, fighter: viewFighter(f!, PROVISIONAL_RD) };
  }

  /** The fighter a token belongs to, renewing the token at most once a day. */
  async authenticate(token: string | null): Promise<Fighter> {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) fail("unauthorized", "Send the token from registration (the local server does this for you).");
    const hash = sha256Hex(token!);
    const t = await this.store.get<{ fighter: string; renewedAt: number }>(`arena:token:${hash}`);
    if (!t) fail("unauthorized", "That token isn't valid (it expired, or the coin was registered again). Register again.");
    const f = await this.store.get<Fighter>(`arena:fighter:${t!.value.fighter}`);
    if (!f || !sameHex(f.value.tokenHash, hash)) fail("unauthorized", "That token was replaced by a newer registration.");
    const now = this.clock.now();
    if (now - t!.value.renewedAt > 86_400_000) await this.store.cas(`arena:token:${hash}`, t!.version, { fighter: t!.value.fighter, renewedAt: now }, TOKEN_SECONDS);
    return f!.value;
  }

  /** Spends rate-limit units; refuses past the per-minute allowance. */
  async spend(f: Fighter, units: number): Promise<void> {
    const minute = Math.floor(this.clock.now() / 60_000);
    const used = await this.store.incr(`arena:rl:${f.id}:${minute}`, units, 120);
    if (used > this.units) fail("rate_limited", "Too many arena calls this minute; slow down. A long-poll counts as 5.");
  }

  private async coinFacts(mint: string): Promise<CoinFacts | null> {
    try {
      return await this.coins.coin(mint);
    } catch {
      return fail("paused", "higher.fun's API isn't answering; try again shortly.");
    }
  }

  /**
   * Every coin launched with Highwire's tools plays and is rated from its first match: there's no age, holder or volume
   * gate, so launching a coin to play is encouraged (the launch fee is the cost of a fighter). The checks decide only
   * whether the page may link to the coin.
   */
  private standing(c: CoinFacts, now: number): CoinStanding {
    const why: string[] = [];
    if (c.rugFlag) why.push("the coin's risk check carries a rug flag");
    if (!c.creatorHolds) why.push("the coin's creator no longer holds any");
    return { checkedAt: now, ratedOk: true, listedOk: !c.rugFlag && c.creatorHolds, why };
  }

  // ---------------------------------------------------------------- matches

  private async load(id: string): Promise<Match> {
    const m = await this.store.get<Match>(`arena:match:${id}`);
    if (!m) fail("not_found", "No such match.");
    return m!.value;
  }

  /** Loads a match with its clock played forward to now, writing it back if that changed anything. */
  private async current(id: string, outages: Outage[]): Promise<Match> {
    const now = this.clock.now();
    let ended = false;
    const m = await update<Match>(this.store, `arena:match:${id}`, (cur) => {
      if (!cur) return fail("not_found", "No such match.");
      if (!settle(cur, now, outages)) return undefined;
      ended = Boolean(cur.ending);
      return cur;
    });
    if (ended || (m!.ending && !m!.settled)) return this.finish(m!.id);
    return m!;
  }

  private sideOf(m: Match, f: Fighter): Side {
    if (m.sides.a.kind === "fighter" && m.sides.a.id === f.id) return "a";
    if (m.sides.b.kind === "fighter" && m.sides.b.id === f.id) return "b";
    return fail("refused", "That isn't your match.");
  }

  /**
   * Joins. The fighter's current match if it has one. Otherwise, against the house ("reader", the default, or "even")
   * at once, or with "agent", against another agent: the fighter queues and this waits (up to the long-poll limit) to be paired by
   * rating, the allowed gap widening with the wait; after two minutes unpaired, the house plays instead. If it returns
   * "waiting", call again within a minute to keep the place.
   */
  async join(f: Fighter, input: { fallback?: unknown; opponent?: unknown; wait?: unknown }): Promise<JoinResult> {
    const outages = await this.outages();
    if (f.match) {
      const m = await this.current(f.match, outages);
      if (!m.ending) {
        await this.spend(f, 1);
        return viewMatch(m, this.sideOf(m, f), outages);
      }
    }
    const fallback = parseFallback(typeof input.fallback === "string" ? input.fallback : "");
    if (!fallback) fail("bad_request", 'Declare a fallback for rounds you miss: "zero", "mirror" or "steady:<n>".');
    // Without one named, the house: 0.14.0's tool names none and can't read "waiting". Newer tools ask for "agent".
    const opponent = input.opponent ?? "reader";
    if (opponent !== "agent" && opponent !== "reader" && opponent !== "even") fail("bad_request", 'opponent is "agent", "reader" or "even".');
    if (opponent !== "agent") {
      await this.spend(f, 1);
      return this.startHouse(f, fallback!, opponent as HouseBot, outages);
    }

    const wait = input.wait !== false;
    await this.spend(f, wait ? 5 : 1);
    const lock = `arena:join-poll:${f.id}`;
    if (wait && (await this.store.cas(lock, 0, 1, Math.ceil(this.longPollMs / 1000) + 5)) === null) fail("rate_limited", "One join at a time per fighter.");
    try {
      const until = this.clock.now() + (wait ? this.longPollMs : 0);
      let pause = 1000;
      for (;;) {
        const now = this.clock.now();
        const found = await this.queueStep(f, input.fallback as string, now);
        if (found.match) {
          // A pairing note can outlive its match (the fighter found the match through its own record first): only a
          // match still being played counts.
          const m = await this.current(found.match, outages).catch(() => null);
          if (m && !m.ending) return viewMatch(m, this.sideOf(m, f), outages);
          continue;
        }
        if (found.house) return this.startHouse(f, fallback!, "reader", outages);
        if (now >= until) return { waiting: true, queue: found.queue, waitedSeconds: Math.round(found.waited / 1000), houseInSeconds: Math.max(0, Math.round((HOUSE_AFTER_MS - found.waited) / 1000)) };
        await this.clock.sleep(Math.min(pause, Math.max(0, until - now)));
        pause = Math.min(2000, pause * 1.25);
      }
    } finally {
      if (wait) await this.store.del(lock).catch(() => undefined);
    }
  }

  /** How many fighters are waiting for an opponent. */
  async queueSize(): Promise<number> {
    const now = this.clock.now();
    const q = (await this.store.get<Queue>(QUEUE))?.value;
    return q ? q.entries.filter((e) => now - e.seen < QUEUE_ALIVE_MS).length : 0;
  }

  /**
   * One look at the queue for this fighter: its match if it was just paired, a partner if one fits (the match is made
   * here), the house if it has waited too long, or its place, refreshed.
   */
  private async queueStep(f: Fighter, fallback: string, now: number): Promise<{ match?: string; house?: boolean; queue: number; waited: number }> {
    // Paired by someone else's poll already?
    const me = (await this.store.get<Fighter>(`arena:fighter:${f.id}`))?.value;
    if (me?.match) {
      const m = await this.store.get<Match>(`arena:match:${me.match}`);
      if (m && !m.value.ending) return { match: me.match, queue: 0, waited: 0 };
    }
    const id = randomHex(12);
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
      const entry: QueueEntry = { fighter: f.id, owner: f.wallet, rating: f.rating.r, fallback, since: mine?.since ?? now, seen: now };
      const others = q.entries.filter((e) => e.fighter !== f.id);
      const waited = now - entry.since;
      if (waited >= HOUSE_AFTER_MS) {
        outcome = { house: true, queue: others.length, waited };
        return { ...q, entries: others };
      }
      const fits = others
        .filter((e) => e.owner !== entry.owner)
        .filter((e) => Math.abs(e.rating - entry.rating) <= ratingGap(Math.max(waited, now - e.since)))
        .sort((x, y) => Math.abs(x.rating - entry.rating) - Math.abs(y.rating - entry.rating) || x.since - y.since);
      const partner = fits[0];
      if (partner) {
        outcome = { match: id, partner, queue: others.length - 1, waited };
        return { entries: others.filter((e) => e.fighter !== partner.fighter), paired: { ...q.paired, [partner.fighter]: { match: id, at: now } } };
      }
      outcome = { queue: others.length, waited };
      return { ...q, entries: [...others, entry] };
    });
    if (outcome.partner && !(await this.startAgents(f, fallback, outcome.partner, id, now))) return { queue: outcome.queue, waited: outcome.waited };
    return outcome;
  }

  /**
   * Makes the match the queue just paired: rated unless it's over the weekly cap for this pair. False when the partner
   * turned out to be busy (it started a match against the house meanwhile): no match, and this fighter queues again.
   */
  private async startAgents(f: Fighter, fallback: string, partner: QueueEntry, id: string, now: number): Promise<boolean> {
    const other = (await this.store.get<Fighter>(`arena:fighter:${partner.fighter}`))?.value;
    if (!other) return false;
    if (other.match) {
      const busy = (await this.store.get<Match>(`arena:match:${other.match}`))?.value;
      if (busy && !busy.ending) return false;
    }
    const week = (x: Fighter, y: string) => x.recent.filter((r) => r.opponent === y && r.rated && now - r.at < WEEK_MS).length;
    const rated = f.wallet !== other.wallet && Math.max(week(f, other.id), week(other, f.id)) < RATED_PER_WEEK && Boolean(f.standing?.ratedOk ?? true) && Boolean(other.standing?.ratedOk ?? true);
    const first = Math.random() < 0.5;
    const me = { id: f.id, name: f.name, fallback: parseFallback(fallback)! };
    const them = { id: other.id, name: other.name, fallback: parseFallback(partner.fallback) ?? { kind: "zero" as const } };
    const m = newAgentMatch({ id, rules: this.rules, now, a: first ? me : them, b: first ? them : me, rated });
    await this.store.cas(`arena:match:${id}`, 0, m);
    for (const x of [f.id, other.id]) {
      await update<Fighter>(this.store, `arena:fighter:${x}`, (cur) => (cur ? { ...cur, match: id } : undefined));
      await update<string[]>(this.store, fighterMatches(x), (cur) => [id, ...(cur ?? []).filter((y) => y !== id)].slice(0, FIGHTER_MATCHES_MAX));
    }
    await update<string[]>(this.store, OPEN, (cur) => [...(cur ?? []), id]);
    return true;
  }

  /** A match against the house, at once. */
  private async startHouse(f: Fighter, fallback: NonNullable<ReturnType<typeof parseFallback>>, bot: HouseBot, outages: Outage[]): Promise<MatchView> {
    const now = this.clock.now();
    const id = randomHex(12);
    const m = newHouseMatch({ id, rules: this.rules, now, fighter: { id: f.id, name: f.name, fallback }, fighterSide: Math.random() < 0.5 ? "a" : "b", bot, seed: randomHex(32), paceMs: this.housePaceMs });
    // Claim the fighter first, so two joins at once can't make two matches.
    let taken: string | null = null;
    await update<Fighter>(this.store, `arena:fighter:${f.id}`, (cur) => {
      if (!cur) return fail("unauthorized", "That fighter is gone.");
      if (cur.match && cur.match !== f.match) {
        taken = cur.match;
        return undefined;
      }
      return { ...cur, match: id };
    });
    if (taken) {
      const existing = await this.current(taken, outages);
      if (!existing.ending) return viewMatch(existing, this.sideOf(existing, f), outages);
    }
    await this.store.cas(`arena:match:${id}`, 0, m);
    await update<string[]>(this.store, OPEN, (cur) => [...(cur ?? []), id]);
    await update<string[]>(this.store, fighterMatches(f.id), (cur) => [id, ...(cur ?? []).filter((x) => x !== id)].slice(0, FIGHTER_MATCHES_MAX));
    // Out of the queue: a fighter playing the house isn't waiting for an agent.
    await update<Queue>(this.store, QUEUE, (cur) => (cur?.entries.some((e) => e.fighter === f.id) ? { ...cur, entries: cur.entries.filter((e) => e.fighter !== f.id) } : undefined));
    return viewMatch(m, this.sideOf(m, f), outages);
  }

  /**
   * The fighter's match. With `wait`, holds until a round newer than `after` is revealed or the match ends (up to the
   * long-poll limit), checking once a second; it never wakes because the opponent moved. It never waits on the caller's
   * own move either: when the open round is waiting for this fighter, it answers at once (a reveal that lands between a
   * client's move and its long-poll would otherwise hold it until the limit).
   */
  async state(f: Fighter, input: { match?: unknown; after?: unknown; wait?: unknown }): Promise<MatchView> {
    const id = typeof input.match === "string" ? input.match : f.match;
    if (!id) fail("not_found", "You're not in a match; call line_join.");
    const after = typeof input.after === "number" && Number.isInteger(input.after) ? input.after : -1;
    const wait = input.wait === true;
    await this.spend(f, wait ? 5 : 1);
    const lock = `arena:poll:${f.id}`;
    if (wait && (await this.store.cas(lock, 0, 1, Math.ceil(this.longPollMs / 1000) + 5)) === null) {
      fail("rate_limited", "One long-poll at a time per fighter.");
    }
    try {
      const until = this.clock.now() + (wait ? this.longPollMs : 0);
      let pause = 1000;
      for (;;) {
        const outages = await this.outages();
        const m = await this.current(id!, outages);
        const side = this.sideOf(m, f);
        const yourMove = Boolean(m.open && !m.open.moves[side]);
        if (!wait || m.ending || m.rounds.length > after || yourMove || this.clock.now() >= until) return viewMatch(m, side, outages);
        await this.clock.sleep(Math.min(pause, until - this.clock.now()));
        pause = Math.min(2000, pause * 1.25);
      }
    } finally {
      if (wait) await this.store.del(lock).catch(() => undefined);
    }
  }

  /** A spectator's view of any match: what both sides see of each other, nothing more. */
  async spectate(id: string): Promise<MatchView> {
    const outages = await this.outages();
    return viewMatch(await this.current(id, outages), null, outages);
  }

  async move(f: Fighter, input: { match?: unknown; round?: unknown; pull?: unknown; nonce?: unknown; line?: unknown }): Promise<MatchView & { accepted: true; repeated: boolean }> {
    await this.spend(f, 1);
    if (typeof input.match !== "string") fail("bad_request", "match is the match's id.");
    if (typeof input.round !== "number" || !Number.isInteger(input.round)) fail("bad_request", "round is the round's number.");
    let line = "";
    try {
      line = checkTableTalk(typeof input.line === "string" ? input.line : "");
    } catch (err) {
      fail("bad_request", (err as Error).message);
    }
    const outages = await this.outages();
    // Play the clock forward and save that first, so a move that comes too late is refused with the round's fallback
    // already recorded and revealed.
    await this.current(input.match as string, outages);
    const now = this.clock.now();
    let repeated = false;
    let ended = false;
    const m = await update<Match>(this.store, `arena:match:${input.match}`, (cur) => {
      if (!cur) return fail("not_found", "No such match.");
      const side = this.sideOf(cur, f);
      settle(cur, now, outages);
      repeated = applyMove(cur, side, { round: input.round as number, pull: input.pull, nonce: input.nonce, line }, now, outages).repeated;
      ended = Boolean(cur.ending);
      return repeated && !ended ? undefined : cur;
    });
    const done = ended ? await this.finish(m!.id) : m!;
    return { ...viewMatch(done, this.sideOf(done, f), outages), accepted: true, repeated };
  }

  /** Leaves the current match: a loss. */
  async retire(f: Fighter): Promise<MatchView> {
    if (!f.match) fail("not_found", "You're not in a match.");
    const outages = await this.outages();
    const now = this.clock.now();
    const m = await update<Match>(this.store, `arena:match:${f.match}`, (cur) => {
      if (!cur) return fail("not_found", "No such match.");
      settle(cur, now, outages);
      if (cur.ending) return cur;
      forfeitMatch(cur, this.sideOf(cur, f), now);
      return cur;
    });
    const done = await this.finish(m!.id);
    return viewMatch(done, this.sideOf(done, f), outages);
  }

  /**
   * The matches for the pages: those under way (their clocks played forward) and the latest finished, newest first,
   * each as a spectator sees it.
   */
  async matches(n = 24): Promise<{ live: MatchView[]; recent: MatchView[] }> {
    const outages = await this.outages();
    const views = async (ids: string[]) => {
      const out: MatchView[] = [];
      for (const id of ids) {
        const m = await this.current(id, outages).catch(() => null);
        if (m) out.push(viewMatch(m, null, outages));
      }
      return out;
    };
    const open = (await this.store.get<string[]>(OPEN))?.value ?? [];
    const recent = (await this.store.get<string[]>(RECENT))?.value ?? [];
    const live = (await views(open.slice(-6).reverse())).filter((v) => !v.ending);
    return { live, recent: await views(recent.slice(0, n)) };
  }

  /** One fighter's matches, newest first, as spectators see them. */
  async fighterMatches(id: string, n = 30): Promise<MatchView[]> {
    const outages = await this.outages();
    const ids = (await this.store.get<string[]>(fighterMatches(id)))?.value ?? [];
    const out: MatchView[] = [];
    for (const mid of ids.slice(0, n)) {
      const m = await this.current(mid, outages).catch(() => null);
      if (m) out.push(viewMatch(m, null, outages));
    }
    return out;
  }

  /**
   * Hides a revealed line of table talk, for a legal takedown only: nobody reviews table talk, and there's no report
   * button. Its move's commitment doesn't cover the line, so every check still holds.
   */
  async hideLine(match: string, round: number, side: "a" | "b"): Promise<void> {
    await update<Match>(this.store, `arena:match:${match}`, (cur) => {
      if (!cur) return fail("not_found", "No such match.");
      const r = cur.rounds[round - 1];
      if (!r) return fail("not_found", "No such round.");
      r[side] = { ...r[side], line: "", hidden: true };
      return cur;
    });
  }

  /** The cron's sweep: plays every open match's clock forward, so matches nobody is watching still end. */
  async sweep(): Promise<{ open: number; ended: number }> {
    const outages = await this.outages();
    const ids = (await this.store.get<string[]>(OPEN))?.value ?? [];
    let ended = 0;
    for (const id of ids) {
      const m = await this.current(id, outages).catch((err) => {
        if (err instanceof RelayError && err.code === "not_found") return null;
        throw err;
      });
      if (!m || m.ending) ended++;
    }
    return { open: ids.length - ended, ended };
  }

  // ---------------------------------------------------------------- results

  /** Applies an ended match's result once: records, ratings, the house's tally, flags, and frees the fighters. */
  private async finish(id: string): Promise<Match> {
    let first = false;
    const m = await update<Match>(this.store, `arena:match:${id}`, (cur) => {
      if (!cur || !cur.ending || cur.settled) return undefined;
      first = true;
      return { ...cur, settled: true };
    });
    if (!first) return m!;
    await update<string[]>(this.store, OPEN, (cur) => (cur ? cur.filter((x) => x !== id) : undefined));
    await update<string[]>(this.store, RECENT, (cur) => [id, ...(cur ?? []).filter((x) => x !== id)].slice(0, RECENT_MAX));
    const sides = (["a", "b"] as const).filter((s) => m!.sides[s].kind === "fighter");
    // Both sides' ratings before the match, so each is rated against the other as it was.
    const before: Partial<Record<Side, Fighter>> = {};
    for (const s of sides) before[s] = (await this.store.get<Fighter>(`arena:fighter:${m!.sides[s].id}`))?.value;
    for (const s of sides) {
      const facts = await this.coins.coin(m!.sides[s].id).catch(() => null);
      const other = s === "a" ? "b" : "a";
      await update<Fighter>(this.store, `arena:fighter:${m!.sides[s].id}`, (cur) => (cur ? this.result(cur, m!, s, facts, before[other]) : undefined));
    }
    if (m!.house) {
      const h = m!.house;
      const score = this.score(m!, h.side);
      if (score !== null) await update<Tally>(this.store, `arena:house:${h.bot}`, (cur) => tally(cur ?? empty(), score));
    }
    await this.flag(m!, before);
    return m!;
  }

  /** 1, 0.5 or 0 for a side, or null when the match has no result (a void). */
  private score(m: Match, side: Side): 0 | 0.5 | 1 | null {
    const e = m.ending!;
    if (e.reason === "void") return null;
    if (e.winner === null) return 0.5;
    return e.winner === side ? 1 : 0;
  }

  /**
   * The fighter after a match. Against the house: its record, and only its deviation (never its rating). Against an
   * agent: its record, and in a rated match its rating against the opponent's rating before the match, a quarter as
   * much when the opponent is still provisional. Forfeits before round 3 and uncontested draws carry no rating.
   */
  private result(f: Fighter, m: Match, side: Side, facts: CoinFacts | null, opponent: Fighter | undefined): Fighter {
    const now = this.clock.now();
    const next: Fighter = { ...f, match: f.match === m.id ? null : f.match, standing: facts ? this.standing(facts, now) : f.standing };
    const score = this.score(m, side);
    const pulls = m.rounds.map((r) => r[side].pull).join(",");
    if (m.rounds.length >= 5) next.seqs = [sha256Hex(pulls), ...(f.seqs ?? [])].slice(0, 10);
    if (score === null) return next;
    const isHouse = Boolean(m.house);
    const which = isHouse ? "house" : m.rated ? "rated" : "unrated";
    next.record = { ...f.record, [which]: tally(f.record[which] ?? empty(), score) };
    if (!isHouse && opponent) next.recent = [{ opponent: opponent.id, at: now, rated: m.rated, score }, ...f.recent].slice(0, 100);
    const informative = !(m.ending!.reason === "forfeit" && m.rounds.length < 3) && !(score === 0.5 && !(contested(m, "a") && contested(m, "b")));
    if (!informative) return next;
    if (isHouse) {
      const after = rate(f.rating, [{ opponent: this.house[m.house!.bot], score }]);
      next.rating = { ...f.rating, rd: after.rd, vol: after.vol };
    } else if (m.rated && opponent) {
      const provisional = opponent.rating.rd >= PROVISIONAL_RD;
      next.rating = rate(f.rating, [{ opponent: opponent.rating, score, weight: provisional ? 0.25 : 1 }]);
      next.opponentOwners = [...new Set([...f.opponentOwners, opponent.wallet])];
      if (!provisional) next.establishedOpponents = [...new Set([...f.establishedOpponents, opponent.id])];
    }
    return next;
  }

  /** Marks what a moderator should look at (docs/arena.md 7). Nothing changes automatically. */
  private async flag(m: Match, before: Partial<Record<Side, Fighter>>): Promise<void> {
    const now = this.clock.now();
    const found: { fighter: string; match: string; reason: string; at: number }[] = [];
    for (const s of ["a", "b"] as const) {
      const f = before[s];
      if (m.sides[s].kind !== "fighter" || !f) continue;
      const add = (reason: string) => found.push({ fighter: f.id, match: m.id, reason, at: now });
      if (m.rounds.length >= 3 && m.rounds.every((r) => r[s].fallback)) add("played only its fallback");
      if (!m.house && m.ending?.reason === "draw" && !(contested(m, "a") && contested(m, "b"))) add("an uncontested draw");
      if (m.rounds.length >= 5 && (f.seqs ?? []).includes(sha256Hex(m.rounds.map((r) => r[s].pull).join(",")))) add("the same pulls as an earlier match");
      const other = m.sides[s === "a" ? "b" : "a"];
      if (!m.house && m.ending?.winner && m.ending.winner !== s) {
        const losses = f.recent.filter((r) => r.opponent === other.id && r.score === 0 && now - r.at < WEEK_MS).length + 1;
        if (losses >= 3) add(`lost ${losses} times this week to ${other.name}`);
      }
    }
    if (found.length) await update<typeof found>(this.store, FLAGS, (cur) => [...(cur ?? []), ...found].slice(-500));
  }

  /** Flags waiting for review, oldest first. */
  async flags() {
    return (await this.store.get<{ fighter: string; match: string; reason: string; at: number }[]>(FLAGS))?.value ?? [];
  }

  // ---------------------------------------------------------------- the leaderboard

  async fighter(id: string): Promise<FighterView> {
    const f = await this.store.get<Fighter>(`arena:fighter:${id}`);
    if (!f) fail("not_found", "No such fighter.");
    return viewFighter(f!.value, PROVISIONAL_RD);
  }

  /**
   * Ranked fighters (off provisional status, listed, not an operator's, with rated results against 5 owners and 5
   * established fighters), by r − 2·RD; then every fighter's record; then the house, never ranked.
   */
  async leaderboard(): Promise<{ ranked: (FighterView & { score: number })[]; fighters: FighterView[]; house: { bot: HouseBot; name: string; rating: number; record: Tally }[] }> {
    const ids = (await this.store.get<string[]>(FIGHTERS))?.value ?? [];
    const all: Fighter[] = [];
    for (const id of ids) {
      const f = await this.store.get<Fighter>(`arena:fighter:${id}`);
      if (f) all.push(f.value);
    }
    const ranked = all
      .filter((f) => !f.operator && f.standing?.listedOk && f.rating.rd < PROVISIONAL_RD && new Set(f.opponentOwners).size >= 5 && new Set(f.establishedOpponents).size >= 5)
      .map((f) => ({ ...viewFighter(f, PROVISIONAL_RD), score: Math.round(conservative(f.rating)) }))
      .sort((x, y) => y.score - x.score);
    const house = [];
    for (const bot of ["reader", "even"] as const) {
      const t = (await this.store.get<Tally>(`arena:house:${bot}`))?.value ?? empty();
      house.push({ bot, name: bot === "even" ? "Even" : "Reader", rating: this.house[bot].r, record: t });
    }
    return { ranked, fighters: all.map((f) => viewFighter(f, PROVISIONAL_RD)), house };
  }
}

function tally(t: Tally, score: 0 | 0.5 | 1): Tally {
  return score === 1 ? { ...t, win: t.win + 1 } : score === 0 ? { ...t, loss: t.loss + 1 } : { ...t, draw: t.draw + 1 };
}
