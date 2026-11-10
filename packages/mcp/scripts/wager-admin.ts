// The wager program's maintainer tool, for devnet (docs/wager-devnet.md). Not shipped: run from the repository.
//
//   npm run wager-admin -w highwire-mcp -- ticket-key --out <file>
//       makes the matchmaker's ticket key: 32 random bytes written to <file> (mode 600, never overwritten) as hex, the
//       value LINE_WAGER_TICKET_KEY takes. Prints only the public key, which `init` puts in the program's config.
//   npm run wager-admin -w highwire-mcp -- status
//       the program (deployed? its upgrade authority) and its config.
//   npm run wager-admin -w highwire-mcp -- init --authority <keypair file> --ticket-key <public key> [--key-id 1]
//       [--fee-bps 250] [--fee-account <address>] [--tiers 0.01,0.1] [--max-stake 0.1] [--open-cap 5]
//       [--reveal-seconds 120] [--send]
//       the one-time config, signed by the program's upgrade authority. Without --send it builds and simulates only.
//   npm run wager-admin -w highwire-mcp -- pause|unpause --authority <keypair file> [--send]
//       stops (or restarts) new series. Open ones play on and settle as usual.
//   npm run wager-admin -w highwire-mcp -- freeze --series <id> --authority <keypair file> [--send]
//       refunds both stakes of one series in full, whatever its state, a decided but unsettled one included (docs/
//       wager-mode.md 7.7). For a series stuck in a way nothing else will end; the players are told by the chain only.
//
// Every command reads devnet's public RPC (or --rpc), and checks it's devnet by its genesis hash. It never prints a
// secret, and sends only with --send, from the config authority's keypair the maintainer names.
import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import { Chain, DEFAULT_RPC_URLS, decodeSeriesAccount, decodeWagerConfig, freezeAndRefundInstruction, initConfigInstruction, pauseInstruction, seriesAddress, lamportsNumber, solToLamports, uncreditable, wagerConfigAddress, WAGER_PROGRAM_IDS } from "highwire-core";
import { confirmByPolling, GENESIS_HASHES, loadKeypair } from "highwire-agent";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

function fail(message: string): never {
  console.error(`wager-admin: ${message}`);
  process.exit(2);
}

async function devnet(rpc: string | undefined): Promise<Connection> {
  const c = new Connection(rpc ?? DEFAULT_RPC_URLS.devnet, "confirmed");
  if ((await c.getGenesisHash()) !== GENESIS_HASHES.devnet) fail("that RPC isn't devnet's (wrong genesis hash): this tool works on devnet only");
  return c;
}

const program = () => new PublicKey(WAGER_PROGRAM_IDS.devnet ?? fail("there's no devnet program id in highwire-core"));

async function status(c: Connection) {
  const p = program();
  const acc = await c.getAccountInfo(p);
  console.log(`program ${p.toBase58()}: ${acc ? (acc.executable ? "deployed" : "an account, not a program") : "not deployed"}`);
  const pd = PublicKey.findProgramAddressSync([p.toBuffer()], LOADER)[0];
  const data = (await c.getAccountInfo(pd))?.data;
  if (data && data.length >= 45 && data.readUInt32LE(0) === 3) {
    console.log(`upgrade authority: ${data[12] === 1 ? new PublicKey(data.subarray(13, 45)).toBase58() : "none (frozen)"}; program data ${pd.toBase58()}, ${data.length} bytes`);
  }
  const cfg = await c.getAccountInfo(wagerConfigAddress(p));
  if (!cfg) return console.log("config: not set up (run init)");
  const k = decodeWagerConfig(cfg.data);
  console.log(
    JSON.stringify(
      { ...k, tiers: k.tiers.map((t) => `${lamportsNumber(t)} SOL`), maxStake: `${lamportsNumber(k.maxStake)} SOL`, openStakeCap: `${lamportsNumber(k.openStakeCap)} SOL`, openStake: `${lamportsNumber(k.openStake)} SOL`, feePercent: k.feeBps / 100 },
      null,
      2,
    ),
  );
}

function ticketKey(out: string | undefined) {
  if (!out) fail("ticket-key needs --out <file> for the secret");
  if (existsSync(out)) fail(`${out} exists: a ticket key is never overwritten`);
  const secret = randomBytes(32);
  writeFileSync(out, secret.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  console.log(`ticket key saved to ${out} (mode 600): set LINE_WAGER_TICKET_KEY to its contents in the site's environment, and nowhere else.`);
  console.log(`public key: ${bs58.encode(ed25519.getPublicKey(secret))}  (init --ticket-key takes this)`);
}

async function init(c: Connection, v: Record<string, string | boolean | undefined>) {
  if (typeof v.authority !== "string") fail("init needs --authority <keypair file> (the program's upgrade authority)");
  if (typeof v["ticket-key"] !== "string") fail("init needs --ticket-key <public key> (from ticket-key)");
  const { keypair, warning } = loadKeypair(v.authority);
  if (warning) console.error(`warning: ${warning}`);
  const num = (k: string, d: number) => {
    const x = v[k] === undefined ? d : Number(v[k]);
    if (!Number.isFinite(x)) fail(`--${k} isn't a number`);
    return x;
  };
  const tiers = String(v.tiers ?? "0.01,0.1").split(",").map((t) => solToLamports(Number(t)));
  const cfg = {
    authority: keypair.publicKey,
    ticketKey: new PublicKey(v["ticket-key"]),
    ticketKeyId: num("key-id", 1),
    feeBps: num("fee-bps", 250),
    feeAccount: new PublicKey(typeof v["fee-account"] === "string" ? v["fee-account"] : keypair.publicKey),
    tiers,
    maxStake: solToLamports(num("max-stake", 0.1)),
    openStakeCap: solToLamports(num("open-cap", 5)),
    revealSeconds: num("reveal-seconds", 120),
  };
  console.log(
    `config: authority ${cfg.authority.toBase58()}, ticket key ${cfg.ticketKey.toBase58()} (id ${cfg.ticketKeyId}), fee ${cfg.feeBps / 100}% to ${cfg.feeAccount.toBase58()}, ` +
      `tiers ${tiers.map((t) => lamportsNumber(t)).join(", ")} SOL, at most ${lamportsNumber(cfg.maxStake)} SOL a side, ${lamportsNumber(cfg.openStakeCap)} SOL open in all, reveals within ${cfg.revealSeconds} s`,
  );
  await simulateThenSend(c, keypair, initConfigInstruction(program(), cfg), v.send === true, "set up");
}

/** Builds, simulates as the signer, and sends only with --send. */
async function simulateThenSend(c: Connection, keypair: Keypair, ix: TransactionInstruction, send: boolean, done: string) {
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: keypair.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
  const sim = await c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) fail(`the simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-8).join("\n")}`);
  console.log(`simulated ok (${sim.value.unitsConsumed} compute units)`);
  if (!send) return console.log("dry run: nothing sent. Add --send to do it.");
  tx.sign([keypair]);
  const sig = await c.sendRawTransaction(tx.serialize());
  await confirmByPolling(c, sig, lastValidBlockHeight).catch((err) => fail(`${sig} didn't confirm: ${err instanceof Error ? err.message : String(err)}`));
  console.log(`${done}: ${sig}`);
}

/** The config authority's keypair, checked against the config before anything is built. */
async function configAuthority(c: Connection, file: unknown): Promise<Keypair> {
  if (typeof file !== "string") fail("this needs --authority <keypair file> (the config's authority)");
  const { keypair, warning } = loadKeypair(file);
  if (warning) console.error(`warning: ${warning}`);
  const cfg = await c.getAccountInfo(wagerConfigAddress(program()));
  if (!cfg) fail("the config isn't set up (run init)");
  const k = decodeWagerConfig(cfg.data);
  if (!keypair.publicKey.equals(new PublicKey(k.authority))) fail(`that keypair isn't the config's authority (${k.authority})`);
  return keypair;
}

async function pause(c: Connection, v: Record<string, string | boolean | undefined>, paused: boolean) {
  const keypair = await configAuthority(c, v.authority);
  console.log(paused ? "pausing: no new series until unpause; open ones play on" : "unpausing: new series may open again");
  await simulateThenSend(c, keypair, pauseInstruction(program(), keypair.publicKey, paused), v.send === true, paused ? "paused" : "unpaused");
}

async function freeze(c: Connection, v: Record<string, string | boolean | undefined>) {
  const id = typeof v.series === "string" ? v.series.toLowerCase() : fail("freeze needs --series <id> (64 hex characters)");
  if (!/^[0-9a-f]{64}$/.test(id)) fail("--series is the series id: 64 hex characters");
  const keypair = await configAuthority(c, v.authority);
  const acc = await c.getAccountInfo(seriesAddress(program(), id));
  if (!acc || !acc.owner.equals(program())) fail("there's no such series open: never opened, or already closed");
  const { header } = decodeSeriesAccount(acc.data);
  const a = new PublicKey(header.playerA);
  const b = new PublicKey(header.playerB);
  // A payee the runtime won't credit (a wallet turned into a program) goes read-only; the program burns its share.
  const readOnly = await uncreditable(new Chain({ cluster: "devnet", rpcUrl: c.rpcEndpoint }), [a, b]);
  console.log(`freezing series ${id} (${header.status}): both stakes back in full to A ${a.toBase58()} and B ${b.toBase58()}${readOnly.length ? `; burning the share of ${readOnly.map(String).join(", ")}, which can't be credited` : ""}`);
  await simulateThenSend(c, keypair, freezeAndRefundInstruction(program(), keypair.publicKey, id, { playerA: a, playerB: b }, readOnly), v.send === true, "frozen and refunded");
}

const [cmd, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    out: { type: "string" },
    rpc: { type: "string" },
    authority: { type: "string" },
    "ticket-key": { type: "string" },
    "key-id": { type: "string" },
    "fee-bps": { type: "string" },
    "fee-account": { type: "string" },
    tiers: { type: "string" },
    "max-stake": { type: "string" },
    "open-cap": { type: "string" },
    "reveal-seconds": { type: "string" },
    series: { type: "string" },
    send: { type: "boolean" },
  },
});
if (cmd === "ticket-key") ticketKey(values.out);
else if (cmd === "status") await status(await devnet(values.rpc));
else if (cmd === "init") await init(await devnet(values.rpc), values);
else if (cmd === "pause" || cmd === "unpause") await pause(await devnet(values.rpc), values, cmd === "pause");
else if (cmd === "freeze") await freeze(await devnet(values.rpc), values);
else fail("ticket-key, status, init, pause, unpause or freeze (see the top of scripts/wager-admin.ts)");
