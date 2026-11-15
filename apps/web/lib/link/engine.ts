import { del, get, list, put } from "@vercel/blob";
import { BattleError, type FilmJob, filmTurn, FORMAT, linkRules, type MatchState, practiceMove, practiceStart, ratedResolve, ratedStart, type RatedStep, RIG_VERSION, type PracticeStep, trainerName, type Action } from "highwire-link";
import { RelayError, type LinkEngine, type LinkMatchStep, type LinkStep } from "highwire-relay";
import { FILMS, filmPath } from "./lazy.ts";

// Link battles' engine for the referee (docs/link-battles.md 8.3): highwire-link's practice steps over the game and the
// starting battle from the private Blob store. The relay never imports the emulator; this file hands it in.
//
// The emulator is one per process, so steps run one at a time here, whatever else the instance is serving, and films
// (13.3: each turn played again with both screens drawn, after the answer) only when no step is waiting. The files are
// read once per instance. lazy.ts switches it on (LINK_PRACTICE) and loads this file on the first link call.

/** Where the files are in the store: the game, and the battle every practice starts from (both games' states). */
const GAME = "link/game.gbc";
const bootstrapPrefix = () => process.env.LINK_BOOTSTRAP?.trim() || "link/colosseum-1";


export type LinkFiles = { rom: Uint8Array; bootstrap: [Uint8Array, Uint8Array] };
type Files = LinkFiles;
let files: Promise<Files> | null = null;

async function read(pathname: string): Promise<Uint8Array> {
  const blob = await get(pathname, { access: "private" });
  if (!blob) throw new Error(`${pathname} isn't in the store`);
  return new Uint8Array(await new Response(blob.stream).arrayBuffer());
}

function load(): Promise<Files> {
  files ??= (async () => {
    const prefix = bootstrapPrefix();
    const [rom, a, b] = await Promise.all([read(GAME), read(`${prefix}/side0.state`), read(`${prefix}/side1.state`)]);
    return { rom, bootstrap: [a, b] as [Uint8Array, Uint8Array] };
  })().catch((err: unknown) => {
    files = null;
    throw err;
  });
  return files;
}

/** One task at a time per process (the emulator is a single instance), steps before films: an agent never waits on one. */
const waiting = { step: [] as (() => void)[], film: [] as (() => void)[] };
let busy = false;
function pump() {
  if (busy) return;
  const next = waiting.step.shift() ?? waiting.film.shift();
  if (!next) return;
  busy = true;
  next();
}
function exclusive<T>(task: () => Promise<T>, kind: "step" | "film" = "step"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    waiting[kind].push(() => {
      task()
        .then(resolve, reject)
        .finally(() => {
          busy = false;
          pump();
        });
    });
    pump();
  });
}

/** Films are kept a while past their battle's page (an hour after its last move), then swept. */
const FILM_KEEP_MS = 3 * 3_600_000;
let swept = 0;

/** Where films are kept: the private Blob store on the site, a folder in scripts/link-practice.ts. */
export interface FilmStore {
  put(pathname: string, bytes: Uint8Array): Promise<void>;
  /** Deletes old films; called after a battle starts. */
  sweep(): Promise<void>;
}

/** Deletes films older than FILM_KEEP_MS; run at most hourly per instance. */
async function sweepBlobFilms() {
  if (Date.now() - swept < 3_600_000) return;
  swept = Date.now();
  const old: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: FILMS, cursor, limit: 1000 });
    for (const b of page.blobs) if (Date.now() - b.uploadedAt.getTime() > FILM_KEEP_MS) old.push(b.url);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor && old.length < 5000);
  for (let i = 0; i < old.length; i += 500) await del(old.slice(i, i + 500));
}

const toStep = (s: PracticeStep): LinkStep => ({ state: s.state, packed: s.packed, view: s.view, spectator: s.spectator, turn: s.turn, ended: s.ended, format: FORMAT, version: RIG_VERSION, film: s.film });

const toMatchStep = (s: RatedStep): LinkMatchStep => ({ ...s, format: FORMAT, version: RIG_VERSION });

async function guarded(step: () => Promise<PracticeStep>): Promise<LinkStep> {
  return guard(async () => toStep(await exclusive(step)));
}

/** Runs a step, turning the engine's errors into the referee's: an illegal action, a battle from another rig, a failure. */
async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof BattleError && err.kind === "illegal") throw new RelayError("bad_request", err.message);
    if (err instanceof Error && /another version of the rig/.test(err.message)) throw new RelayError("expired", "Highwire's rig was updated since this battle started; start another.");
    console.error("link: a step failed", err);
    throw new RelayError("paused", "The battle couldn't be run just now; try again shortly.");
  }
}

const blobFilms: FilmStore = {
  put: async (pathname, bytes) => {
    await put(pathname, Buffer.from(bytes), { access: "private", contentType: "application/octet-stream", addRandomSuffix: false, allowOverwrite: true });
  },
  sweep: sweepBlobFilms,
};

/** An engine over files from `files` (the Blob store here; the disk in scripts/link-practice.ts), keeping films in `films`. */
export function createLinkEngine(files: () => Promise<LinkFiles>, films: FilmStore = blobFilms): LinkEngine {
  const get = () =>
    files().catch(() => {
      throw new RelayError("paused", "Link battles' files aren't reachable right now; try again shortly.");
    });
  return {
    rules: async () => linkRules(),
    start: async (agent, labels, trainers) => {
      const f = await get();
      return guarded(() => practiceStart(f.rom, f.bootstrap, agent, labels, trainers && names(trainers)));
    },
    startMatch: async (sides, labels, trainers) => {
      const f = await get();
      return guard(async () => toMatchStep(await exclusive(() => ratedStart(f.rom, f.bootstrap, sides, labels, names(trainers)))));
    },
    resolveMatch: async (state, packed, decisions, sides, labels) => {
      const f = await get();
      return guard(async () => toMatchStep(await exclusive(() => ratedResolve(f.rom, state as MatchState, packed, decisions as [Action | null, Action | null], sides, labels))));
    },
    move: async (state, packed, agent, action, labels) => {
      const f = await get();
      return guarded(() => practiceMove(f.rom, state as MatchState, packed, agent, action, labels));
    },
    film: async (match, film) => {
      const f = await get();
      for (const job of film as FilmJob[]) {
        const bytes = await exclusive(() => filmTurn(f.rom, f.bootstrap, job), "film");
        if (!bytes) {
          console.error(`link: ${match} turn ${job.turn} came out differently when filmed; no film`);
          continue;
        }
        await films.put(filmPath(match, job.turn), bytes);
      }
      if ((film as FilmJob[]).some((j) => j.turn === 0)) await films.sweep();
    },
  };
}


/** What the game can show of each name (a ticker is creator content): letters, digits and spaces, seven at most. */
const names = (t: readonly [string, string]): [string, string] => [trainerName(t[0], "AGENT"), trainerName(t[1], "AGENT")];

export const linkEngine = createLinkEngine(load);

