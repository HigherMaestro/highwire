import type { ArenaRules, Ending, Fallback, HouseBot, Rating, Side } from "highwire-core/arena";

// What the referee stores. Nothing here is sent as it is: responses go through view.ts, which publishes only revealed
// rounds and what a side may know about itself.

export interface Tally {
  win: number;
  draw: number;
  loss: number;
}

/** What the coin's checks said last time they were read (docs/arena.md 5). */
export interface CoinStanding {
  checkedAt: number;
  /** May be rated: always, since every Highwire launch may play (docs/arena.md 5). */
  ratedOk: boolean;
  /** Fit for a leaderboard row and a coin link: no rug flag, and its creator still holds some. */
  listedOk: boolean;
  why: string[];
}

export interface Fighter {
  /** The coin's mint: one coin, one fighter. */
  id: string;
  /** The wallet that paid for the launch, which registered it. */
  wallet: string;
  name: string;
  ticker: string;
  registeredAt: number;
  /** The maintainer's or Highwire's own coin: plays, never ranked. */
  operator: boolean;
  tokenHash: string;
  rating: Rating;
  record: { rated: Tally; house: Tally; unrated?: Tally };
  /** Distinct rated opponents off provisional status, and their owners' wallets (the cluster stand-in until clusters exist). */
  establishedOpponents: string[];
  opponentOwners: string[];
  /** Recent matches against agents, for "only the first 3 rated a week against the same fighter" and the flags. */
  recent: { opponent: string; at: number; rated?: boolean; score?: number }[];
  /** Fingerprints of its last matches' pull sequences, to flag a fighter that plays the same match again and again. */
  seqs?: string[];
  match: string | null;
  standing: CoinStanding | null;
  /** Wagering (docs/wager-mode.md 7.4): its own rating and record, apart from free play's, and its series. */
  wager?: { rating: Rating; record: Tally; series: string | null };
  /** The same on mainnet, apart: practice results never seed or touch it (docs/wager-mode.md 13). */
  wagerMainnet?: { rating: Rating; record: Tally; series: string | null };
}

/** What one side sent for the open round. Hidden until both have moved. */
export interface PendingMove {
  pull: number;
  nonce: string;
  line: string;
  arrivedAt: number;
  /** Played by the referee: the side ran out of time (or the house, which moves when the round opens). */
  fallback: boolean;
}

export interface Reveal {
  pull: number;
  nonce: string;
  line: string;
  /** How long after the round opened it arrived, in milliseconds. */
  arrivedMs: number;
  fallback: boolean;
  /** The line was taken down, for legal reasons only (the move and its commitment are untouched). */
  hidden?: boolean;
  /** SHA-256 of `match|round|side|pull|nonce`, so an agent can check its own move was recorded as sent. */
  commitment: string;
}

export interface RevealedRound {
  round: number;
  openedAt: number;
  a: Reveal;
  b: Reveal;
  winner: Side | null;
  node: number;
  energy: Record<Side, number>;
}

export interface MatchSide {
  kind: "fighter" | "house";
  /** The fighter's mint, or the house bot. */
  id: string;
  name: string;
  /** Declared when it joined; private to that side. */
  fallback: Fallback;
  /** Seconds left in its bank now. Changes when it moves, so it is never shown to the other side before a reveal. */
  bank: number;
  /** Its bank as of the last reveal: what everyone may see. */
  bankShown: number;
  bankOut: boolean;
}

export interface Match {
  id: string;
  rules: ArenaRules;
  createdAt: number;
  sides: Record<Side, MatchSide>;
  /** House matches: the bot, its side and its seed (secret until the match ends; its hash is public from the start). */
  house: { bot: HouseBot; side: Side; seedCommitment: string; seed: string; /** The house's move arrives this long after each round opens, so a match can be watched (absent before 0.14.4: at once). */ paceMs?: number } | null;
  rounds: RevealedRound[];
  open: { round: number; openedAt: number; moves: Partial<Record<Side, PendingMove>> } | null;
  ending: Ending | null;
  endedAt: number | null;
  /** Counts toward the ranking (agent against agent, both eligible); house matches never do. */
  rated: boolean;
  /** Set once the result has been applied to the fighters, so it never applies twice. */
  settled: boolean;
}

export interface Outage {
  from: number;
  to: number;
}
