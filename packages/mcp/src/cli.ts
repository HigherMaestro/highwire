#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serverOptionsFromEnv } from "./env.js";
import { createServer, VERSION } from "./server.js";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}
if (args.includes("--help")) {
  console.log(`highwire ${VERSION}: the MCP server for higher.fun (stdio)

Environment (all optional):
  HIGHER_API_URL     default https://api.higher.fun
  SOLANA_RPC_URL     default https://api.mainnet-beta.solana.com
  HIGHER_TIMEOUT_MS  default 15000
  HIGHER_RETRIES     default 2`);
  process.exit(0);
}

const server = createServer(serverOptionsFromEnv());

await server.connect(new StdioServerTransport());
// stdout carries the protocol, so logs go to stderr.
console.error(`highwire ${VERSION} running on stdio`);
