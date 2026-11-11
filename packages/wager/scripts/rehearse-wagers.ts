// The wager stack rehearsed end to end on a local validator (docs/wager-mainnet.md 4): the compiled program, two
// agents' MCP servers with real LocalSigners and policies, their reveal daemons (`highwire-wager run`, in process), and
// the referee's wager desk (in process, its own ticket key) — everything a mainnet series goes through, with nothing
// replaced but the cluster. It plays:
//
//   0. the config set up paused in the same transaction (as wager-admin does on mainnet), then unpaused: the switch;
//   1. a full series through line_stake / line_state / line_move, one side missing a commit (its fallback plays), the
//      daemons revealing and settling; the closing event, both views, the referee's record and the balances agree;
//   2. a series one side retires from (line_retire), settled to the other;
//   3. a series B never accepts, cancelled by a daemon after the deadline, refunding A;
//   4. the config paused (no stake can open) and unpaused, and a live series frozen and refunded by the authority.
//
// It never touches a public cluster: `solana-test-validator` runs locally on a throwaway ledger, its wallets come from
// fixed seeds and are funded in that ledger's genesis (no airdrop), and the validator stops at the end. The 24-hour
// emergency refund isn't rehearsed here (programs/line-wager/tests covers it with a moved clock).
//
//   (cd programs/line-wager && cargo build-sbf)    # once, for target/deploy/line_wager.so
//   npm run rehearse-wagers -w highwire-wager [-- --quick]    # --quick skips the missed commit (2 minutes of waiting)
//
// About 8 minutes in all (3 with --quick).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ed25519 } from "@noble/curves/ed25519";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { agentPaths, GENESIS_HASHES, LocalSigner } from "highwire-agent";
import { Chain, freezeAndRefundInstruction, initConfigInstruction, pauseInstruction, WAGER_PROGRAM_IDS } from "highwire-core";
import { readWagerConfig, seriesOutcome } from "../src/tx.ts";
import { createRelay, MemoryStore, realClock } from "highwire-relay";
import { FakeCoins, FakeRpc, launchTx, memoTx } from "highwire-relay/testing";
import { runLine } from "../src/line-cli.ts";
import { createServer } from "highwire-mcp";
import { registerWagerTools } from "../src/tools.ts";

const QUICK = process.argv.includes("--quick");
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SO = join(ROOT, "programs/line-wager/target/deploy/line_wager.so");
const PORT = 18_899;
const RPC = `http://127.0.0.1:${PORT}`;
const PROGRAM = new PublicKey(WAGER_PROGRAM_IDS.devnet!);
const STAKE_SOL = 0.01;
const SOL = 1_000_000_000;
const TICKET_SECRET = new Uint8Array(32).fill(42);

const t0 = Date.now();
const log = (who: string, line: string) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s  ${who.padEnd(10)} ${line}`);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const results: { what: string; ok: boolean; detail: string }[] = [];
const check = (what: string, ok: boolean, detail = "") => {
  results.push({ what, ok, detail });
  log("check", `${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
};

if (!existsSync(SO)) {
  console.error(`rehearse-wagers: build the program first: (cd programs/line-wager && cargo build-sbf)`);
  process.exit(2);
}

// ---------------------------------------------------------------- the local validator, funded at genesis

const seed = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n));
const keys = { authority: seed(61), a: seed(62), b: seed(63), fee: seed(64) };
const dir = mkdtempSync(join(tmpdir(), "highwire-rehearse-wagers-"));
const accountFile = (k: Keypair, sol: number) => {
  const file = join(dir, `${k.publicKey.toBase58()}.json`);
  writeFileSync(file, JSON.stringify({ pubkey: k.publicKey.toBase58(), account: { lamports: sol * SOL, data: ["", "base64"], owner: "11111111111111111111111111111111", executable: false, rentEpoch: 0, space: 0 } }));
  return ["--account", k.publicKey.toBase58(), file];
};
const validator = spawn(
  "solana-test-validator",
  [
    "--reset",
    "--quiet",
    "--ledger",
    join(dir, "ledger"),
    "--rpc-port",
    String(PORT),
    "--faucet-port",
    String(PORT + 1_002),
    "--dynamic-port-range",
    `${PORT + 1_010}-${PORT + 1_040}`,
    "--upgradeable-program",
    PROGRAM.toBase58(),
    SO,
    keys.authority.publicKey.toBase58(),
    ...accountFile(keys.authority, 10),
    ...accountFile(keys.a, 5),
    ...accountFile(keys.b, 5),
    ...accountFile(keys.fee, 1),
  ],
  // macOS's tar adds AppleDouble files to the genesis archive unless told not to, and the validator refuses them.
  { stdio: "ignore", env: { ...process.env, COPYFILE_DISABLE: "1" } },
);
const stop = () => {
  validator.kill("SIGINT");
  rmSync(dir, { recursive: true, force: true });
};
process.on("exit", stop);

const connection = new Connection(RPC, "confirmed");
for (let i = 0; ; i++) {
  try {
    await connection.getLatestBlockhash();
    break;
  } catch {
    if (i > 60) throw new Error("the local validator didn't start (is solana-test-validator on the PATH?)");
    await sleep(1_000);
  }
}
// A program loaded at genesis becomes callable a few slots in.
while ((await connection.getSlot()) < 5) await sleep(500);
// The signer refuses an RPC whose genesis hash isn't its policy's cluster's: this ledger stands in for devnet.
GENESIS_HASHES.devnet = await connection.getGenesisHash();
log("validator", `up at ${RPC}, program ${PROGRAM.toBase58()}`);

// The config: the authority sets it up as wager-admin does on mainnet, paused in the same transaction, with this
// rehearsal's ticket key and the fee to its own account; then unpauses (the switch).
await sendAndConfirmTransaction(
  connection,
  new Transaction().add(
    initConfigInstruction(PROGRAM, {
      authority: keys.authority.publicKey,
      ticketKey: new PublicKey(ed25519.getPublicKey(TICKET_SECRET)),
      ticketKeyId: 1,
      feeBps: 250,
      feeAccount: keys.fee.publicKey,
      tiers: [BigInt(STAKE_SOL * SOL)],
      maxStake: BigInt(STAKE_SOL * SOL),
      openStakeCap: BigInt(5 * SOL),
      revealSeconds: 60,
    }),
    pauseInstruction(PROGRAM, keys.authority.publicKey, true),
  ),
  [keys.authority],
).catch(async (err) => {
  console.error((await (err as { getLogs?: (c: Connection) => Promise<string[]> }).getLogs?.(connection))?.join("\n"));
  throw err;
});
const admin = (ix: Parameters<Transaction["add"]>[0]) => sendAndConfirmTransaction(connection, new Transaction().add(ix), [keys.authority]);
const initialConfig = await readWagerConfig(new Chain({ cluster: "devnet", rpcUrl: RPC }));
await admin(pauseInstruction(PROGRAM, keys.authority.publicKey, false));
check("the config was set up paused, in one transaction", initialConfig.paused);
log("admin", "config set up paused, then unpaused");

// ---------------------------------------------------------------- the referee, in process, on this ledger

const chain = new Chain({ cluster: "devnet", rpcUrl: RPC });
const rpcFake = new FakeRpc();
const coins = new FakeCoins(Date.now());
const relay = createRelay({
  store: new MemoryStore(realClock),
  clock: realClock,
  rpc: rpcFake,
  coins,
  referee: {
    wager: {
      programId: PROGRAM.toBase58(),
      cluster: "devnet",
      ticketSecret: TICKET_SECRET,
      keyId: 1,
      tiers: [BigInt(STAKE_SOL * SOL)],
      minQueue: 2,
      perPairPerWeek: 50,
      acceptSeconds: 60,
      longPollMs: 10_000,
      chain: {
        status: (id) => seriesOutcome(chain, id),
        config: async () => {
          const c = await readWagerConfig(chain);
          return { paused: c.paused, keyId: c.ticketKeyId };
        },
      },
    },
  },
});
// Every client in this process reaches the referee at relay.test; everything else goes out as usual (only to RPC).
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "relay.test") return relay.fetch(new Request(url, init));
  return realFetch(input, init);
}) as typeof globalThis.fetch;
const sweep = setInterval(() => void relay.fetch(new Request("https://relay.test/api/arena/sweep")).catch(() => undefined), 31_000);

// ---------------------------------------------------------------- two agents: home, policy, registration, server, daemon

const POLICY = { version: 1, cluster: "devnet", live: true, actions: ["wager"], max_sol_per_tx: 0.2, max_sol_per_day: 1, max_slippage_bps: 100, transfer_allowlist: [], wagers: { max_stake_sol: STAKE_SOL, max_open: 1, tiers: [STAKE_SOL], allow_retire: true } };
const daemons = new AbortController();

interface Agent {
  name: string;
  wallet: string;
  call: (tool: string, args?: Record<string, unknown>) => Promise<any>;
}

async function agent(name: string, key: Keypair, n: number): Promise<Agent> {
  const home = join(dir, name);
  const paths = agentPaths({ HIGHWIRE_HOME: home });
  const keyFile = join(dir, `${name}-key.json`);
  writeFileSync(keyFile, JSON.stringify([...key.secretKey]), { mode: 0o600 });
  // Registered as line_register would: a launch and the challenge memo on the referee's (fake) mainnet RPC.
  const mint = bs58.encode(new Uint8Array(32).fill(200 + n));
  coins.coins.set(mint, { name, ticker: name.toUpperCase(), createdAt: 0, holders: 1, volumeSol: 0, rugFlag: false, creatorHolds: true, creator: key.publicKey.toBase58() });
  const post = (path: string, body: unknown) => relay.fetch(new Request(`https://relay.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).then((r) => r.json() as Promise<any>);
  const secret = createHash("sha256").update(name).digest("hex");
  const launch = rpcFake.add(launchTx({ payer: key.publicKey.toBase58(), mint }));
  const ch = await post("/api/agents/challenge", { wallet: key.publicKey.toBase58(), mint, launchSignature: launch, secretHash: createHash("sha256").update(secret).digest("hex") });
  const memo = rpcFake.add(memoTx(key.publicKey.toBase58(), ch.memo, Date.now() + 2_000));
  const reg = await post("/api/agents/register", { code: ch.code, signature: memo, secret });
  if (!reg.arenaToken) throw new Error(`${name} didn't register: ${JSON.stringify(reg)}`);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(paths.policy, JSON.stringify(POLICY));
  writeFileSync(paths.agent, JSON.stringify({ arena: { token: reg.arenaToken, fighter: mint, relay: "https://relay.test", registeredAt: "" } }), { mode: 0o600 });
  // Its reveal daemon, as `highwire-wager run` with the same environment as its server.
  const env = { HIGHWIRE_CLUSTER: "devnet", HIGHWIRE_HOME: home, HIGHWIRE_KEYPAIR_PATH: keyFile, SOLANA_RPC_URL: RPC, HIGHWIRE_RELAY_URL: "https://relay.test" };
  void runLine(["run"], { env, signal: daemons.signal, out: () => undefined, err: (l) => (/WARNING|refused|failed/i.test(l) ? log(`${name} run`, l.slice(9)) : undefined) });
  const server = createServer({ cluster: "devnet", rpcUrl: RPC, relayUrl: "https://relay.test", arena: true, wagers: registerWagerTools, signer: new LocalSigner(key, paths) });
  const client = new Client({ name: `rehearse-${name}`, version: "0" });
  const [x, y] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(x), client.connect(y)]);
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const body = JSON.parse((res.content as { text: string }[])[0]!.text);
    return res.isError ? { error: body } : body;
  };
  return { name, wallet: key.publicKey.toBase58(), call };
}

const a = await agent("alpha", keys.a, 1);
const b = await agent("beta", keys.b, 2);
await sleep(4_000); // both daemons' first heartbeat

/** Stakes until in a live series; with `accept` false, A opens and B never accepts. Returns the series id. */
async function stakeIn(p: Agent, accept = true): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const r = await p.call("line_stake", { stake: STAKE_SOL, fallback: "steady:2", confirm: true });
    // A pairing whose ticket ran out unopened (the pause, in step 4) holds both until the desk lets it go.
    if (r.error && /expired|paused/i.test(String(r.error.error))) {
      await sleep(15_000);
      continue;
    }
    if (r.error) throw new Error(`${p.name}: line_stake: ${r.error.error}`);
    if (r.waiting) continue;
    if (r.waiting_for_opener) {
      if (!accept) return r.series;
      await sleep(2_000);
      continue;
    }
    if (r.staked) log(p.name, `staked as ${r.you} in ${String(r.series).slice(0, 8)} (${r.staked.status})`);
    if (!accept && r.staked && r.you === "A") return r.series;
    if (r.staked && r.staked.status !== "sent") throw new Error(`${p.name}: the stake didn't land: ${JSON.stringify(r.staked)}`);
    if (r.status === "live" || (r.staked && r.you === "B")) return r.series;
    const s = await p.call("line_state", { series: r.series, wait: true });
    if (s.status === "live") return r.series;
  }
  throw new Error(`${p.name}: never paired`);
}

/** Plays until the series ends; `skip` names one (match, round) this side won't commit, so its fallback plays. */
async function play(p: Agent, series: string, skip?: { match: number; round: number }): Promise<any> {
  for (;;) {
    const s = await p.call("line_state", { series, wait: true });
    if (s.error) {
      await sleep(2_000);
      continue;
    }
    if (s.status === "closed") return s;
    if (s.ending || !s.your_move) {
      if (s.ending) await sleep(3_000);
      continue;
    }
    if (skip && s.match === skip.match && s.round === skip.round) {
      log(p.name, `skipping match ${s.match} round ${s.round}: its fallback will play`);
      await sleep(5_000);
      continue;
    }
    const pull = Math.floor(Math.random() * (Math.min(6, s.energy.you) + 1));
    const m = await p.call("line_move", { series, series_match: s.match, round: s.round, pull });
    if (m.error) log(p.name, `line_move: ${m.error.error}`);
  }
}

const balance = async (w: string) => connection.getBalance(new PublicKey(w));
const waitClosed = async (series: string, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(3_000)) {
    const o = await seriesOutcome(chain, series);
    if (o.state === "closed") return o;
  }
  return seriesOutcome(chain, series);
};

try {
  // 1. A full series, with a missed commit.
  log("rehearse", "1. a full series");
  const before = { a: await balance(a.wallet), b: await balance(b.wallet), fee: await balance(keys.fee.publicKey.toBase58()) };
  const [s1a, s1b] = await Promise.all([stakeIn(a), stakeIn(b)]);
  check("both sides staked into one series", s1a === s1b, s1a.slice(0, 8));
  const [ea, eb] = await Promise.all([play(a, s1a, QUICK ? undefined : { match: 1, round: 2 }), play(b, s1a)]);
  const o1 = await waitClosed(s1a, 60_000);
  check("the program closed it, settled", o1.state === "closed" && "how" in o1 && o1.how === "settled", JSON.stringify(o1));
  const winnerSide = o1.state === "closed" && o1.how === "settled" ? o1.winner : null;
  check("both agents' views agree with the program", (ea.result === "win") === (ea.you === winnerSide) && (eb.result === "win") === (eb.you === winnerSide), `${ea.result}/${eb.result}, winner ${winnerSide}`);
  const after = { a: await balance(a.wallet), b: await balance(b.wallet), fee: await balance(keys.fee.publicKey.toBase58()) };
  const fee = Math.round(2 * STAKE_SOL * SOL * 0.025);
  check("the fee account got 2.5% of the pot", after.fee - before.fee === fee, `${after.fee - before.fee} lamports`);
  const net = { a: after.a - before.a, b: after.b - before.b };
  const won = ea.result === "win" ? net.a : net.b;
  const lost = ea.result === "win" ? net.b : net.a;
  check("the winner gained about the other's stake less the fee", Math.abs(won - (STAKE_SOL * SOL - fee)) < 0.002 * SOL, `${won} lamports`);
  check("the loser lost about its stake", Math.abs(lost + STAKE_SOL * SOL) < 0.002 * SOL, `${lost} lamports`);
  await sleep(32_000);
  const w = await a.call("line_wagers");
  check("the referee recorded and rated it", (w.you?.record?.win ?? 0) + (w.you?.record?.loss ?? 0) === 1, JSON.stringify(w.you?.record));

  // 2. Retire.
  log("rehearse", "2. a series one side retires from");
  const [s2] = await Promise.all([stakeIn(a), stakeIn(b)]);
  const r = await b.call("line_retire", { series: s2, confirm: true });
  check("line_retire sent", !r.error, r.error?.error ?? "");
  const o2 = await waitClosed(s2, 60_000);
  const bSide = (await b.call("line_state", { series: s2 })).you;
  check("the retired series settled to the other side", o2.state === "closed" && "how" in o2 && o2.how === "settled" && o2.winner !== bSide, JSON.stringify(o2));
  await sleep(32_000);

  // 3. B never accepts: a daemon cancels after the accept deadline (60 s here) and its margin (90 s), refunding A.
  log("rehearse", "3. a series B never accepts");
  // Roles are the desk's to pick: whichever side is paired as B doesn't accept; A opens as usual.
  const [opened] = await Promise.all([stakeIn(a, false), stakeIn(b, false)]);
  const o3 = await waitClosed(opened, 240_000);
  check("the unaccepted series was cancelled", o3.state === "closed" && "how" in o3 && o3.how === "cancelled", JSON.stringify(o3));
  await sleep(32_000);

  // 4. Paused: no stake opens. Unpaused, a live series frozen and refunded.
  log("rehearse", "4. pause, unpause, freeze");
  await admin(pauseInstruction(PROGRAM, keys.authority.publicKey, true));
  await sleep(31_000); // the desk reads the program's config at most every 30 seconds
  const paused = await Promise.all([a.call("line_stake", { stake: STAKE_SOL, fallback: "zero", confirm: true }), b.call("line_stake", { stake: STAKE_SOL, fallback: "zero", confirm: true })]);
  check("the desk refused to pair while paused", paused.every((x) => /paused/i.test(String(x.error?.error ?? ""))), paused.map((x) => x.error?.error ?? JSON.stringify(x)).join(" | "));
  await admin(pauseInstruction(PROGRAM, keys.authority.publicKey, false));
  const [s4] = await Promise.all([stakeIn(a), stakeIn(b)]);
  const before4 = { a: await balance(a.wallet), b: await balance(b.wallet) };
  await admin(freezeAndRefundInstruction(PROGRAM, keys.authority.publicKey, s4, { playerA: keys.a.publicKey, playerB: keys.b.publicKey }));
  const o4 = await seriesOutcome(chain, s4);
  check("the frozen series was refunded", o4.state === "closed" && "how" in o4 && o4.how === "refunded", JSON.stringify(o4));
  const back = { a: (await balance(a.wallet)) - before4.a, b: (await balance(b.wallet)) - before4.b };
  check("both stakes came back in full", back.a >= STAKE_SOL * SOL && back.b >= STAKE_SOL * SOL, `${back.a}, ${back.b} lamports`);
} catch (err) {
  check("the rehearsal ran to the end", false, err instanceof Error ? err.message : String(err));
} finally {
  daemons.abort();
  clearInterval(sweep);
}

const failed = results.filter((x) => !x.ok);
console.log(`\n== ${results.length - failed.length} of ${results.length} checks passed in ${Math.round((Date.now() - t0) / 60_000)} minutes`);
for (const f of failed) console.log(`FAIL ${f.what}: ${f.detail}`);
process.exit(failed.length ? 1 : 0);
