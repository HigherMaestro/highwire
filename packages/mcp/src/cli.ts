#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serverOptionsFromEnv } from "./env.ts";
import { createServer, VERSION } from "./server.ts";
import { localLaunchSecret, signerFromEnv } from "./signer-env.ts";
import { runClaim, runLaunch, runPolicyInit, runPost, runWallet } from "./launch-cli.ts";
import { runOrders } from "./orders-cli.ts";
import { runWatch } from "./watch.ts";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}
const io = { out: (line: string) => console.log(line), err: (line: string) => console.error(line) };
if (args[0] === "policy" && args[1] === "init") process.exit(runPolicyInit(args.slice(2), io));
if (args[0] === "wallet") process.exit(await runWallet(args.slice(1), io));
if (args[0] === "launch") process.exit(await runLaunch(args.slice(1), io));
if (args[0] === "claim") process.exit(await runClaim(args.slice(1), io));
if (args[0] === "post") process.exit(await runPost(args.slice(1), io));
if (args[0] === "watch" || args[0] === "orders") {
  const ctl = new AbortController();
  process.once("SIGINT", () => ctl.abort());
  const code = await (args[0] === "watch" ? runWatch : runOrders)(args.slice(1), {
    apiUrl: serverOptionsFromEnv().apiUrl,
    ...io,
    signal: ctl.signal,
  });
  process.exit(code);
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
  HIGHWIRE_LAUNCH_SECRET   derive launch mints from this secret (default: one kept in HIGHWIRE_HOME/launch-secret)

Local signer (off unless HIGHWIRE_KEYPAIR_PATH is set):
  HIGHWIRE_KEYPAIR_PATH    a Solana CLI keypair file; turns on the execute tools for that wallet
  HIGHWIRE_HOME            default ~/.highwire (policy.json, audit.jsonl, and the STOP kill switch)
  HIGHWIRE_POLICY_PATH     default $HIGHWIRE_HOME/policy.json

Commands:
  highwire policy init     write a starting policy: devnet, dry run, small limits
                           (--launch: mainnet launches and claims; --devnet to try it there first; --live to send)
  highwire wallet new      make your own wallet for launching (~/.highwire/wallet.json); wallet address prints it
  highwire launch          launch a coin from that wallet, inside your policy (highwire launch --help)
  highwire claim           collect the wallet's creator fees
  highwire post            post a comment on your coin, or in higher.fun's chat, inside your policy (highwire post --help)
  highwire watch           higher.fun's live feed in the terminal: launches, graduations, buys and sells
                           (highwire watch --help for the filters)
  highwire orders run      fill standing orders (stop-loss, take-profit, recurring buys, fee claims) until Ctrl-C
  highwire orders claim    claim creator fees on a schedule (--every-hours 24), and optionally buy back with them
  highwire orders list     the open orders; highwire orders cancel <id> cancels one

Without a local signer Highwire never signs: build tools return unsigned transactions and a sign_url for your own
wallet. With one, it signs only inside your policy, and only sends when the policy says "live": true.`);
  process.exit(0);
}

const signer = signerFromEnv();
// Launch mints derive from a kept secret, so a retry after a restart finds its coin instead of making a second one.
const server = createServer({ ...serverOptionsFromEnv(), launchKeySecret: localLaunchSecret(), signer });

await server.connect(new StdioServerTransport());
// stdout carries the protocol, so logs go to stderr.
console.error(`highwire ${VERSION} running on stdio${signer ? `, local signer for ${signer.wallet}` : ""}`);
