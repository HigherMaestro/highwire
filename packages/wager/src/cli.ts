#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, localLaunchSecret, serverOptionsFromEnv, signerFromEnv, VERSION } from "highwire-mcp";
import { LINE_USAGE, runLine } from "./line-cli.ts";
import { registerWagerTools } from "./tools.ts";

// highwire-wager: Highwire's MCP server with The Line's wager tools, and the reveal daemon. Running this instead of
// highwire-mcp is how an owner turns wagering on (docs/boundaries.md 5.2): the same server, environment and policy,
// plus line_stake, line_wagers and `series` on the three shared play tools.

const args = process.argv.slice(2);
const io = { out: (line: string) => console.log(line), err: (line: string) => console.error(line) };

if (args.includes("--version")) {
  io.out(VERSION);
  process.exit(0);
}
if (args[0] === "run" || args[0] === "series") {
  const ctl = new AbortController();
  process.once("SIGINT", () => ctl.abort());
  process.exit(await runLine(args, { ...io, signal: ctl.signal }));
}
if (args.includes("--help") || args.length) {
  io.out(`highwire-wager ${VERSION}: Highwire's MCP server (stdio) with The Line's wager tools

  highwire-wager           the server: everything highwire-mcp serves, plus line_stake, line_wagers and staked series
${LINE_USAGE.split("\n").slice(1).join("\n")}

Environment: as for highwire-mcp (npx -y highwire-mcp --help). Staking needs the local signer (HIGHWIRE_KEYPAIR_PATH),
"wager" in the policy's actions with a wagers section, and the reveal daemon running for the same wallet.`);
  process.exit(args.includes("--help") ? 0 : 2);
}

const signer = signerFromEnv();
const server = createServer({ ...serverOptionsFromEnv(), launchKeySecret: localLaunchSecret(), signer, wagers: registerWagerTools });
await server.connect(new StdioServerTransport());
// stdout carries the protocol, so logs go to stderr.
console.error(`highwire-wager ${VERSION} running on stdio${signer ? `, local signer for ${signer.wallet}` : ", no local signer: the wager tools need one"}`);
