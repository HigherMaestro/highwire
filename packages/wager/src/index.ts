// highwire-wager: wagers on The Line (docs/wager-mode.md), kept out of every other Highwire package
// (docs/boundaries.md). `registerWagerTools` is what highwire-mcp's createServer takes as `wagers`; the bin runs that
// server over stdio, and `highwire-wager run` is the reveal daemon.
export * from "./chain.ts";
export * from "./line-cli.ts";
export * from "./runner.ts";
export * from "./secrets.ts";
export { registerWagerTools, wagerView } from "./tools.ts";
