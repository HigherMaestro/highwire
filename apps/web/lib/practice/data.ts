import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import { recentSeries, seriesHistory, WAGER_PROGRAM_IDS, type ClosedOutcome, type SeriesHistory, type SeriesSummary } from "highwire-core";
import { arenaPagesOn } from "../arena/data.ts";
import { lineRelay, wagerChain, wagerCluster } from "../line/server.ts";

// The practice pages' data (docs/wager-mode.md 7.5). Which series exist: the wager desk's index of the series it
// ticketed (only a ticketed series can open), joined with the config account's recent history on devnet, so
// transactions crowding the program's accounts can't push a series off the list. What happened in each: only the
// chain, replayed and checked in the browser. The referee adds the fighters' names.
//
// Cached in Next's data cache: a closed series never changes, so its history is kept a day; the list a minute. A read
// that fails isn't cached, and only one runs at a time per key in an instance. Devnet's public RPC throttles
// transaction reads hard, so production sets LINE_WAGER_RPC_URL to a devnet RPC of its own.

export const practiceOn = () => arenaPagesOn() && Boolean(WAGER_PROGRAM_IDS[wagerCluster()]);

/** The wager pages are never indexed, and show no stakes (docs/wager-mode.md 9.3). */
export const PRACTICE_META: Metadata = { robots: { index: false, follow: false } };

export type Names = Record<"A" | "B", { id: string; name: string; ticker: string }>;
export interface PracticeIndex {
  list: SeriesSummary[];
  names: Record<string, Names>;
}

// The pages follow the desk: devnet's series before the switch, mainnet's after.
const chain = wagerChain;

/** One read per key at a time in this instance: concurrent visits to a cold page share it. */
const inflight = new Map<string, Promise<unknown>>();
function once<T>(key: string, read: () => Promise<T>): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = read().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** The desk's word for how a series ended, in the chain's terms, for a series the config history no longer reaches. */
function deskClosed(result: { how: string; winner?: "A" | "B" | null } | null): ClosedOutcome | null {
  if (!result) return null;
  if (result.how === "settled") return { state: "closed", how: "settled", winner: result.winner ?? null };
  if (result.how === "cancelled" || result.how === "refunded") return { state: "closed", how: result.how };
  return { state: "closed", how: "unread" };
}

async function buildIndex(): Promise<PracticeIndex> {
  const desk = lineRelay()?.referee.wager ?? null;
  // Both or neither: an index built without the chain's half would be cached as if those series didn't exist.
  const [fromChain, fromDesk] = await Promise.all([recentSeries(chain(), 300), desk ? desk.ticketed(300) : Promise.resolve([])]);
  const byId = new Map(fromChain.map((s) => [s.seriesId, s]));
  const names: Record<string, Names> = {};
  for (const d of fromDesk) {
    names[d.id] = d.fighters;
    if (!byId.has(d.id)) byId.set(d.id, { seriesId: d.id, playerA: d.playerA, playerB: d.playerB, openedAt: Math.floor(d.createdAt / 1000), acceptedAt: null, closed: d.result ? { at: 0, outcome: deskClosed(d.result)! } : null });
  }
  const unnamed = [...byId.keys()].filter((id) => !names[id]);
  if (desk && unnamed.length) Object.assign(names, await desk.fighters(unnamed).catch(() => ({})));
  return { list: [...byId.values()].sort((x, y) => y.openedAt - x.openedAt), names };
}

const cachedIndex = unstable_cache(buildIndex, [`practice-index-${wagerCluster()}`], { revalidate: 60 });
export const practiceIndex = () => once("index", cachedIndex);

const closedHistory = unstable_cache(async (id: string): Promise<SeriesHistory> => seriesHistory(chain(), id), [`practice-history-closed-${wagerCluster()}`], { revalidate: 86_400 });
const liveHistory = unstable_cache(async (id: string): Promise<SeriesHistory> => seriesHistory(chain(), id), [`practice-history-live-${wagerCluster()}`], { revalidate: 10 });

/** Gives up waiting on a read that's taking too long (a throttled RPC), so a page says so instead of hanging. */
export function inTime<T>(read: Promise<T>, ms = 45_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, no) => {
    timer = setTimeout(() => no(new Error(`the chain didn't answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

/** One series' every move, or null when it isn't a practice series. Throws when the chain doesn't answer in time. */
export async function practiceHistory(id: string): Promise<{ summary: SeriesSummary; names: Names | undefined; history: SeriesHistory } | null> {
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  const index = await inTime(practiceIndex());
  const summary = index.list.find((s) => s.seriesId === id);
  if (!summary) return null;
  const history = await inTime(once(`history:${id}`, () => (summary.closed ? closedHistory(id) : liveHistory(id))));
  return { summary, names: index.names[id], history };
}

/** Where the wagers are, for the pages' copy: "Solana devnet" before the switch, "Solana" after. */
export const network = () => (wagerCluster() === "mainnet" ? "Solana" : "Solana devnet");

export const shortWallet = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

export const explorer = (address: string) => `https://explorer.solana.com/address/${address}${wagerCluster() === "devnet" ? "?cluster=devnet" : ""}`;
