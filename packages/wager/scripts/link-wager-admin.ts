// Link battles' practice-stake program's maintainer tool (docs/link-wager.md 4.2). Not shipped: run from the
// repository. Devnet only: there is no other cluster for this program, and every command checks the RPC's genesis hash.
//
//   keys --out-dir <dir>
//       makes the desk's two keys: 32 random bytes each, written as hex to <dir>/link-stake-ticket.key and
//       <dir>/link-stake-result.key (mode 600, never overwritten): the values LINK_STAKE_TICKET_KEY and
//       LINK_STAKE_RESULT_KEY take in the site's environment. Prints only the two public keys, which `init` takes.
//   status
//       the program (deployed? its upgrade authority) and its config.
//   init --ticket-key <public key> --result-key <public key> [--ticket-key-id 1] [--result-key-id 1]
//       [--tiers 0.1,0.25] [--max-stake 0.25] [--open-cap 20] [--refund-after 3600] [--send]
//       the one-time config, signed by the program's upgrade authority (--authority), who becomes its authority.
//   pause | unpause [--send]
//       stops (or restarts) new staked battles. Ones already staked play on and settle as usual.
//   config [--ticket-key <public key> --ticket-key-id <n>] [--result-key <public key> --result-key-id <n>]
//       [--tiers 0.1,0.25] [--max-stake <SOL>] [--open-cap <SOL>] [--refund-after <seconds>] [--send]
//       changes the config: what's named changes, the rest stays.
//   freeze --battle <id> [--send]
//       refunds whoever has staked on one battle, in full, whatever its state.
//
// Signing (init, pause, unpause, config, freeze): --authority <keypair file>. Without --send a command builds and
// simulates only. It never prints a secret, and it doesn't deploy the program or fund a wallet: those are yours.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { confirmByPolling, GENESIS_HASHES, loadKeypair } from "highwire-agent";
import { Chain, DEFAULT_RPC_URLS, lamportsNumber, solToLamports } from "highwire-core";
import { decodeLinkConfig, linkConfigAddress, linkConfigUpdateInstruction, linkFreezeAndRefundInstruction, linkInitConfigInstruction, LINK_WAGER_PROGRAM_IDS, type LinkConfigUpdate } from "../src/link-codec.ts";
import { readLinkBattle } from "../src/link-tx.ts";
import { uncreditable } from "../src/tx.ts";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

type Values = Record<string, string | boolean | undefined>;

function fail(message: string): never {
  console.error(`link-wager-admin: ${message}`);
  process.exit(2);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rpc: { type: "string" },
    program: { type: "string" },
    authority: { type: "string" },
    send: { type: "boolean" },
    "out-dir": { type: "string" },
    "ticket-key": { type: "string" },
    "ticket-key-id": { type: "string" },
    "result-key": { type: "string" },
    "result-key-id": { type: "string" },
    tiers: { type: "string" },
    "max-stake": { type: "string" },
    "open-cap": { type: "string" },
    "refund-after": { type: "string" },
    battle: { type: "string" },
  },
});
const v: Values = values;
const [command] = positionals;

const str = (name: string) => (typeof v[name] === "string" ? (v[name] as string) : undefined);
const address = (name: string): string => {
  const s = str(name) ?? fail(`--${name} is a public key`);
  try {
    return new PublicKey(s).toBase58();
  } catch {
    return fail(`--${name} isn't a public key`);
  }
};
const whole = (name: string, fallback?: number): number => {
  const s = str(name);
  if (s === undefined) return fallback ?? fail(`--${name} is a whole number`);
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : fail(`--${name} is a whole number`);
};
const sol = (name: string, fallback?: number): bigint => {
  const n = Number(str(name) ?? fallback ?? fail(`--${name} is an amount of SOL`));
  return Number.isFinite(n) && n > 0 ? solToLamports(n) : fail(`--${name} is an amount of SOL`);
};
const tiers = (fallback?: string): bigint[] =>
  (str("tiers") ?? fallback ?? fail("--tiers is a list of SOL amounts")).split(",").map((t) => {
    const n = Number(t.trim());
    return Number.isFinite(n) && n > 0 ? solToLamports(n) : fail("--tiers is a list of SOL amounts, like 0.1,0.25");
  });

// The program's address: the codec's for devnet, or --program before it's listed there (a first deploy).
const programId = str("program") ?? LINK_WAGER_PROGRAM_IDS.devnet ?? fail("there's no devnet program id in the codec yet: pass --program <address>");
const PROGRAM = new PublicKey(programId);

async function connect(): Promise<Connection> {
  const c = new Connection(str("rpc") ?? DEFAULT_RPC_URLS.devnet, "confirmed");
  if ((await c.getGenesisHash()) !== GENESIS_HASHES.devnet) fail("that RPC isn't devnet's (wrong genesis hash): this program is devnet only");
  return c;
}

function signer() {
  const file = str("authority") ?? fail("this needs --authority <keypair file>");
  const { keypair, warning } = loadKeypair(file);
  if (warning) console.error(`warning: ${warning}`);
  return keypair;
}

/** Builds, simulates as the signer, and sends only with --send. */
async function simulateThenSend(c: Connection, ixs: TransactionInstruction[], done: string) {
  const key = signer();
  const build = (blockhash: string) => new VersionedTransaction(new TransactionMessage({ payerKey: key.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  const sim = await c.simulateTransaction(build((await c.getLatestBlockhash("confirmed")).blockhash), { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) fail(`it wouldn't go through: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-8).join("\n")}`);
  console.log(`simulated ok (${sim.value.unitsConsumed} compute units), signed by ${key.publicKey.toBase58()}`);
  if (v.send !== true) {
    console.log("not sent: add --send to send it");
    return;
  }
  const latest = await c.getLatestBlockhash("confirmed");
  const tx = build(latest.blockhash);
  tx.sign([key]);
  const sig = await c.sendRawTransaction(tx.serialize());
  await confirmByPolling(c, sig, latest.lastValidBlockHeight);
  console.log(`${done}: ${sig}`);
}

async function status() {
  const c = await connect();
  console.log(`program ${PROGRAM.toBase58()} on devnet`);
  const acc = await c.getAccountInfo(PROGRAM);
  if (!acc) {
    console.log("not deployed");
    return;
  }
  const [programData] = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], LOADER);
  const pd = await c.getAccountInfo(programData);
  // ProgramData: a 4-byte tag, the deploy slot (8), then an optional upgrade authority.
  const authority = pd && pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : null;
  console.log(`deployed; upgrade authority ${authority ?? "none (it can't be upgraded, or set up)"}`);
  const cfg = await c.getAccountInfo(linkConfigAddress(PROGRAM));
  if (!cfg) {
    console.log("no config yet: run init");
    return;
  }
  const k = decodeLinkConfig(Buffer.from(cfg.data));
  console.log(
    [
      `config ${linkConfigAddress(PROGRAM).toBase58()}`,
      `  authority      ${k.authority}`,
      `  ticket key     ${k.ticketKey} (id ${k.ticketKeyId})`,
      `  result key     ${k.resultKey} (id ${k.resultKeyId})`,
      `  paused         ${k.paused}`,
      `  tiers          ${k.tiers.map((t) => lamportsNumber(t)).join(", ")} SOL a side`,
      `  max stake      ${lamportsNumber(k.maxStake)} SOL`,
      `  open stakes    ${lamportsNumber(k.openStake)} of at most ${lamportsNumber(k.openStakeCap)} SOL`,
      `  refund after   ${k.refundAfterSeconds} seconds with no result`,
    ].join("\n"),
  );
}

function keys() {
  const dir = str("out-dir") ?? fail("keys needs --out-dir <a folder outside the repository>");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const made: string[] = [];
  for (const what of ["ticket", "result"] as const) {
    const file = join(dir, `link-stake-${what}.key`);
    if (existsSync(file)) fail(`${file} exists: it's never overwritten. Move it away first if you mean to replace the key.`);
    const secret = randomBytes(32);
    writeFileSync(file, `${secret.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    made.push(`${what} key: ${bs58.encode(ed25519.getPublicKey(secret))}   (secret in ${file}, for LINK_STAKE_${what.toUpperCase()}_KEY)`);
  }
  console.log(made.join("\n"));
  console.log("Give init the two public keys. The files hold the secrets: set them in the site's environment, and nowhere else.");
}

async function init() {
  const c = await connect();
  const key = signer();
  const [ticketKey, resultKey] = [address("ticket-key"), address("result-key")];
  if (ticketKey === resultKey) fail("the ticket key and the result key must be different keys");
  const t = tiers("0.1,0.25");
  const top = t.reduce((m, x) => (x > m ? x : m), 0n);
  await simulateThenSend(
    c,
    [
      linkInitConfigInstruction(PROGRAM, key.publicKey, {
        authority: key.publicKey.toBase58(),
        ticketKey,
        ticketKeyId: whole("ticket-key-id", 1),
        resultKey,
        resultKeyId: whole("result-key-id", 1),
        tiers: t,
        maxStake: str("max-stake") ? sol("max-stake") : top,
        openStakeCap: sol("open-cap", 20),
        refundAfterSeconds: whole("refund-after", 3600),
      }),
    ],
    "set up",
  );
}

async function config() {
  const c = await connect();
  const u: LinkConfigUpdate = {};
  if (str("ticket-key")) u.ticketKey = { key: address("ticket-key"), id: whole("ticket-key-id") };
  if (str("result-key")) u.resultKey = { key: address("result-key"), id: whole("result-key-id") };
  if (str("tiers")) u.tiers = tiers();
  if (str("max-stake")) u.maxStake = sol("max-stake");
  if (str("open-cap")) u.openStakeCap = sol("open-cap");
  if (str("refund-after")) u.refundAfterSeconds = whole("refund-after");
  if (Object.keys(u).length === 0) fail("config changes what it's given: name at least one setting");
  await simulateThenSend(c, [linkConfigUpdateInstruction(PROGRAM, signer().publicKey, u)], "changed");
}

async function freeze() {
  const c = await connect();
  const id = str("battle");
  if (!id || !/^[0-9a-f]{64}$/.test(id)) fail("--battle is the battle's id: 64 hex characters");
  const stakes = { chain: new Chain({ cluster: "devnet", rpcUrl: str("rpc") }), program: PROGRAM };
  const b = (await readLinkBattle(stakes, id)) ?? fail("there's no such battle on-chain: it was never opened, or it has closed");
  const parties = { playerA: new PublicKey(b.playerA), playerB: new PublicKey(b.playerB) };
  const readOnly = await uncreditable(stakes.chain, [parties.playerA, parties.playerB]);
  await simulateThenSend(c, [linkFreezeAndRefundInstruction(PROGRAM, signer().publicKey, id, parties, readOnly)], "frozen and refunded");
}

switch (command) {
  case "keys":
    keys();
    break;
  case "status":
    await status();
    break;
  case "init":
    await init();
    break;
  case "pause":
  case "unpause":
    await simulateThenSend(await connect(), [linkConfigUpdateInstruction(PROGRAM, signer().publicKey, { paused: command === "pause" })], command === "pause" ? "paused" : "unpaused");
    break;
  case "config":
    await config();
    break;
  case "freeze":
    await freeze();
    break;
  default:
    fail("commands: keys, status, init, pause, unpause, config, freeze (see the top of this file)");
}
