// highwire-wager/chain: what reads and builds wager series on-chain, with nothing that needs a signer, a daemon or the
// MCP server. The site's wager pages import this, so it may reach only highwire-core and web3.js.
export * from "./tx.ts";
export * from "./history.ts";
