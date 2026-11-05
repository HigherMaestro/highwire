#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serverOptionsFromEnv } from "./env.ts";
import { createServer, VERSION } from "./server.ts";
import { initPolicy, signerFromEnv } from "./signer-env.ts";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}
if (args[0] === "policy" && args[1] === "init") {
  const { path, written } = initPolicy();
  console.log(written ? `Wrote a starting policy to ${path}: devnet, dry run, trades and claims, 0.1 SOL a transaction, 0.5 SOL a day.\nEdit it to change the limits; set "live": true only when you want it to send.` : `A policy already exists at ${path}; left it as it is.`);
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

Local signer (off unless HIGHWIRE_KEYPAIR_PATH is set):
  HIGHWIRE_KEYPAIR_PATH    a Solana CLI keypair file; turns on the execute tools for that wallet
  HIGHWIRE_HOME            default ~/.highwire (policy.json, audit.jsonl, and the STOP kill switch)
  HIGHWIRE_POLICY_PATH     default $HIGHWIRE_HOME/policy.json

Commands:
  highwire policy init     write a starting policy: devnet, dry run, small limits

Without a local signer Highwire never signs: build tools return unsigned transactions and a sign_url for your own
wallet. With one, it signs only inside your policy, and only sends when the policy says "live": true.`);
  process.exit(0);
}

const signer = signerFromEnv();
const server = createServer({ ...serverOptionsFromEnv(), signer });

await server.connect(new StdioServerTransport());
// stdout carries the protocol, so logs go to stderr.
console.error(`highwire ${VERSION} running on stdio${signer ? `, local signer for ${signer.wallet}` : ""}`);
