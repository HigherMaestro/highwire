import { get } from "@vercel/blob";
import { BattleError, FORMAT, linkRules, type MatchState, practiceMove, practiceStart, RIG_VERSION, type PracticeStep } from "highwire-link";
import { RelayError, type LinkEngine, type LinkStep } from "highwire-relay";

// Link battles' engine for the referee (docs/link-battles.md 8.3): highwire-link's practice steps over the game and the
// starting battle from the private Blob store. The relay never imports the emulator; this file hands it in.
//
// The emulator is one per process, so steps run one at a time here, whatever else the instance is serving. The files
// are read once per instance. lazy.ts switches it on (LINK_PRACTICE) and loads this file on the first link call.

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

/** One step at a time per process: the emulator is a single instance. */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(step: () => Promise<T>): Promise<T> {
  const next = queue.then(step, step);
  queue = next.catch(() => undefined);
  return next;
}

const toStep = (s: PracticeStep): LinkStep => ({ state: s.state, packed: s.packed, view: s.view, spectator: s.spectator, turn: s.turn, ended: s.ended, format: FORMAT, version: RIG_VERSION });

async function guarded(step: () => Promise<PracticeStep>): Promise<LinkStep> {
  try {
    return toStep(await exclusive(step));
  } catch (err) {
    if (err instanceof BattleError && err.kind === "illegal") throw new RelayError("bad_request", err.message);
    if (err instanceof Error && /another version of the rig/.test(err.message)) throw new RelayError("expired", "Highwire's rig was updated since this battle started; start another.");
    console.error("link: a step failed", err);
    throw new RelayError("paused", "The battle couldn't be run just now; try again shortly.");
  }
}

/** An engine over files from `files` (the Blob store here; the disk in scripts/link-practice.ts). */
export function createLinkEngine(files: () => Promise<LinkFiles>): LinkEngine {
  const get = () =>
    files().catch(() => {
      throw new RelayError("paused", "Link battles' files aren't reachable right now; try again shortly.");
    });
  return {
    rules: async () => linkRules(),
    start: async (agent, labels) => {
      const f = await get();
      return guarded(() => practiceStart(f.rom, f.bootstrap, agent, labels));
    },
    move: async (state, packed, agent, action, labels) => {
      const f = await get();
      return guarded(() => practiceMove(f.rom, state as MatchState, packed, agent, action, labels));
    },
  };
}

export const linkEngine = createLinkEngine(load);

