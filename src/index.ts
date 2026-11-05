#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, VERSION } from "./server.js";

function numberEnv(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${v}"`);
  return n;
}

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

const server = createServer({
  apiUrl: process.env.HIGHER_API_URL || undefined,
  rpcUrl: process.env.SOLANA_RPC_URL || undefined,
  timeoutMs: numberEnv("HIGHER_TIMEOUT_MS"),
  retries: numberEnv("HIGHER_RETRIES"),
});

await server.connect(new StdioServerTransport());
// stdout carries the protocol, so logs go to stderr.
console.error(`highwire ${VERSION} running on stdio`);
