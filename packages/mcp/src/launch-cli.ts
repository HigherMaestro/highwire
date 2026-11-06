import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { agentPaths, createKeypairFile, LAUNCH_POLICY_TEMPLATE } from "highwire-agent";
import { serverOptionsFromEnv } from "./env.ts";
import { createServer } from "./server.ts";
import { initPolicy, localLaunchSecret, signerFromEnv } from "./signer-env.ts";

// `highwire wallet new`, `highwire launch` and `highwire claim`: an agent with a shell launches coins and collects their
// fees from its own wallet, with no one in the loop once it's set up. launch and claim call execute_launch and
// execute_claim on an in-process server, so they run the same code as the tools: the policy, the kill switch, the
// sign-in and uploads, simulation and the audit log.

type Env = Record<string, string | undefined>;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env?: Env;
}

export const WALLET_USAGE = `highwire wallet: the agent's own wallet, for launching and claiming

  highwire wallet new       make ~/.highwire/wallet.json (readable only by you) and print its address to fund
  highwire wallet address   print the address

It never overwrites a wallet and never prints the key. launch and claim use it unless HIGHWIRE_KEYPAIR_PATH names another.`;

export const LAUNCH_USAGE = `highwire launch: launch a coin on higher.fun from your own wallet, inside your policy

  --name <name>          the coin's name, up to 32 characters (required)
  --ticker <ticker>      1-10 letters or digits, without the $ (required)
  --image <file>         PNG, JPEG, GIF or WebP, up to 4 MB, uploaded to higher.fun (required, or --metadata-uri)
  --description <text>   up to 500 characters
  --mode <mode>          rewards (New school, the default) or classic (Old school)
  --buy <sol>            a first buy, in the same transaction
  --slippage-bps <bps>   for the first buy, default 500
  --lock-pct <pct>       New school only: lock this % of supply for the creator
  --website <url>  --x <url>  --telegram <url>
  --metadata-uri <url>   metadata already hosted, instead of --image
  --key <key>            idempotency key; by default one from the wallet, name, ticker and mode, so a retry
                         finds its coin instead of making a second
  --json                 print the result as JSON

Needs a policy that allows launches on mainnet: \`highwire policy init --launch\` writes one. It costs higher.fun's
launch fee (0.02 SOL) plus the first buy, plus about 0.025 SOL of rent and network fees. The creator fees go to your wallet;
\`highwire claim\` collects them.`;

export const CLAIM_USAGE = `highwire claim: collect your wallet's creator fees, inside your policy

  --json   print the result as JSON

Needs a policy that allows claims ("claim" in its actions).`;

/** The signer for the CLI: HIGHWIRE_KEYPAIR_PATH, else the wallet \`highwire wallet new\` made. */
function cliEnv(env: Env): Env {
  if (env.HIGHWIRE_KEYPAIR_PATH?.trim()) return env;
  const wallet = agentPaths(env).wallet;
  return existsSync(wallet) ? { ...env, HIGHWIRE_KEYPAIR_PATH: wallet } : env;
}

/** Calls one execute tool on an in-process server with the CLI's signer. */
async function callTool(env: Env, io: CliIo, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; body: Record<string, unknown> } | null> {
  const e = cliEnv(env);
  const signer = signerFromEnv(e, io.err);
  if (!signer) {
    io.err(`No wallet: run \`highwire wallet new\` (or set HIGHWIRE_KEYPAIR_PATH to a Solana CLI keypair file).`);
    return null;
  }
  // readCoinImage refuses the keypair file by this name, wherever it is.
  if (e.HIGHWIRE_KEYPAIR_PATH) process.env.HIGHWIRE_KEYPAIR_PATH = e.HIGHWIRE_KEYPAIR_PATH;
  const server = createServer({ ...serverOptionsFromEnv(e), launchKeySecret: localLaunchSecret(e), signer });
  const client = new Client({ name: "highwire-cli", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? "{}";
    return { ok: !res.isError, body: JSON.parse(text) as Record<string, unknown> };
  } finally {
    await client.close();
  }
}

const HTTP_LINK = /^https?:\/\//;

export function parseLaunchArgs(argv: string[]): { args: Record<string, unknown>; json: boolean; key?: string } | { error: string } {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        name: { type: "string" },
        ticker: { type: "string" },
        image: { type: "string" },
        description: { type: "string" },
        mode: { type: "string" },
        buy: { type: "string" },
        "slippage-bps": { type: "string" },
        "lock-pct": { type: "string" },
        website: { type: "string" },
        x: { type: "string" },
        telegram: { type: "string" },
        "metadata-uri": { type: "string" },
        key: { type: "string" },
        json: { type: "boolean" },
      },
      strict: true,
    }));
  } catch (err) {
    return { error: (err as Error).message };
  }
  if (!values.name) return { error: "give --name" };
  if (!values.ticker) return { error: "give --ticker" };
  if (!values.image && !values["metadata-uri"]) return { error: "give --image (or --metadata-uri), so the coin has a picture" };
  const mode = values.mode ?? "rewards";
  if (mode !== "rewards" && mode !== "classic") return { error: `--mode is rewards or classic, not ${mode}` };
  const num = (v: string | undefined, int = false) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && (!int || Number.isInteger(n)) ? n : NaN;
  };
  const buy = num(values.buy), slip = num(values["slippage-bps"], true), lock = num(values["lock-pct"], true);
  for (const [flag, n] of [["--buy", buy], ["--slippage-bps", slip], ["--lock-pct", lock]] as const) {
    if (Number.isNaN(n)) return { error: `${flag} must be a ${flag === "--buy" ? "number of SOL" : "whole number"}` };
  }
  for (const flag of ["website", "x", "telegram", "metadata-uri"] as const) {
    if (values[flag] !== undefined && !HTTP_LINK.test(values[flag]!)) return { error: `--${flag} must be an http(s) link` };
  }
  return {
    args: {
      name: values.name,
      ticker: values.ticker.replace(/^\$/, ""),
      fee_mode: mode,
      ...(values.image ? { image_path: resolve(values.image) } : {}),
      ...(values["metadata-uri"] ? { metadata_uri: values["metadata-uri"] } : {}),
      ...(values.description !== undefined ? { description: values.description } : {}),
      ...(buy ? { dev_buy_sol: buy } : {}),
      ...(slip !== undefined ? { max_slippage_bps: slip } : {}),
      ...(lock !== undefined ? { creator_lock_pct: lock } : {}),
      ...(values.website ? { website: values.website } : {}),
      ...(values.x ? { x: values.x } : {}),
      ...(values.telegram ? { telegram: values.telegram } : {}),
      confirm_launch: true,
    },
    json: values.json ?? false,
    ...(values.key ? { key: values.key } : {}),
  };
}

/** The default idempotency key: the same coin from the same wallet always gets the same key, so a retry can't launch it twice. */
export const defaultLaunchKey = (wallet: string, name: string, ticker: string, mode: string) =>
  "cli-" + createHash("sha256").update(`highwire launch|${wallet}|${name}|${ticker.toUpperCase()}|${mode}`).digest("hex").slice(0, 32);

type Tx = { signature?: string; explorer?: string; label?: string };

function printFailure(io: CliIo, what: string, body: Record<string, unknown>) {
  io.err(`highwire ${what}: ${String(body.error ?? "failed")}${body.code ? ` (${String(body.code)})` : ""}`);
  if (body.next_step) io.err(String(body.next_step));
}

export async function runLaunch(argv: string[], io: CliIo): Promise<number> {
  if (argv.includes("--help")) {
    io.out(LAUNCH_USAGE);
    return 0;
  }
  const parsed = parseLaunchArgs(argv);
  if ("error" in parsed) {
    io.err(`highwire launch: ${parsed.error}\n\n${LAUNCH_USAGE}`);
    return 2;
  }
  const env = io.env ?? process.env;
  const e = cliEnv(env);
  const { args } = parsed;
  // The default key is derived from the wallet's address.
  const wallet = e.HIGHWIRE_KEYPAIR_PATH ? signerFromEnv(e, () => {})?.wallet : undefined;
  const key = parsed.key ?? (wallet ? defaultLaunchKey(wallet, String(args.name), String(args.ticker), String(args.fee_mode)) : "unused-no-wallet");
  const r = await callTool(env, io, "execute_launch", { ...args, idempotency_key: key });
  if (!r) return 1;
  if (parsed.json) io.out(JSON.stringify(r.body, null, 2));
  if (!r.ok) {
    if (!parsed.json) printFailure(io, "launch", r.body);
    return 1;
  }
  if (parsed.json) return 0;
  const b = r.body;
  const ticker = `$${String(args.ticker).toUpperCase()}`;
  const url = `https://higher.fun/coin/${String(b.mint)}`;
  if (b.status === "already_launched") {
    io.out(`${ticker} was already launched with this key: ${String(b.url ?? url)}. Nothing was sent.`);
    return 0;
  }
  const fee = (b.launchFee as { sol?: number } | null | undefined)?.sol ?? 0;
  const cost = `${fee} SOL launch fee${b.devBuySol ? ` + ${String(b.devBuySol)} SOL first buy` : ""}`;
  if (b.status === "dry_run") {
    io.out(`Dry run: the policy isn't live, so nothing was signed or sent. It would launch ${ticker} at ${String(b.mint)} for ${cost}.`);
    io.out(`Set "live": true in your policy to launch for real.`);
    return 0;
  }
  io.out(`${b.status === "sent" ? "Launched" : String(b.status)} ${ticker}: ${url}`);
  io.out(`Cost ${cost}. The creator fees go to your wallet ${String(b.wallet)}; \`highwire claim\` collects them.`);
  for (const t of (b.transactions as Tx[] | undefined) ?? []) if (t.explorer) io.out(`  ${t.explorer}`);
  return b.status === "sent" ? 0 : 1;
}

export async function runClaim(argv: string[], io: CliIo): Promise<number> {
  if (argv.includes("--help")) {
    io.out(CLAIM_USAGE);
    return 0;
  }
  const unknown = argv.find((a) => a !== "--json");
  if (unknown) {
    io.err(`highwire claim: unknown argument ${unknown}\n\n${CLAIM_USAGE}`);
    return 2;
  }
  const json = argv.includes("--json");
  const r = await callTool(io.env ?? process.env, io, "execute_claim", {});
  if (!r) return 1;
  if (json) {
    io.out(JSON.stringify(r.body, null, 2));
    return r.ok ? 0 : 1;
  }
  if (!r.ok) {
    printFailure(io, "claim", r.body);
    return 1;
  }
  const b = r.body;
  if (b.note) {
    io.out(String(b.note));
    return 0;
  }
  if (b.status === "dry_run") io.out(`Dry run: the policy isn't live, so nothing was signed or sent. ${String(b.summary ?? "")}`.trim());
  else io.out(`${b.status === "sent" ? "Claimed" : String(b.status)}: ${String(b.summary ?? "")}`.trim());
  for (const t of (b.transactions as Tx[] | undefined) ?? []) if (t.explorer) io.out(`  ${t.explorer}`);
  return b.status === "sent" || b.status === "dry_run" ? 0 : 1;
}

export async function runWallet(argv: string[], io: CliIo): Promise<number> {
  const env = io.env ?? process.env;
  const path = env.HIGHWIRE_KEYPAIR_PATH?.trim() || agentPaths(env).wallet;
  if (argv[0] === "new") {
    const { address, written } = createKeypairFile(path);
    io.out(written ? `Made a wallet at ${path} (readable only by you). Its address:\n${address}\nSend it SOL to launch: about 0.05 SOL a launch, plus any first buy.` : `A wallet already exists at ${path}; left it as it is. Its address:\n${address}`);
    return 0;
  }
  if (argv[0] === "address") {
    if (!existsSync(path)) {
      io.err(`No wallet at ${path}: run \`highwire wallet new\`.`);
      return 1;
    }
    const signer = signerFromEnv({ ...env, HIGHWIRE_KEYPAIR_PATH: path }, () => {});
    io.out(signer!.wallet);
    return 0;
  }
  io.out(WALLET_USAGE);
  return argv.length === 0 || argv[0] === "--help" ? 0 : 2;
}

/** `highwire policy init [--launch] [--live]`. */
export function runPolicyInit(argv: string[], io: CliIo): number {
  const launch = argv.includes("--launch"), live = argv.includes("--live");
  const unknown = argv.find((a) => a !== "--launch" && a !== "--live");
  if (unknown) {
    io.err(`highwire policy init: unknown argument ${unknown} (use --launch, --live)`);
    return 2;
  }
  const paths = agentPaths(io.env ?? process.env);
  if (live && !launch) {
    io.err("highwire policy init: --live only goes with --launch; edit the policy to make the default one live.");
    return 2;
  }
  const template = launch ? { ...LAUNCH_POLICY_TEMPLATE, live } : undefined;
  const { path, written } = initPolicy(paths, template);
  if (!written) io.out(`A policy already exists at ${path}; left it as it is. Edit it to change what it allows.`);
  else if (launch) {
    io.out(`Wrote a launch policy to ${path}: mainnet, launches and claims, ${LAUNCH_POLICY_TEMPLATE.max_sol_per_tx} SOL a launch (fee plus first buy), ${LAUNCH_POLICY_TEMPLATE.max_sol_per_day} SOL a day, ${live ? "live: it sends." : 'dry run until you set "live": true.'}`);
  } else {
    io.out(`Wrote a starting policy to ${path}: devnet, dry run, trades and claims, 0.1 SOL a transaction, 0.5 SOL a day.\nEdit it to change the limits; set "live": true only when you want it to send.`);
  }
  return 0;
}
