import { request, type HttpConfig, type Query } from "../lib/http.js";
import type { FeeMode } from "./constants.js";

// Typed client for the public, read-only routes of https://api.higher.fun.
// Amounts are strings: SOL amounts in lamports, token amounts in base units
// (6 decimals), prices in SOL per whole token.

export interface Page<T> {
  items: T[];
  nextCursor?: string | null;
}

export interface Coin {
  mint: string;
  name: string;
  ticker: string;
  imageUri: string | null;
  creator: string;
  status: "curve" | "graduated";
  createdAt: string;
  lastPrice: string | null;
  marketCap: string | null;
  volume24h: string | null;
  raised: string | null;
  target: string | null;
  replyCount: number;
  lastTradeAt: string | null;
  trustGrade: string | null;
}

export interface SafetyWallet {
  wallet: string;
  heldBps: number;
}

export interface CoinSafety {
  score: number;
  grade: string;
  lock?: {
    status: string;
    lockedAmount: string;
    lockedBps: number;
    cliffSeconds: number;
    unlockSeconds: number;
    graduatedAt: string | null;
    unlocksAt: string | null;
  } | null;
  snipers?: { count: number; heldBps: number; wallets: SafetyWallet[] } | null;
  bundles?: { slot: string; wallets: SafetyWallet[] }[] | null;
  bundleHeldBps?: number | null;
  dev?: {
    buys: number;
    sells: number;
    boughtTokens: string;
    soldTokens: string;
    soldEarlyBps: number;
    heldBps: number;
    stillHolds: boolean;
    earlyMinutes: number;
  } | null;
  reasons?: string[];
}

export interface CoinDetail extends Coin {
  description: string | null;
  website: string | null;
  x: string | null;
  telegram: string | null;
  metadataUri: string | null;
  poolId: string | null;
  creatorHoldingBps: number | null;
  top10HoldingBps: number | null;
  tickerFlagged: boolean;
  indexedSlot: string | null;
  safety: CoinSafety | null;
  feeMode: FeeMode | null;
}

export interface Trade {
  signature: string;
  mint: string;
  wallet: string;
  side: "buy" | "sell";
  quoteAmount: string;
  tokenAmount: string;
  price: string;
  blockTime: string;
}

export interface Holder {
  wallet: string;
  balance: string;
  shareBps: number;
  isCreator: boolean;
  isCurve: boolean;
}

export interface Candle {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface Comment {
  id: string;
  mint: string;
  wallet: string;
  displayName: string | null;
  body: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  wallet: string;
  displayName: string | null;
  body: string;
  createdAt: string;
}

export interface TapeEntry {
  id: string;
  kind: "new" | "buy" | "sell" | "graduated";
  mint: string;
  ticker: string;
  quoteAmount?: string;
  price?: string;
  at: string;
}

export interface RankedCoin extends Coin {
  windowTrades: number;
  windowVolume: string;
  rank: number;
}

export interface LeaderboardRow {
  rank: number;
  wallet: string;
  displayName: string | null;
  volume?: string;
  trades?: number;
  [key: string]: unknown;
}

export interface UserProfile {
  wallet: string;
  displayName: string | null;
  avatarUri: string | null;
  bio: string | null;
  createdAt: string | null;
}

export interface Earnings {
  wallet: string;
  paidOut: string;
  pendingPayout: string;
}

export interface CreatorLock {
  mint: string;
  name: string;
  ticker: string;
  status: string;
  lockedAmount: string;
  cliffSeconds: number;
  unlockSeconds: number;
  graduatedAt: string | null;
  unlocksAt: string | null;
}

const enc = encodeURIComponent;

export class HigherApi {
  constructor(private readonly http: HttpConfig) {}

  private get<T>(path: string, query?: Query): Promise<T> {
    return request<T>(this.http, { path, query });
  }

  listCoins(opts: { sort?: string; cursor?: string; limit?: number } = {}) {
    return this.get<Page<Coin>>("/coins", opts);
  }
  search(q: string) {
    return this.get<Page<Coin>>("/search", { q });
  }
  coin(mint: string) {
    return this.get<CoinDetail>(`/coins/${enc(mint)}`);
  }
  trades(mint: string, cursor?: string) {
    return this.get<Page<Trade>>(`/coins/${enc(mint)}/trades`, { cursor });
  }
  holders(mint: string) {
    return this.get<Page<Holder>>(`/coins/${enc(mint)}/holders`);
  }
  candles(mint: string, interval: string) {
    return this.get<Page<Candle>>(`/coins/${enc(mint)}/candles`, { interval });
  }
  comments(mint: string, cursor?: string) {
    return this.get<Page<Comment>>(`/coins/${enc(mint)}/comments`, { cursor });
  }
  highest() {
    return this.get<Coin & { highest?: boolean }>("/coins/highest");
  }
  tape() {
    return this.get<Page<TapeEntry>>("/tape");
  }
  topCoins(window: string) {
    return this.get<{ window: string; items: RankedCoin[] }>("/leaderboard/coins", { window });
  }
  leaderboard(kind: string, window: string) {
    return this.get<{ kind: string; window: string; items: LeaderboardRow[] }>("/leaderboard", { kind, window });
  }
  chat(before?: string) {
    return this.get<Page<ChatMessage>>("/chat", { before });
  }
  user(wallet: string) {
    return this.get<UserProfile>(`/users/${enc(wallet)}`);
  }
  userCoins(wallet: string, cursor?: string) {
    return this.get<Page<Coin>>(`/users/${enc(wallet)}/coins`, { cursor });
  }
  earnings(wallet: string) {
    return this.get<Earnings>(`/users/${enc(wallet)}/earnings`);
  }
  locks(wallet: string) {
    return this.get<Page<CreatorLock>>(`/users/${enc(wallet)}/locks`);
  }
  solPrice() {
    return this.get<{ usd: number }>("/sol-price");
  }
  launchFee() {
    return this.get<{ lamports: string; treasury: string | null }>("/launch-fee");
  }
  ticker(ticker: string) {
    return this.get<{ available: boolean }>(`/tickers/${enc(ticker)}`);
  }
}
