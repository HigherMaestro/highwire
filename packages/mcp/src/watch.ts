import { parseArgs } from "node:util";
import { LIVE_EVENT_KINDS, LiveFeed, liveUrlFor, MAX_LIVE_MINTS, type LiveEvent, type LiveEventKind, type LiveFilter } from "highwire-core";

// `highwire watch`: higher.fun's live feed in the terminal, one line an event (or JSON lines), until Ctrl-C.

export const WATCH_USAGE = `highwire watch: higher.fun's live feed, one line an event, until Ctrl-C

  --launches --graduations --buys --sells   what to show (default all four)
  --mint <mint>                             only this coin's trades and graduations, with the wallet (repeat, up to ${MAX_LIVE_MINTS})
  --min-sol <sol>                           only buys and sells of at least this much SOL
  --json                                    one JSON object a line instead`;

const FLAG_KINDS: Record<string, LiveEventKind> = { launches: "launch", graduations: "graduation", buys: "buy", sells: "sell" };
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function parseWatchArgs(argv: string[]): { filter: LiveFilter; json: boolean } | { error: string } {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        launches: { type: "boolean" },
        graduations: { type: "boolean" },
        buys: { type: "boolean" },
        sells: { type: "boolean" },
        mint: { type: "string", multiple: true },
        "min-sol": { type: "string" },
        json: { type: "boolean" },
      },
      strict: true,
    }));
  } catch (err) {
    return { error: (err as Error).message };
  }
  const chosen = Object.entries(FLAG_KINDS).filter(([flag]) => values[flag as keyof typeof values]).map(([, kind]) => kind);
  const mints = values.mint ?? [];
  const bad = mints.find((m) => !BASE58.test(m));
  if (bad !== undefined) return { error: `not a mint address: ${bad}` };
  if (mints.length > MAX_LIVE_MINTS) return { error: `at most ${MAX_LIVE_MINTS} mints` };
  let minSol: number | undefined;
  if (values["min-sol"] !== undefined) {
    minSol = Number(values["min-sol"]);
    if (!Number.isFinite(minSol) || minSol < 0) return { error: `--min-sol must be a number of SOL, not ${values["min-sol"]}` };
  }
  return {
    filter: { kinds: chosen.length ? chosen : [...LIVE_EVENT_KINDS], ...(mints.length ? { mints } : {}), ...(minSol !== undefined ? { minSol } : {}) },
    json: values.json ?? false,
  };
}

/** Creator-written text for a terminal: no control characters (escape sequences) or direction overrides, kept short. */
export function terminalSafe(text: string, max = 32): string {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, "");
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

export function formatLiveEvent(e: LiveEvent): string {
  const time = e.at.slice(11, 19);
  switch (e.kind) {
    case "launch":
      return `${time}  LAUNCH     ${terminalSafe(e.ticker, 16)} "${terminalSafe(e.name)}"  ${e.mint}  by ${short(e.creator)}`;
    case "graduation":
      return `${time}  GRADUATED  ${e.mint}  pool ${e.poolId}`;
    default: {
      const sol = e.sol === null ? "?" : e.sol.toFixed(4);
      const who = e.wallet ? `  ${short(e.wallet)}` : "";
      const coin = e.ticker !== undefined ? `${terminalSafe(e.ticker, 16)}  ` : "";
      return `${time}  ${e.kind.toUpperCase().padEnd(9)}  ${sol.padStart(10)} SOL  ${coin}${e.mint}${who}`;
    }
  }
}

export interface WatchIo {
  apiUrl?: string;
  out: (line: string) => void;
  err: (line: string) => void;
  signal: AbortSignal;
  feed?: LiveFeed;
}

/** Runs until `signal` aborts. Returns the exit code. */
export async function runWatch(argv: string[], io: WatchIo): Promise<number> {
  if (argv.includes("--help")) {
    io.out(WATCH_USAGE);
    return 0;
  }
  const parsed = parseWatchArgs(argv);
  if ("error" in parsed) {
    io.err(`highwire watch: ${parsed.error}\n\n${WATCH_USAGE}`);
    return 2;
  }
  const { filter, json } = parsed;
  const feed = io.feed ?? new LiveFeed(liveUrlFor(io.apiUrl));
  const what = filter.kinds.join(", ") + (filter.mints ? ` on ${filter.mints.length} coin${filter.mints.length > 1 ? "s" : ""}` : "") + (filter.minSol !== undefined ? `, ${filter.minSol} SOL and up` : "");
  try {
    await feed.watch(filter, (e) => io.out(json ? JSON.stringify(e) : formatLiveEvent(e)), {
      signal: io.signal,
      onStatus: (s) => io.err(s === "open" ? `Watching ${what} on ${feed.url} (Ctrl-C to stop)` : s === "reconnecting" ? "The feed dropped; reconnecting…" : `Connecting to ${feed.url}…`),
    });
  } catch (err) {
    io.err(`highwire watch: ${(err as Error).message}`);
    return 1;
  }
  return 0;
}
