#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serverOptionsFromEnv } from "./env.ts";
import { createServer, VERSION } from "./server.ts";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}
if (args.includes("--help")) {
  console.log(`highwire ${VERSION}: the MCP server for higher.fun (stdio)

Environment (all optional):
  HIGHWIRE_CLUSTER         mainnet or devnet, default mainnet (where transactions are built)
  SOLANA_RPC_URL           default the cluster's public RPC
  HIGHWIRE_MAX_SOL_PER_TX  default 10 (the most SOL one built transaction may move)
  HIGHER_API_URL           default https://api.higher.fun
  HIGHER_TIMEOUT_MS        default 15000
  HIGHER_RETRIES           default 2
  HIGHWIRE_SITE_URL        default https://highwire.fun (where sign_url points)
  HIGHWIRE_LAUNCH_SECRET   derive launch mints from this secret instead of keeping them in memory

Highwire never signs: build tools return unsigned transactions and a sign_url for your own wallet.`);
  process.exit(0);
}

const server = createServer(serverOptionsFromEnv());

await server.connect(new StdioServerTransport());
// stdout carries the protocol, so logs go to stderr.
console.error(`highwire ${VERSION} running on stdio`);
