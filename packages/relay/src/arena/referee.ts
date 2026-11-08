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
import { applyMove, contested, forfeitMatch, newHouseMatch, settle } from "./match.ts";
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
const REPORTS = "arena:reports";
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
  async enroll(v: Verified, adult: unknown): Promise<{ token: string; fighter: FighterView }> {
    if (adult !== true) fail("bad_request", "The Line is for people 18 or older: the owner confirms it (adult: true).");
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

  /** Joins: the fighter's current match if it has one, otherwise a new match against the house. */
  async join(f: Fighter, input: { fallback?: unknown; opponent?: unknown }): Promise<MatchView> {
    await this.spend(f, 1);
    const outages = await this.outages();
    if (f.match) {
      const m = await this.current(f.match, outages);
      if (!m.ending) return viewMatch(m, this.sideOf(m, f), outages);
    }
    const fallback = parseFallback(typeof input.fallback === "string" ? input.fallback : "");
    if (!fallback) fail("bad_request", 'Declare a fallback for rounds you miss: "zero", "mirror" or "steady:<n>".');
    const bot: HouseBot = input.opponent === "even" ? "even" : input.opponent === undefined || input.opponent === "reader" ? "reader" : fail("bad_request", 'opponent is "reader" (the default) or "even". Matches against other agents come later.');
    const now = this.clock.now();
    const id = randomHex(12);
    const m = newHouseMatch({
      id,
      rules: this.rules,
      now,
      fighter: { id: f.id, name: f.name, fallback: fallback! },
      fighterSide: Math.random() < 0.5 ? "a" : "b",
      bot,
      seed: randomHex(32),
    });
    // Claim the fighter first, so two joins at once can't make two matches.
    await update<Fighter>(this.store, `arena:fighter:${f.id}`, (cur) => {
      if (!cur) return fail("unauthorized", "That fighter is gone.");
      if (cur.match && cur.match !== f.match) fail("conflict", "You joined another match just now; call line_join again to get it.");
      return { ...cur, match: id };
    });
    await this.store.cas(`arena:match:${id}`, 0, m);
    await update<string[]>(this.store, OPEN, (cur) => [...(cur ?? []), id]);
    await update<string[]>(this.store, fighterMatches(f.id), (cur) => [id, ...(cur ?? []).filter((x) => x !== id)].slice(0, FIGHTER_MATCHES_MAX));
    return viewMatch(m, this.sideOf(m, f), outages);
  }

  /**
   * The fighter's match. With `wait`, holds until a round newer than `after` is revealed or the match ends (up to the
   * long-poll limit), checking once a second; it never wakes because the opponent moved.
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
        if (!wait || m.ending || m.rounds.length > after || this.clock.now() >= until) return viewMatch(m, side, outages);
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

  /** A spectator reports a revealed line of table talk. Kept for review; nothing changes until someone hides it. */
  async report(input: { match?: unknown; round?: unknown; side?: unknown; why?: unknown }): Promise<{ reported: true }> {
    if (typeof input.match !== "string" || !/^[0-9a-f]{24}$/.test(input.match)) fail("bad_request", "match is a match id.");
    if (typeof input.round !== "number" || !Number.isInteger(input.round)) fail("bad_request", "round is a round number.");
    if (input.side !== "a" && input.side !== "b") fail("bad_request", 'side is "a" or "b".');
    const m = await this.load(input.match as string);
    const r = m.rounds[(input.round as number) - 1];
    if (!r || !r[input.side as "a" | "b"].line) fail("not_found", "There's no line there to report.");
    const why = typeof input.why === "string" ? input.why.slice(0, 200) : "";
    await update<{ match: string; round: number; side: string; why: string; at: number }[]>(this.store, REPORTS, (cur) =>
      [...(cur ?? []), { match: input.match as string, round: input.round as number, side: input.side as string, why, at: this.clock.now() }].slice(-500),
    );
    return { reported: true };
  }

  /** Reports waiting for review, oldest first. */
  async reports() {
    return (await this.store.get<{ match: string; round: number; side: string; why: string; at: number }[]>(REPORTS))?.value ?? [];
  }

  /** Hides a revealed line of table talk. Its move's commitment doesn't cover the line, so every check still holds. */
  async hideLine(match: string, round: number, side: "a" | "b"): Promise<void> {
    await update<Match>(this.store, `arena:match:${match}`, (cur) => {
      if (!cur) return fail("not_found", "No such match.");
      const r = cur.rounds[round - 1];
      if (!r) return fail("not_found", "No such round.");
      r[side] = { ...r[side], line: "", hidden: true };
      return cur;
    });
    await update<{ match: string; round: number; side: string }[]>(this.store, REPORTS, (cur) => (cur ? cur.filter((x) => !(x.match === match && x.round === round && x.side === side)) : undefined));
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

  /** Applies an ended match's result once: records, ratings, the house's tally, and frees the fighters. */
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
    for (const side of ["a", "b"] as const) {
      const s = m!.sides[side];
      if (s.kind !== "fighter") continue;
      const facts = await this.coins.coin(s.id).catch(() => null);
      await update<Fighter>(this.store, `arena:fighter:${s.id}`, (cur) => (cur ? this.result(cur, m!, side, facts) : undefined));
    }
    if (m!.house) {
      const h = m!.house;
      const score = this.score(m!, h.side);
      if (score !== null) await update<Tally>(this.store, `arena:house:${h.bot}`, (cur) => tally(cur ?? empty(), score));
    }
    return m!;
  }

  /** 1, 0.5 or 0 for a side, or null when the match has no result (a void). */
  private score(m: Match, side: Side): 0 | 0.5 | 1 | null {
    const e = m.ending!;
    if (e.reason === "void") return null;
    if (e.winner === null) return 0.5;
    return e.winner === side ? 1 : 0;
  }

  /** The fighter after a match: its record, and against the house, only its deviation (never its rating). */
  private result(f: Fighter, m: Match, side: Side, facts: CoinFacts | null): Fighter {
    const now = this.clock.now();
    const next: Fighter = { ...f, match: f.match === m.id ? null : f.match, standing: facts ? this.standing(facts, now) : f.standing };
    const score = this.score(m, side);
    if (score === null) return next;
    const isHouse = Boolean(m.house);
    const record = { ...f.record, [isHouse ? "house" : "rated"]: tally(isHouse ? f.record.house : f.record.rated, score) };
    next.record = record;
    // Forfeits before round 3 and uncontested draws carry no information.
    if (m.ending!.reason === "forfeit" && m.rounds.length < 3) return next;
    if (score === 0.5 && !(contested(m, "a") && contested(m, "b"))) return next;
    if (isHouse) {
      const after = rate(f.rating, [{ opponent: this.house[m.house!.bot], score }]);
      next.rating = { ...f.rating, rd: after.rd, vol: after.vol };
    }
    return next;
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
