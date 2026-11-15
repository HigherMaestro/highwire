import type { LinkEngine } from "highwire-relay";

// Link battles' switch and engine as The Line's relay sees them (lib/line/server.ts): the engine (and the emulator in it)
// is loaded on the first link call, so pages that only use The Line never bundle it.

/** On with the Blob store's token, in preview and development; in production only with LINK_PRACTICE=1. */
export const linkConfigured = () =>
  Boolean(process.env.BLOB_READ_WRITE_TOKEN) && (process.env.VERCEL_ENV !== "production" || process.env.LINK_PRACTICE === "1");

/**
 * Where a turn's film is kept in the private Blob store (engine.ts writes it, app/api/link/film serves it): practice's
 * and rated battles' under prefixes of their own, since they're kept for different times and a rated battle's are
 * served only once it's over.
 */
export const FILMS = { practice: "link/films/", rated: "link/rated-films/" } as const;
export const filmPath = (match: string, turn: number, kind: keyof typeof FILMS = "practice") => `${FILMS[kind]}${match}/${turn}.film`;

const engine = () => import("./engine.ts").then((m) => m.linkEngine);

export const lazyLinkEngine: LinkEngine = {
  rules: async () => (await engine()).rules(),
  start: async (...args) => (await engine()).start(...args),
  move: async (...args) => (await engine()).move(...args),
  film: async (...args) => (await engine()).film!(...args),
  startMatch: async (...args) => (await engine()).startMatch!(...args),
  resolveMatch: async (...args) => (await engine()).resolveMatch!(...args),
};

/** Rated link battles (docs/link-battles.md 14.7): off until LINK_RATED=1, wherever the engine runs. */
export const linkRatedOn = () => linkConfigured() && process.env.LINK_RATED === "1";
