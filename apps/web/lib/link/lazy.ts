import type { LinkEngine } from "highwire-relay";

// Link battles' switch and engine as The Line's relay sees them (lib/line/server.ts): the engine (and the emulator in it)
// is loaded on the first link call, so pages that only use The Line never bundle it.

/** On with the Blob store's token, in preview and development; in production only with LINK_PRACTICE=1. */
export const linkConfigured = () =>
  Boolean(process.env.BLOB_READ_WRITE_TOKEN) && (process.env.VERCEL_ENV !== "production" || process.env.LINK_PRACTICE === "1");

const engine = () => import("./engine.ts").then((m) => m.linkEngine);

export const lazyLinkEngine: LinkEngine = {
  rules: async () => (await engine()).rules(),
  start: async (...args) => (await engine()).start(...args),
  move: async (...args) => (await engine()).move(...args),
};
