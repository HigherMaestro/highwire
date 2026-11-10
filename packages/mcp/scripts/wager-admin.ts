// The wager program's maintainer tool (docs/wager-devnet.md, docs/wager-mainnet.md). Not shipped: run from the
// repository. Every command takes --cluster devnet (the default) or mainnet, and checks the RPC's genesis hash is that
// cluster's.
//
//   ticket-key --out <file>
//       makes the matchmaker's ticket key: 32 random bytes written to <file> (mode 600, never overwritten) as hex, the
//       value LINE_WAGER_TICKET_KEY takes. Prints only the public key, which `init` and `config` take.
//   status
//       the program (deployed? its upgrade authority) and its config.
//   init --ticket-key <public key> [--key-id 1] [--fee-bps 250] [--fee-account <address>] [--tiers 0.01,0.1]
//       [--max-stake 0.1] [--open-cap 5] [--reveal-seconds 120] [--paused] [--send]
//       the one-time config, signed by the program's upgrade authority. On mainnet it's always set up paused, in the
//       same transaction: unpausing is the switch (docs/wager-mainnet.md).
//   pause | unpause [--send]
//       stops (or restarts) new series. Live ones play on and settle as usual; one opened but not yet accepted can't be
//       accepted while paused, so it's cancelled after its deadline (the daemons do it), refunding A.
//   config [--ticket-key <public key> --key-id <n>] [--fee-bps <n>] [--fee-account <address>] [--tiers 0.01,0.1]
//       [--max-stake <SOL>] [--open-cap <SOL>] [--new-authority <address> --confirm-new-authority <same>] [--send]
//       changes the config: what's named changes, the rest stays. A new fee applies to series opened afterwards.
//   freeze --series <id> [--send]
//       refunds the stakes of one series in full, whatever its state, a decided but unsettled one included (docs/
//       wager-mode.md 7.7). For a series stuck in a way nothing else will end; the players are told by the chain only.
//
// Signing (init, pause, unpause, config, freeze): --ledger signs on a Ledger with the Solana app open (account
// 44'/501'/0', which the Solana CLI calls usb://ledger?key=0; or --ledger-path). The Ledger libraries are installed apart
// from the workspace (their native USB modules have no place in the site's build): `npm ci --prefix tools/ledger`. or --authority <keypair file> on devnet only: mainnet signs on the Ledger, always. Without
// --send a command builds and simulates only. A mainnet send asks you to type "mainnet" first. It never prints a secret.
import { existsSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import {
  Chain,
  configUpdateInstruction,
  DEFAULT_RPC_URLS,
  decodeSeriesAccount,
  decodeWagerConfig,
  freezeAndRefundInstruction,
  initConfigInstruction,
  lamportsNumber,
  pauseInstruction,
  seriesAddress,
  solToLamports,
  uncreditable,
  wagerConfigAddress,
  WAGER_PROGRAM_IDS,
  type Cluster,
  type WagerConfigUpdate,
} from "highwire-core";
import { confirmByPolling, GENESIS_HASHES, loadKeypair } from "highwire-agent";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const LEDGER_PATH = "44'/501'/0'";

type Values = Record<string, string | boolean | undefined>;

function fail(message: string): never {
  console.error(`wager-admin: ${message}`);
  process.exit(2);
}

function clusterOf(v: Values): Cluster {
  const c = v.cluster ?? "devnet";
  if (c !== "devnet" && c !== "mainnet") fail('--cluster is "devnet" or "mainnet"');
  return c;
}

async function connect(cluster: Cluster, rpc: string | undefined): Promise<Connection> {
  const c = new Connection(rpc ?? DEFAULT_RPC_URLS[cluster], "confirmed");
  if ((await c.getGenesisHash()) !== GENESIS_HASHES[cluster]) fail(`that RPC isn't ${cluster}'s (wrong genesis hash)`);
  return c;
}

const programFor = (cluster: Cluster) => new PublicKey(WAGER_PROGRAM_IDS[cluster] ?? fail(`there's no ${cluster} program id in highwire-core yet`));

/** The Ledger Solana app's two calls used here. */
interface LedgerSolana {
  getAddress(path: string): Promise<{ address: Buffer }>;
  signTransaction(path: string, message: Buffer): Promise<{ signature: Buffer }>;
}

/** Who signs: a Ledger, or (devnet only) a keypair file. */
interface Signer {
  publicKey: PublicKey;
  sign(tx: VersionedTransaction): Promise<void>;
}

async function signerFor(cluster: Cluster, v: Values): Promise<Signer> {
  if (v.ledger === true) {
    const path = typeof v["ledger-path"] === "string" ? v["ledger-path"] : LEDGER_PATH;
    // Loaded only when asked for: the native USB module isn't needed for anything else.
    // From tools/ledger's own install, outside the workspace; the shapes used here are small.
    const ledger = createRequire(fileURLToPath(new URL("../../../tools/ledger/package.json", import.meta.url)));
    let TransportNodeHid: { create(openTimeout?: number, listenTimeout?: number): Promise<unknown> };
    let Solana: new (transport: unknown) => LedgerSolana;
    try {
      TransportNodeHid = ledger("@ledgerhq/hw-transport-node-hid").default;
      Solana = ledger("@ledgerhq/hw-app-solana").default;
    } catch {
      fail("the Ledger libraries aren't installed: npm ci --prefix tools/ledger");
    }
    const transport = await TransportNodeHid.create(5_000, 15_000).catch((err: unknown) => fail(`no Ledger found (plugged in, unlocked, the Solana app open?): ${err instanceof Error ? err.message : String(err)}`));
    const app = new Solana(transport);
    const publicKey = new PublicKey((await app.getAddress(path)).address);
    console.log(`signing on the Ledger as ${publicKey.toBase58()} (${path}): check every transaction on its screen`);
    return {
      publicKey,
      async sign(tx) {
        // Blind signing shows only the message's hash: here it is, to compare on the device before approving.
        const message = Buffer.from(tx.message.serialize());
        console.log(`approve on the Ledger only if it shows this message hash: ${bs58.encode(createHash("sha256").update(message).digest())}`);
        const { signature } = await app.signTransaction(path, message);
        tx.addSignature(publicKey, signature);
      },
    };
  }
  if (typeof v.authority !== "string") fail("this needs --ledger (or, on devnet only, --authority <keypair file>)");
  if (cluster === "mainnet") fail("mainnet signs on the Ledger only: use --ledger");
  const { keypair, warning } = loadKeypair(v.authority);
  if (warning) console.error(`warning: ${warning}`);
  return {
    publicKey: keypair.publicKey,
    async sign(tx) {
      tx.sign([keypair]);
    },
  };
}

/** A mainnet send waits for the maintainer to type "mainnet" at a terminal. */
async function confirmMainnet(cluster: Cluster): Promise<void> {
  if (cluster !== "mainnet") return;
  if (!process.stdin.isTTY) fail("a mainnet send needs a terminal to confirm at");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('This sends on MAINNET. Type "mainnet" to go on: ')).trim();
  rl.close();
  if (answer !== "mainnet") fail("not sent");
}

/** Builds (a legacy message, which every Ledger Solana app signs), simulates as the signer, and sends only with --send. */
async function simulateThenSend(c: Connection, cluster: Cluster, signer: Signer, ixs: TransactionInstruction[], send: boolean, done: string) {
  const build = (recentBlockhash: string) => new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash, instructions: ixs }).compileToLegacyMessage());
  const sim = await c.simulateTransaction(build((await c.getLatestBlockhash("confirmed")).blockhash), { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) fail(`the simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-8).join("\n")}`);
  console.log(`simulated ok (${sim.value.unitsConsumed} compute units)`);
  if (!send) return console.log("dry run: nothing sent. Add --send to do it.");
  await confirmMainnet(cluster);
  // A fresh blockhash after the prompt, so a slow confirmation doesn't send a stale one.
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
  const tx = build(blockhash);
  await signer.sign(tx);
  const sig = await c.sendRawTransaction(tx.serialize());
  await confirmByPolling(c, sig, lastValidBlockHeight).catch((err) => fail(`${sig} didn't confirm: ${err instanceof Error ? err.message : String(err)}`));
  console.log(`${done}: ${sig}`);
}

const sol = (n: bigint) => `${lamportsNumber(n)} SOL`;

/** The program's upgrade authority from its program data account: null when frozen, undefined when not deployed. */
async function upgradeAuthority(c: Connection, p: PublicKey): Promise<PublicKey | null | undefined> {
  const pd = PublicKey.findProgramAddressSync([p.toBuffer()], LOADER)[0];
  const data = (await c.getAccountInfo(pd))?.data;
  if (!data || data.length < 45 || data.readUInt32LE(0) !== 3) return undefined;
  return data[12] === 1 ? new PublicKey(data.subarray(13, 45)) : null;
}

async function status(c: Connection, cluster: Cluster) {
  const p = programFor(cluster);
  const acc = await c.getAccountInfo(p);
  console.log(`${cluster} program ${p.toBase58()}: ${acc ? (acc.executable ? "deployed" : "an account, not a program") : "not deployed"}`);
  const auth = await upgradeAuthority(c, p);
  if (auth !== undefined) console.log(`upgrade authority: ${auth ? auth.toBase58() : "none (frozen)"}`);
  const cfg = await c.getAccountInfo(wagerConfigAddress(p));
  if (!cfg) return console.log("config: not set up (run init)");
  const k = decodeWagerConfig(cfg.data);
  console.log(JSON.stringify({ ...k, tiers: k.tiers.map(sol), maxStake: sol(k.maxStake), openStakeCap: sol(k.openStakeCap), openStake: sol(k.openStake), feePercent: k.feeBps / 100 }, null, 2));
  console.log(k.paused ? "PAUSED: no new series" : "open: new series may start");
}

function ticketKey(out: string | undefined, cluster: Cluster) {
  if (!out) fail("ticket-key needs --out <file> for the secret");
  if (existsSync(out)) fail(`${out} exists: a ticket key is never overwritten`);
  const secret = randomBytes(32);
  writeFileSync(out, secret.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  const name = cluster === "mainnet" ? "LINE_WAGER_MAINNET_TICKET_KEY" : "LINE_WAGER_TICKET_KEY";
  console.log(`ticket key saved to ${out} (mode 600): set ${name} to its contents in the site's environment (Production, Sensitive), and nowhere else.`);
  console.log(`public key: ${bs58.encode(ed25519.getPublicKey(secret))}  (init and config take this)`);
}

const num = (v: Values, k: string, d?: number): number | undefined => {
  if (v[k] === undefined) return d;
  const x = Number(v[k]);
  if (!Number.isFinite(x)) fail(`--${k} isn't a number`);
  return x;
};
const tiersOf = (v: Values) => (typeof v.tiers === "string" ? v.tiers.split(",").map((t) => solToLamports(Number(t))) : undefined);
const key = (v: Values, k: string) => (typeof v[k] === "string" ? new PublicKey(v[k] as string) : undefined);

async function init(c: Connection, cluster: Cluster, v: Values) {
  const ticket = key(v, "ticket-key") ?? fail("init needs --ticket-key <public key> (from ticket-key)");
  const p = programFor(cluster);
  const auth = await upgradeAuthority(c, p);
  if (auth === undefined) fail(`the program isn't deployed on ${cluster} yet`);
  const signer = await signerFor(cluster, v);
  // Only the upgrade authority may set the config up (the program checks too); say so before building anything.
  if (!auth || !auth.equals(signer.publicKey)) fail(`the program's upgrade authority is ${auth?.toBase58() ?? "none (frozen)"}, not ${signer.publicKey.toBase58()}: sign with that key`);
  const cfg = {
    authority: signer.publicKey,
    ticketKey: ticket,
    ticketKeyId: num(v, "key-id", 1)!,
    feeBps: num(v, "fee-bps", 250)!,
    feeAccount: key(v, "fee-account") ?? (cluster === "mainnet" ? fail("on mainnet, name the fee account (--fee-account): never the authority's own wallet") : signer.publicKey),
    tiers: tiersOf(v) ?? [solToLamports(0.01), solToLamports(0.1)],
    maxStake: solToLamports(num(v, "max-stake", 0.1)!),
    openStakeCap: solToLamports(num(v, "open-cap", 5)!),
    revealSeconds: num(v, "reveal-seconds", 120)!,
  };
  if (cfg.feeAccount.equals(signer.publicKey) && cluster === "mainnet") fail("the fee account can't be the authority's own wallet on mainnet");
  // On mainnet the program starts paused, in the same transaction: nothing can open before the switch.
  const paused = cluster === "mainnet" || v.paused === true;
  console.log(
    `config: authority ${cfg.authority.toBase58()}, ticket key ${cfg.ticketKey.toBase58()} (id ${cfg.ticketKeyId}), fee ${cfg.feeBps / 100}% to ${cfg.feeAccount.toBase58()}, ` +
      `tiers ${cfg.tiers.map(sol).join(", ")}, at most ${sol(cfg.maxStake)} a side, ${sol(cfg.openStakeCap)} open in all, reveals within ${cfg.revealSeconds} s${paused ? ", PAUSED" : ""}`,
  );
  const ixs = [initConfigInstruction(p, cfg), ...(paused ? [pauseInstruction(p, signer.publicKey, true)] : [])];
  await simulateThenSend(c, cluster, signer, ixs, v.send === true, "set up");
}

/** The config's authority, checked against the config before anything is built. */
async function configAuthority(c: Connection, cluster: Cluster, v: Values): Promise<Signer> {
  const cfg = await c.getAccountInfo(wagerConfigAddress(programFor(cluster)));
  if (!cfg) fail("the config isn't set up (run init)");
  const k = decodeWagerConfig(cfg.data);
  const signer = await signerFor(cluster, v);
  if (!signer.publicKey.equals(new PublicKey(k.authority))) fail(`that signer isn't the config's authority (${k.authority})`);
  return signer;
}

async function pause(c: Connection, cluster: Cluster, v: Values, paused: boolean) {
  const signer = await configAuthority(c, cluster, v);
  console.log(paused ? `pausing ${cluster}: no new series or accepts until unpause; live ones play on` : `unpausing ${cluster}: new series may open`);
  await simulateThenSend(c, cluster, signer, [pauseInstruction(programFor(cluster), signer.publicKey, paused)], v.send === true, paused ? "paused" : "unpaused");
}

async function config(c: Connection, cluster: Cluster, v: Values) {
  const u: WagerConfigUpdate = {};
  const ticket = key(v, "ticket-key");
  if (ticket) u.ticketKey = { key: ticket, id: num(v, "key-id") ?? fail("a new ticket key needs its --key-id, a number the old key never had") };
  else if (v["key-id"] !== undefined) fail("--key-id goes with --ticket-key: the key id changes only with the key");
  if (v["fee-bps"] !== undefined) u.feeBps = num(v, "fee-bps");
  u.feeAccount = key(v, "fee-account");
  u.tiers = tiersOf(v);
  if (v["max-stake"] !== undefined) u.maxStake = solToLamports(num(v, "max-stake")!);
  if (v["open-cap"] !== undefined) u.openStakeCap = solToLamports(num(v, "open-cap")!);
  u.authority = key(v, "new-authority");
  const named = Object.entries(u).filter(([, x]) => x !== undefined);
  if (!named.length) fail("config changes nothing: name what to change (see the top of scripts/wager-admin.ts)");
  const signer = await configAuthority(c, cluster, v);
  if (u.feeAccount && u.feeAccount.equals(signer.publicKey) && cluster === "mainnet") fail("the fee account can't be the authority's own wallet on mainnet");
  if (u.authority) {
    // The one change that can't be undone by its sender: the address twice, and one a wallet can sign for.
    if (key(v, "confirm-new-authority")?.equals(u.authority) !== true) fail("handing over the config needs the same address again in --confirm-new-authority");
    if (!PublicKey.isOnCurve(u.authority.toBytes())) fail(`${u.authority.toBase58()} isn't a wallet's address (it's off the curve): no one could sign for it`);
    const info = await c.getAccountInfo(u.authority);
    if (info?.executable) fail(`${u.authority.toBase58()} is a program: it can't sign for the config`);
    console.log(`HANDING THE CONFIG to ${u.authority.toBase58()}: from then on only that key can pause, freeze or change it. The program's upgrade authority doesn't move with it. A wrong address can't be undone.`);
  }
  console.log(`changing ${named.map(([k]) => k).join(", ")} on ${cluster}`);
  await simulateThenSend(c, cluster, signer, [configUpdateInstruction(programFor(cluster), signer.publicKey, u)], v.send === true, "changed");
}

async function freeze(c: Connection, cluster: Cluster, v: Values) {
  const id = typeof v.series === "string" ? v.series.toLowerCase() : fail("freeze needs --series <id> (64 hex characters)");
  if (!/^[0-9a-f]{64}$/.test(id)) fail("--series is the series id: 64 hex characters");
  const p = programFor(cluster);
  const signer = await configAuthority(c, cluster, v);
  const acc = await c.getAccountInfo(seriesAddress(p, id));
  if (!acc || !acc.owner.equals(p)) fail("there's no such series open: never opened, or already closed");
  const { header } = decodeSeriesAccount(acc.data);
  const a = new PublicKey(header.playerA);
  const b = new PublicKey(header.playerB);
  // A payee the runtime won't credit (a wallet turned into a program) goes read-only; the program burns its share.
  const readOnly = await uncreditable(new Chain({ cluster, rpcUrl: c.rpcEndpoint }), [a, b]);
  const back = header.status === "open" ? `A's stake back in full to ${a.toBase58()} (B never staked)` : `both stakes back in full to A ${a.toBase58()} and B ${b.toBase58()}`;
  console.log(`freezing series ${id} (${header.status}): ${back}${readOnly.length ? `; burning the share of ${readOnly.map(String).join(", ")}, which can't be credited` : ""}`);
  await simulateThenSend(c, cluster, signer, [freezeAndRefundInstruction(p, signer.publicKey, id, { playerA: a, playerB: b }, readOnly)], v.send === true, "frozen and refunded");
}

const [cmd, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    cluster: { type: "string" },
    out: { type: "string" },
    rpc: { type: "string" },
    authority: { type: "string" },
    ledger: { type: "boolean" },
    "ledger-path": { type: "string" },
    "ticket-key": { type: "string" },
    "key-id": { type: "string" },
    "fee-bps": { type: "string" },
    "fee-account": { type: "string" },
    tiers: { type: "string" },
    "max-stake": { type: "string" },
    "open-cap": { type: "string" },
    "reveal-seconds": { type: "string" },
    "new-authority": { type: "string" },
    "confirm-new-authority": { type: "string" },
    series: { type: "string" },
    paused: { type: "boolean" },
    send: { type: "boolean" },
  },
});
const cluster = clusterOf(values);
if (cmd === "ticket-key") ticketKey(values.out, cluster);
else if (cmd === "status") await status(await connect(cluster, values.rpc), cluster);
else if (cmd === "init") await init(await connect(cluster, values.rpc), cluster, values);
else if (cmd === "pause" || cmd === "unpause") await pause(await connect(cluster, values.rpc), cluster, values, cmd === "pause");
else if (cmd === "config") await config(await connect(cluster, values.rpc), cluster, values);
else if (cmd === "freeze") await freeze(await connect(cluster, values.rpc), cluster, values);
else fail("ticket-key, status, init, pause, unpause, config or freeze (see the top of scripts/wager-admin.ts)");
process.exit(0);
