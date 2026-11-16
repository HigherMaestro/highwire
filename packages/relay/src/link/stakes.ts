import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { rate, START, type Rating } from "highwire-core/arena";
import type { Fighter, Tally } from "../arena/types.ts";
import { concat, hexBytes, key32, le, toHex } from "../bytes.ts";
import type { Clock } from "../clock.ts";
import { fail } from "../errors.ts";
import { randomHex } from "../registration.ts";
import { update, type Store } from "../store.ts";
import { LINK_STAKE, LINK_STAKE_OF, practiceGoing, type FallbackKind, type LinkArena, type LinkEnding } from "./arena.ts";

// Link battles' practice stakes (docs/link-wager.md 3), the referee's side. Devnet only: its SOL is worth nothing, and
// this desk has no setting that would make it anything else.
//
// - It pairs two fighters at a tier and signs a **ticket**; each side stakes with it, from its own wallet, through
//   its own local signer. The desk never holds, sees or moves a stake.
// - When the chain shows both stakes in, it starts the battle. The battle is an ordinary link battle (arena.ts): the
//   same tools, clocks and fallbacks. Nothing about a turn goes on-chain.
// - When the battle ends, it signs a **result**: this battle, these two wallets, who won. Either side's agent sends
//   it; the program checks the signature and pays the winner, or refunds both for a draw or a void.
// - Two keys, apart: the ticket key signs pairings, the result key signs results. Neither moves money, and neither is
//   ever in a response, a log or the store.
// - Every way a stake can stall ends: a ticket nobody used expires, an opening nobody accepted frees both, a battle
//   that can't be started is signed void (so both are refunded), and a result nobody sends leaves the program's own
//   refund after its deadline.
// - It keeps a practice rating of its own. A staked battle never moves the free ladder (docs/link-wager.md 5).

/** What the deployment tells the desk about the chain: where each battle it ticketed stands. */
export interface LinkStakeChain {
  /** open: A staked. live: both staked. closed: the battle's account is gone, and how. none: no account, no closing found. */
  status(battleId: string): Promise<{ state: "none" | "open" | "live" } | { state: "closed"; how: "settled" | "cancelled" | "refunded" }>;
  /** The program's config as it stands. With it, the desk pairs only when a ticket could open and a result could settle. */
  config?(): Promise<{ paused: boolean; ticketKeyId: number; resultKeyId: number }>;
}

export interface LinkStakeConfig {
  /** The link-wager program's id (base58), on devnet. */
  programId: string;
  /** The desk's Ed25519 secret (32 bytes) for tickets, and the key id the program's config holds for it. */
  ticketSecret: Uint8Array;
  ticketKeyId: number;
  /** The referee's Ed25519 secret (32 bytes) for results, and its key id. A different key from the ticket's. */
  resultSecret: Uint8Array;
  resultKeyId: number;
  /** Stake tiers, lamports a side; the program's config must hold each. */
  tiers: bigint[];
  chain: LinkStakeChain;
  /** Different owners waiting at a tier before it pairs. Default 2. */
  minQueue?: number;
  /** How long the ticket lives from the pairing: A must open and B accept within it. Default 5 minutes. */
  acceptSeconds?: number;
  perPairPerWeek?: number;
  longPollMs?: number;
}

/** The ticket as the program reads it (`LinkTicket` in highwire-wager's link-codec.ts), the stake as a decimal string. */
export interface LinkTicketRecord {
  battleId: string;
  playerA: string;
  playerB: string;
  stake: string;
  acceptDeadline: number;
  expiry: number;
  keyId: number;
}

export type LinkStakeOutcome = "a" | "b" | "draw" | "void";

/** The result as the program reads it (`LinkResult` in link-codec.ts). */
export interface LinkResultRecord {
  battleId: string;
  playerA: string;
  playerB: string;
  outcome: LinkStakeOutcome;
  keyId: number;
}

/**
 * How a stake left the desk's books. settled, cancelled, refunded: the chain's. expired: never opened. unaccepted: A
 * opened and B never did (A cancels on-chain). unread: its account went with no closing the desk could find.
 */
export type LinkStakeClosed = "settled" | "cancelled" | "refunded" | "expired" | "unaccepted" | "unread";

export interface LinkStake {
  /** The battle's id on-chain: 32 bytes, hex. */
  id: string;
  ticket: LinkTicketRecord;
  /** The desk's signature over the ticket's message, hex. */
  signature: string;
  fighters: { A: string; B: string };
  fallbacks: { A: FallbackKind; B: FallbackKind };
  createdAt: number;
  /** ticketed: waiting for both stakes. playing: the battle is on. over: the result is signed. done: off the books. */
  status: "ticketed" | "playing" | "over" | "done";
  /** The last state the desk saw on-chain, and when (ms). */
  seen?: { state: "open" | "live"; at: number };
  /** When both stakes were first seen in. */
  liveAt?: number;
  /** The link battle (arena.ts), once it started. */
  match?: string;
  /** The battle's outcome, when (ms), and both practice ratings before it (so a retried close rates the same). */
  result?: { outcome: LinkStakeOutcome; at: number; before: { A: Rating; B: Rating } };
  closed?: LinkStakeClosed;
}

/** A fighter's practice-stake standing: a rating and record of its own, and the stakes already counted in it. */
interface StakeStanding {
  rating: Rating;
  record: Tally;
  applied: string[];
}

interface Entry {
  fighter: string;
  owner: string;
  tier: string;
  fallback: FallbackKind;
  rating: number;
  since: number;
  seen: number;
  /** Not paired before this: a random wait of a few seconds, so two that join together aren't simply paired. */
  readyAt: number;
}

interface StakeQueue {
  entries: Entry[];
  paired: Record<string, { stake: string; at: number }>;
  pairs: { week: number; counts: Record<string, number> };
}

const QUEUE = "link:stake-queue";
const OPEN = "link:stakes-open";
const PLAYED = "link:stakes-played";
const STANDING = (fighter: string) => `link:stake-standing:${fighter}`;
/** A fighter's latest stakes, so a result it hasn't settled is still there after it stakes again. */
const MINE = (fighter: string) => `link:stakes-of:${fighter}`;
const MINE_MAX = 20;
const POLL = (fighter: string) => `link:stake-poll:${fighter}`;
const STARTING = (id: string) => `link:stake-starting:${id}`;
const fighterKey = (id: string) => `arena:fighter:${id}`;
const PLAYED_MAX = 500;
const ALIVE_MS = 60_000;
/** Past the ticket's time on the server's clock before "never opened" is believed: the chain's clock can lag. */
const EXPIRY_MARGIN_MS = 2 * 60_000;
/** Both stakes in and no battle after this long (the rig is down, a fighter is gone): signed void, so both are refunded. */
const START_GIVE_UP_MS = 5 * 60_000;
/** A stake whose account vanished with no closing found, or whose result nobody sent or refunded: off the books after this. */
const UNREAD_AFTER_MS = 60 * 60_000;
const UNSETTLED_AFTER_MS = 8 * 86_400_000;
const WEEK_MS = 7 * 86_400_000;
const FALLBACKS: FallbackKind[] = ["first", "strongest", "random"];
const TICKET_DOMAIN = new TextEncoder().encode("highwire-link-ticket-1");
const RESULT_DOMAIN = new TextEncoder().encode("highwire-link-result-1");
const OUTCOMES: LinkStakeOutcome[] = ["a", "b", "draw", "void"];
const ratingGap = (waitedMs: number) => 150 + 100 * Math.floor(waitedMs / 30_000);
const pairKey = (x: string, y: string) => [x, y].sort().join(":");
const emptyTally = (): Tally => ({ win: 0, draw: 0, loss: 0 });

/** The bytes the program checks for a ticket (programs/link-wager/src/signed.rs, link-codec.ts `linkTicketMessage`). */
export function linkStakeTicketMessage(programId: string, t: LinkTicketRecord): Uint8Array {
  return concat([TICKET_DOMAIN, key32(programId), hexBytes(t.battleId), key32(t.playerA), key32(t.playerB), le(BigInt(t.stake), 8), le(BigInt(t.acceptDeadline), 8), le(BigInt(t.expiry), 8), le(BigInt(t.keyId), 2)]);
}

/** The bytes the program checks for a result (signed.rs, link-codec.ts `linkResultMessage`). */
export function linkStakeResultMessage(programId: string, r: LinkResultRecord): Uint8Array {
  return concat([RESULT_DOMAIN, key32(programId), hexBytes(r.battleId), key32(r.playerA), key32(r.playerB), Uint8Array.of(OUTCOMES.indexOf(r.outcome)), le(BigInt(r.keyId), 2)]);
}

/** A battle's ending as the stake's outcome: the winner by its ticket's letter, a draw, or a void (both refunded). */
export function stakeOutcome(ended: LinkEnding, sides: [string, string], fighters: { A: string; B: string }): LinkStakeOutcome {
  if (ended.reason === "void") return "void";
  if (ended.winner === null) return "draw";
  return sides[ended.winner] === fighters.A ? "a" : "b";
}

/** What a player sees of its stake: what it needs to stake, play and settle, and nothing of anyone else's. */
export interface LinkStakeView {
  battle: string;
  role: "A" | "B";
  ticket: LinkTicketRecord;
  signature: string;
  programId: string;
  cluster: "devnet";
  status: LinkStake["status"];
  /** The link battle to play (link_state, link_move), once both stakes are in. */
  match?: string;
  /** The referee's signed result, once the battle has ended: either side sends it to settle. */
  result?: { result: LinkResultRecord; signature: string; you: "won" | "lost" | "draw" | "void" };
  closed?: LinkStakeClosed;
  next: string;
}

export type LinkStakeJoin = { stake: LinkStakeView } | { waiting: true; tier: string; waitingAtTier: number; needed: number; waitedSeconds: number };

export class LinkStakeDesk {
  private minQueue: number;
  private acceptMs: number;
  private perPair: number;
  private longPollMs: number;
  private tiers: Set<string>;
  readonly ticketKey: string;
  readonly resultKey: string;

  constructor(
    private store: Store,
    private clock: Clock,
    private cfg: LinkStakeConfig,
    private arena: LinkArena,
    private spend: (f: Fighter, units: number) => Promise<void>,
  ) {
    // Checked here, not when a pairing is signed: a bad value would otherwise hold pairs on tickets that can't be made.
    for (const [what, secret] of [["ticket", cfg.ticketSecret], ["result", cfg.resultSecret]] as const) {
      if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new Error(`the ${what} key is a 32-byte Ed25519 secret`);
    }
    if (bs58.decode(cfg.programId).length !== 32) throw new Error("the link-wager program id isn't an address");
    for (const id of [cfg.ticketKeyId, cfg.resultKeyId]) if (!Number.isInteger(id) || id < 0 || id > 65_535) throw new Error("a key id is a whole number from 0 to 65535");
    if (cfg.tiers.length === 0 || cfg.tiers.some((t) => typeof t !== "bigint" || t <= 0n || t >= 2n ** 64n)) throw new Error("each tier is a positive number of lamports");
    this.ticketKey = bs58.encode(ed25519.getPublicKey(cfg.ticketSecret));
    this.resultKey = bs58.encode(ed25519.getPublicKey(cfg.resultSecret));
    // One key for both would let a ticket's signer settle: the program keeps them apart, and so does the desk.
    if (this.ticketKey === this.resultKey) throw new Error("the ticket key and the result key must be different keys");
    this.minQueue = cfg.minQueue ?? 2;
    if (!Number.isInteger(this.minQueue) || this.minQueue < 2) throw new Error("minQueue is at least 2");
    this.acceptMs = (cfg.acceptSeconds ?? 300) * 1000;
    this.perPair = cfg.perPairPerWeek ?? 2;
    this.longPollMs = cfg.longPollMs ?? 40_000;
    this.tiers = new Set(cfg.tiers.map(String));
  }

  /** What any client needs to know before it stakes: the program, the cluster, the tiers and the two public keys. */
  info() {
    return {
      programId: this.cfg.programId,
      cluster: "devnet" as const,
      practice: "Devnet SOL is worth nothing. Practice stakes never touch the free ladder, and nothing of value is ever attached to them.",
      tiers: [...this.tiers],
      ticketKey: this.ticketKey,
      ticketKeyId: this.cfg.ticketKeyId,
      resultKey: this.resultKey,
      resultKeyId: this.cfg.resultKeyId,
      minQueue: this.minQueue,
      perPairPerWeek: this.perPair,
    };
  }

  private async standing(fighter: string): Promise<StakeStanding> {
    return (await this.store.get<StakeStanding>(STANDING(fighter)))?.value ?? { rating: START, record: emptyTally(), applied: [] };
  }

  /** The result the referee signs for a stake that has one, with the key the program holds now. */
  private signed(s: LinkStake): { result: LinkResultRecord; signature: string } | null {
    if (!s.result) return null;
    const result: LinkResultRecord = { battleId: s.id, playerA: s.ticket.playerA, playerB: s.ticket.playerB, outcome: s.result.outcome, keyId: this.cfg.resultKeyId };
    return { result, signature: toHex(ed25519.sign(linkStakeResultMessage(this.cfg.programId, result), this.cfg.resultSecret)) };
  }

  private view(s: LinkStake, f: Fighter): LinkStakeView {
    const role = s.fighters.A === f.id ? "A" : "B";
    const signed = this.signed(s);
    const o = s.result?.outcome;
    const you = o === undefined ? null : o === "void" ? "void" : o === "draw" ? "draw" : (o === "a") === (role === "A") ? "won" : "lost";
    const by = new Date(s.ticket.acceptDeadline * 1000).toISOString();
    const next =
      s.status === "done"
        ? "This stake is closed; stake again for another battle."
        : s.status === "over"
          ? you === "won"
            ? "The battle is over and you won: settle with this signed result, and both stakes come to your wallet."
            : you === "lost"
              ? "The battle is over and you lost. Settling with this signed result pays the winner; either side may send it."
              : "The battle is over with no winner: settle with this signed result, and both stakes are refunded."
          : s.status === "playing"
            ? `Both stakes are in and the battle is on: play it with link_state and link_move (match ${s.match}).`
            : role === "A"
              ? `Open the battle now: stake ${s.ticket.stake} lamports with this ticket. B must accept by ${by}, so the sooner the better.`
              : `Wait for A to open, then accept: stake ${s.ticket.stake} lamports with this ticket by ${by}.`;
    return {
      battle: s.id,
      role,
      ticket: s.ticket,
      signature: s.signature,
      programId: this.cfg.programId,
      cluster: "devnet",
      status: s.status,
      ...(s.match ? { match: s.match } : {}),
      ...(signed && you ? { result: { ...signed, you } } : {}),
      ...(s.closed ? { closed: s.closed } : {}),
      next,
    };
  }

  /** The stake a fighter is in, moved on as far as the chain and the battle allow; null when it's in none still open. */
  private async active(fighter: string): Promise<LinkStake | null> {
    const id = (await this.store.get<string>(LINK_STAKE_OF(fighter)))?.value;
    if (!id) return null;
    const s = await this.advance(id).catch(async () => (await this.store.get<LinkStake>(LINK_STAKE(id)))?.value ?? null);
    return s && (s.status === "ticketed" || s.status === "playing") ? s : null;
  }

  /**
   * The fighter's stake: the one it's in, or its last (so the signed result is there to settle with after the battle),
   * and its practice standing.
   */
  async state(f: Fighter): Promise<(LinkStakeView | { none: true }) & { you: { rating: number; record: Tally } }> {
    await this.spend(f, 1);
    const id = (await this.store.get<string>(LINK_STAKE_OF(f.id)))?.value;
    const s = id ? await this.advance(id).catch(async () => (await this.store.get<LinkStake>(LINK_STAKE(id)))?.value ?? null) : null;
    const w = await this.standing(f.id);
    const you = { rating: Math.round(w.rating.r), record: w.record };
    return s ? { ...this.view(s, f), you } : { none: true, you };
  }

  /**
   * The fighter's battles that are over and not yet closed on-chain, each with the referee's signed result: what its
   * agent (or its daemon) settles with, whatever it has staked on since.
   */
  async results(f: Fighter): Promise<{ results: { battle: string; match?: string; result: LinkResultRecord; signature: string; you: "won" | "lost" | "draw" | "void" }[] }> {
    await this.spend(f, 1);
    const ids = ((await this.store.get<string[]>(MINE(f.id)))?.value ?? []).slice().reverse();
    const results = [];
    for (const id of ids) {
      const s = await this.advance(id).catch(async () => (await this.store.get<LinkStake>(LINK_STAKE(id)))?.value ?? null);
      if (!s || s.status !== "over") continue;
      const v = this.view(s, f);
      if (v.result) results.push({ battle: s.id, ...(s.match ? { match: s.match } : {}), ...v.result });
    }
    return { results };
  }

  private configRead: { at: number; value: Promise<{ paused: boolean; ticketKeyId: number; resultKeyId: number } | null> } | null = null;

  /** The program's config, read at most every 30 seconds; null when the deployment can't say (pairing goes on). */
  private programConfig() {
    const now = this.clock.now();
    if (!this.cfg.chain.config) return Promise.resolve(null);
    if (!this.configRead || now - this.configRead.at > 30_000) this.configRead = { at: now, value: this.cfg.chain.config().catch(() => null) };
    return this.configRead.value;
  }

  /**
   * Queues at a tier (lamports a side, as a decimal string) with a fallback for missed decisions, and waits up to the
   * long-poll limit to be paired. Returns the stake with its signed ticket, or the queue's state (call again within a
   * minute to keep the place). A fighter already paired gets that stake back.
   */
  async join(f: Fighter, input: { stake?: unknown; fallback?: unknown; wait?: unknown }): Promise<LinkStakeJoin> {
    if (f.operator) fail("refused", "Highwire's and the maintainer's own fighters never stake against the public.");
    const current = await this.active(f.id);
    if (current) return { stake: this.view(current, f) };
    const onChain = await this.programConfig();
    if (onChain?.paused) fail("refused", "Staking on link battles is paused: no new battles for now. Try again later.");
    if (onChain && (onChain.ticketKeyId !== this.cfg.ticketKeyId || onChain.resultKeyId !== this.cfg.resultKeyId)) fail("refused", "The referee's keys are being changed: no new staked battles for a few minutes. Try again later.");
    const tier = typeof input.stake === "string" ? input.stake : typeof input.stake === "number" ? String(input.stake) : "";
    if (!this.tiers.has(tier)) fail("bad_request", `stake is one of the tiers, in lamports a side: ${[...this.tiers].join(", ")}.`);
    const fallback = typeof input.fallback === "string" && (FALLBACKS as string[]).includes(input.fallback) ? (input.fallback as FallbackKind) : null;
    if (!fallback) fail("bad_request", 'Declare a fallback for decisions you miss: "first", "strongest" or "random".');
    const now = this.clock.now();
    if (await this.arena.inBattle(f.id)) fail("conflict", "You have a link battle going: finish it (link_state, link_move) or leave it (link_leave) first.");
    if (await practiceGoing(this.store, f.id, now)) fail("conflict", "You have a practice battle going: finish it or leave it (link_practice with leave) first.");
    await this.arena.enrol(f);
    const wait = input.wait !== false;
    await this.spend(f, wait ? 5 : 1);
    // One join at a time per fighter, waiting or not: two at once could queue it again after the other paired it.
    if ((await this.store.cas(POLL(f.id), 0, 1, Math.ceil(this.longPollMs / 1000) + 5)) === null) fail("rate_limited", "One stake join at a time per fighter.");
    try {
      const until = this.clock.now() + (wait ? this.longPollMs : 0);
      let pause = 1000;
      for (;;) {
        const t = this.clock.now();
        const step = await this.step(f, tier, fallback!, t);
        if (step.stake) {
          const s = (await this.store.get<LinkStake>(LINK_STAKE(step.stake)))?.value;
          if (s) return { stake: this.view(s, f) };
        }
        if (t >= until) return { waiting: true, tier, waitingAtTier: step.atTier, needed: this.minQueue, waitedSeconds: Math.round(step.waited / 1000) };
        await this.clock.sleep(Math.min(pause, Math.max(0, until - t)));
        pause = Math.min(2000, pause * 1.25);
      }
    } finally {
      await this.store.del(POLL(f.id)).catch(() => undefined);
    }
  }

  /** Leaves the queue. A pairing already made stands until its ticket runs out. */
  async leave(f: Fighter): Promise<{ left: boolean }> {
    let left = false;
    await update<StakeQueue>(this.store, QUEUE, (cur) => {
      if (!cur?.entries.some((e) => e.fighter === f.id)) return undefined;
      left = true;
      return { ...cur, entries: cur.entries.filter((e) => e.fighter !== f.id) };
    });
    return { left };
  }

  /** One look at the queue: a pairing made by someone else's poll, a partner (the ticket is made here), or a place. */
  private async step(f: Fighter, tier: string, fallback: FallbackKind, now: number): Promise<{ stake?: string; atTier: number; waited: number }> {
    const held = (await this.store.get<string>(LINK_STAKE_OF(f.id)))?.value;
    const mine = held ? (await this.store.get<LinkStake>(LINK_STAKE(held)))?.value : null;
    if (mine && (mine.status === "ticketed" || mine.status === "playing")) return { stake: mine.id, atTier: 0, waited: 0 };
    const id = randomHex(32);
    const week = Math.floor(now / WEEK_MS);
    const rating = (await this.standing(f.id)).rating.r;
    let outcome: { stake?: string; partner?: Entry; atTier: number; waited: number } = { atTier: 0, waited: 0 };
    await update<StakeQueue>(this.store, QUEUE, (cur) => {
      const q: StakeQueue = {
        entries: (cur?.entries ?? []).filter((e) => now - e.seen < ALIVE_MS),
        paired: Object.fromEntries(Object.entries(cur?.paired ?? {}).filter(([, v]) => now - v.at < 2 * ALIVE_MS)),
        pairs: cur?.pairs.week === week ? cur.pairs : { week, counts: {} },
      };
      // A note that it was paired is only a hint to look again: the stake itself says whether it's held (above).
      delete q.paired[f.id];
      const before = q.entries.find((e) => e.fighter === f.id);
      const same = before && before.tier === tier;
      const entry: Entry = { fighter: f.id, owner: f.wallet, tier, fallback, rating, since: same ? before.since : now, seen: now, readyAt: same ? before.readyAt : now + 2_000 + Math.floor(Math.random() * 8_000) };
      const others = q.entries.filter((e) => e.fighter !== f.id);
      const atTier = others.filter((e) => e.tier === tier);
      const owners = new Set([entry.owner, ...atTier.map((e) => e.owner)]);
      const waited = now - entry.since;
      outcome = { atTier: atTier.length + 1, waited };
      if (owners.size < this.minQueue || now < entry.readyAt) return { ...q, entries: [...others, entry] };
      const partner = atTier
        .filter((e) => e.owner !== entry.owner && now >= e.readyAt)
        .filter((e) => (q.pairs.counts[pairKey(e.owner, entry.owner)] ?? 0) < this.perPair)
        .filter((e) => Math.abs(e.rating - entry.rating) <= ratingGap(Math.max(waited, now - e.since)))
        .sort((x, y) => Math.abs(x.rating - entry.rating) - Math.abs(y.rating - entry.rating) || x.since - y.since)[0];
      if (!partner) return { ...q, entries: [...others, entry] };
      const k = pairKey(partner.owner, entry.owner);
      outcome = { stake: id, partner, atTier: atTier.length - 1, waited };
      return {
        entries: others.filter((e) => e.fighter !== partner.fighter),
        paired: { ...q.paired, [partner.fighter]: { stake: id, at: now } },
        pairs: { week, counts: { ...q.pairs.counts, [k]: (q.pairs.counts[k] ?? 0) + 1 } },
      };
    });
    if (outcome.partner) {
      const made = await this.ticket(f, fallback, outcome.partner, id, tier, now).catch(() => false);
      if (!made) {
        await this.uncount(outcome.partner.owner, f.wallet, week);
        return { atTier: outcome.atTier, waited: outcome.waited };
      }
    }
    return outcome;
  }

  /** Gives a pair its weekly count back: for a pairing that made no ticket, or a ticket nobody used. */
  private async uncount(x: string, y: string, week: number) {
    const k = pairKey(x, y);
    await update<StakeQueue>(this.store, QUEUE, (cur) => {
      if (!cur || cur.pairs.week !== week || !(cur.pairs.counts[k]! > 0)) return undefined;
      return { ...cur, pairs: { ...cur.pairs, counts: { ...cur.pairs.counts, [k]: cur.pairs.counts[k]! - 1 } } };
    }).catch(() => undefined);
  }

  /**
   * Signs the ticket for a pairing and records the stake. Which of the two is A is random. Both fighters are held from
   * here (arena.ts `stakeHeld`): each is taken by compare-and-set, so a fighter is never in two stakes, and a failure
   * at any point leaves nothing the sweep can't finish.
   */
  private async ticket(f: Fighter, fallback: FallbackKind, partner: Entry, id: string, tier: string, now: number): Promise<boolean> {
    const other = (await this.store.get<Fighter>(fighterKey(partner.fighter)))?.value;
    if (!other || other.operator || other.wallet === f.wallet) return false;
    if ((await this.arena.inBattle(other.id)) || (await practiceGoing(this.store, other.id, now))) return false;
    const [a, b] = Math.random() < 0.5 ? [f, other] : [other, f];
    const fallbacks = a === f ? { A: fallback, B: partner.fallback } : { A: partner.fallback, B: fallback };
    // One time for both: the program refuses an accept deadline later than the expiry.
    const until = Math.floor((now + this.acceptMs) / 1000);
    const ticket: LinkTicketRecord = { battleId: id, playerA: a.wallet, playerB: b.wallet, stake: tier, acceptDeadline: until, expiry: until, keyId: this.cfg.ticketKeyId };
    const signature = toHex(ed25519.sign(linkStakeTicketMessage(this.cfg.programId, ticket), this.cfg.ticketSecret));
    await update<string[]>(this.store, OPEN, (cur) => [...(cur ?? []).filter((x) => x !== id), id]);
    await this.store.cas(LINK_STAKE(id), 0, { id, ticket, signature, fighters: { A: a.id, B: b.id }, fallbacks, createdAt: now, status: "ticketed" } satisfies LinkStake);
    const taken: string[] = [];
    for (const x of [a, b]) {
      if (await this.hold(x.id, id)) taken.push(x.id);
      else break;
    }
    if (taken.length === 2) {
      for (const x of [a, b]) await update<string[]>(this.store, MINE(x.id), (cur) => [...(cur ?? []).filter((y) => y !== id), id].slice(-MINE_MAX));
      return true;
    }
    // One of them was taken by another pairing meanwhile: this one never happened.
    for (const x of taken) await this.letGo(x, id);
    await this.store.del(LINK_STAKE(id)).catch(() => undefined);
    await update<string[]>(this.store, OPEN, (cur) => (cur?.includes(id) ? cur.filter((x) => x !== id) : undefined));
    return false;
  }

  /** Points a fighter at a stake, unless it's held by another that's still on. */
  private async hold(fighter: string, id: string): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const cur = await this.store.get<string>(LINK_STAKE_OF(fighter));
      if (cur && cur.value !== id) {
        const st = (await this.store.get<LinkStake>(LINK_STAKE(cur.value)))?.value;
        if (st && (st.status === "ticketed" || st.status === "playing")) return false;
      }
      if ((await this.store.cas(LINK_STAKE_OF(fighter), cur?.version ?? 0, id)) !== null) return true;
    }
    return false;
  }

  private async letGo(fighter: string, id: string) {
    const cur = await this.store.get<string>(LINK_STAKE_OF(fighter));
    if (cur?.value === id) await this.store.del(LINK_STAKE_OF(fighter)).catch(() => undefined);
  }

  /**
   * Moves one stake on as far as it can go now, and returns it. Safe to call from anywhere, any number of times: the
   * agents' polls call it (so a battle starts as soon as the second stake lands) and so does the cron's sweep (so
   * nothing depends on an agent that stopped).
   */
  async advance(id: string): Promise<LinkStake | null> {
    let s = (await this.store.get<LinkStake>(LINK_STAKE(id)))?.value ?? null;
    if (!s || s.status === "done") return s;
    const now = this.clock.now();
    const set = async (patch: (cur: LinkStake) => LinkStake | undefined) => (await update<LinkStake>(this.store, LINK_STAKE(id), (cur) => (cur ? patch(cur) : undefined))) ?? (await this.store.get<LinkStake>(LINK_STAKE(id)))?.value ?? null;

    if (s.status === "ticketed") {
      const st = await this.cfg.chain.status(id);
      if (st.state === "closed") return this.close(s, st.how);
      if (st.state === "none") {
        if (!s.seen && now > s.ticket.expiry * 1000 + EXPIRY_MARGIN_MS) {
          // Never played: the pair gets its weekly count back.
          await this.uncount(s.ticket.playerA, s.ticket.playerB, Math.floor(s.createdAt / WEEK_MS));
          return this.close(s, "expired");
        }
        if (s.seen && now - s.seen.at > UNREAD_AFTER_MS) return this.close(s, s.seen.state === "open" ? "unaccepted" : "unread");
        return s;
      }
      const state = st.state;
      s = await set((cur) => (cur.status === "ticketed" ? { ...cur, seen: { state, at: now }, ...(state === "live" && !cur.liveAt ? { liveAt: now } : {}) } : undefined));
      if (!s || s.status !== "ticketed") return s;
      if (state === "open") return now > s.ticket.acceptDeadline * 1000 + EXPIRY_MARGIN_MS ? this.close(s, "unaccepted") : s;
      // Both stakes are in: start the battle, once.
      if ((await this.store.cas(STARTING(id), 0, 1, 90)) === null) return s;
      try {
        const m = await this.arena.startStaked(id, { fighter: s.fighters.A, fallback: s.fallbacks.A }, { fighter: s.fighters.B, fallback: s.fallbacks.B }).catch(() => null);
        if (m) {
          await update<string[]>(this.store, PLAYED, (cur) => [...(cur ?? []).filter((x) => x !== id), id].slice(-PLAYED_MAX));
          s = await set((cur) => (cur.status === "ticketed" ? { ...cur, status: "playing", match: m.id } : undefined));
        } else if (now - (s.liveAt ?? now) > START_GIVE_UP_MS) {
          // No battle can be played for it: a void, so the stakes go back as soon as either side sends it.
          s = await this.conclude(s, "void");
        }
      } finally {
        await this.store.del(STARTING(id)).catch(() => undefined);
      }
      if (!s || s.status !== "playing") return s;
    }

    if (s.status === "playing") {
      const e = s.match ? await this.arena.ending(s.match) : null;
      if (!e) return s;
      s = await this.conclude(s, stakeOutcome(e.ended, e.fighters, s.fighters));
      if (!s || s.status !== "over") return s;
    }

    // over: the result is signed; the stake leaves the books when the chain closes it.
    const st = await this.cfg.chain.status(id);
    if (st.state === "closed") return this.close(s, st.how);
    const since = s.result?.at ?? s.createdAt;
    if (st.state === "none" && now - since > UNREAD_AFTER_MS) return this.close(s, "unread");
    if (now - since > UNSETTLED_AFTER_MS) return this.close(s, "unread");
    return s;
  }

  /**
   * Records a battle's outcome, once, and frees both fighters. The practice ratings before it are written with it, and
   * each fighter's standing changes only if this stake isn't counted in it yet, so a call that died part way is
   * finished by the next and never counted twice. From here the signed result is in each side's view.
   */
  private async conclude(s: LinkStake, outcome: LinkStakeOutcome): Promise<LinkStake | null> {
    const now = this.clock.now();
    const before = { A: (await this.standing(s.fighters.A)).rating, B: (await this.standing(s.fighters.B)).rating };
    const done = (await update<LinkStake>(this.store, LINK_STAKE(s.id), (cur) => (cur && !cur.result && cur.status !== "done" ? { ...cur, status: "over", result: { outcome, at: now, before } } : undefined))) ?? (await this.store.get<LinkStake>(LINK_STAKE(s.id)))?.value ?? null;
    if (!done?.result) return done;
    const r = done.result;
    const score = r.outcome === "void" ? null : r.outcome === "draw" ? 0.5 : r.outcome === "a" ? 1 : 0;
    for (const role of ["A", "B"] as const) {
      const other = role === "A" ? "B" : "A";
      const mine = score === null ? null : role === "A" ? score : 1 - score;
      if (mine !== null) {
        await update<StakeStanding>(this.store, STANDING(done.fighters[role]), (cur) => {
          const w = cur ?? { rating: START, record: emptyTally(), applied: [] };
          if (w.applied.includes(done.id)) return undefined;
          const record = mine === 1 ? { ...w.record, win: w.record.win + 1 } : mine === 0 ? { ...w.record, loss: w.record.loss + 1 } : { ...w.record, draw: w.record.draw + 1 };
          return { rating: rate(r.before[role], [{ opponent: r.before[other], score: mine as 0 | 0.5 | 1 }]), record, applied: [...w.applied, done.id].slice(-50) };
        });
      }
    }
    return done;
  }

  /** Takes a stake off the books: how it left, both fighters free, off the open list. Safe to repeat. */
  private async close(s: LinkStake, how: LinkStakeClosed): Promise<LinkStake | null> {
    const done = (await update<LinkStake>(this.store, LINK_STAKE(s.id), (cur) => (cur && cur.status !== "done" ? { ...cur, status: "done", closed: how } : undefined))) ?? (await this.store.get<LinkStake>(LINK_STAKE(s.id)))?.value ?? null;
    await update<string[]>(this.store, OPEN, (cur) => (cur?.includes(s.id) ? cur.filter((x) => x !== s.id) : undefined));
    return done;
  }

  /** The cron's pass over every stake still on the books. */
  async sweep(): Promise<{ open: number; done: number }> {
    const ids = (await this.store.get<string[]>(OPEN))?.value ?? [];
    let done = 0;
    for (const id of ids) {
      try {
        const s = await this.advance(id);
        if (!s || s.status === "done") {
          if (!s) await update<string[]>(this.store, OPEN, (cur) => (cur?.includes(id) ? cur.filter((x) => x !== id) : undefined));
          done++;
        }
      } catch {
        /* the chain or the store didn't answer: next minute */
      }
    }
    return { open: ids.length - done, done };
  }

  /**
   * The staked battles that were played, newest first, for the practice page: the battle to watch, who played, and how
   * it came out. Never an amount, a wallet or a signature.
   */
  async played(limit = 60): Promise<{ match: string; at: number; fighters: Record<"A" | "B", { id: string; name: string; ticker: string }>; outcome: LinkStakeOutcome | null }[]> {
    const ids = ((await this.store.get<string[]>(PLAYED))?.value ?? []).slice(-Math.max(1, Math.min(limit, PLAYED_MAX))).reverse();
    const known = new Map<string, Fighter | null>();
    const show = async (fid: string) => {
      if (!known.has(fid)) known.set(fid, (await this.store.get<Fighter>(fighterKey(fid)))?.value ?? null);
      const f = known.get(fid);
      return { id: fid, name: f?.name ?? "A fighter", ticker: f?.ticker ?? "" };
    };
    const out = [];
    for (const id of ids) {
      const s = (await this.store.get<LinkStake>(LINK_STAKE(id)))?.value;
      if (!s?.match) continue;
      out.push({ match: s.match, at: s.createdAt, fighters: { A: await show(s.fighters.A), B: await show(s.fighters.B) }, outcome: s.result?.outcome ?? null });
    }
    return out;
  }
}
