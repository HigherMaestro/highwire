// Link battles' practice stakes rehearsed end to end on a local validator (docs/link-wager.md 4): the compiled
// program, two agents' MCP servers with real LocalSigners and policies, the referee's stake desk and referee (in
// process, with their own ticket and result keys), and the daemons (`highwire-wager run`, in process). Only the game is
// replaced: a fake engine where each side has three hits in it, so the rehearsal needs no ROM. It plays:
//
//   0. the config set up by the authority, with this rehearsal's two keys;
//   1. a battle to a knockout, settled by the winner's link_settle: the winner is paid both stakes;
//   2. a battle both lose at once (a draw), settled by link_settle: both are refunded;
//   3. a battle voided on purpose (the engine refuses every turn), settled as a void: both are refunded;
//   4. the config paused: nothing new is paired;
//   5. a stake nobody accepts, cancelled by a daemon after the deadline (skipped with --quick: two minutes);
//   6. a battle one agent walks away from mid-battle: it forfeits, and a daemon settles with no tool call.
//
// After each it checks the program's own closing event, both wallets' balances, the desk's record, and that the free
// ladder never moved. The refund after the program's deadline isn't rehearsed here (30 minutes at the least;
// programs/link-wager/tests covers it with a moved clock).
//
// It never touches a public cluster: `solana-test-validator` runs locally on a throwaway ledger, its wallets come from
// fixed seeds and are funded in that ledger's genesis (no airdrop), and the validator stops at the end. The program
// runs at the address its source declares, which nobody holds a key for: a local ledger needs none.
//
//   (cd programs/link-wager && cargo build-sbf)    # once, for target/deploy/link_wager.so
//   npm run rehearse-link-wagers -w highwire-wager [-- --quick]
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ed25519 } from "@noble/curves/ed25519";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { agentPaths, GENESIS_HASHES } from "highwire-agent";
import { Chain } from "highwire-core";
import { createServer } from "highwire-mcp";
import { createRelay, MemoryStore, realClock } from "highwire-relay";
import { FakeCoins, FakeLinkEngine, FakeRpc, launchTx, memoTx } from "highwire-relay/testing";
import { runLine } from "../src/line-cli.ts";
import { LINK_BATTLE_LEN, linkConfigUpdateInstruction, linkInitConfigInstruction } from "../src/link-codec.ts";
import { linkBattleOutcome, readLinkBattle, readLinkConfig } from "../src/link-tx.ts";
import { wagerSigner } from "../src/signing.ts";
import { wagerToolsFor } from "../src/tools.ts";

const QUICK = process.argv.includes("--quick");
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PROGRAM_DIR = join(ROOT, "programs/link-wager");
const SO = join(PROGRAM_DIR, "target/deploy/link_wager.so");
const PORT = 18_999;
const RPC = `http://127.0.0.1:${PORT}`;
const STAKE_SOL = 0.1;
const SOL = 1_000_000_000;
const STAKE = BigInt(STAKE_SOL * SOL);
const TICKET_SECRET = new Uint8Array(32).fill(43);
const RESULT_SECRET = new Uint8Array(32).fill(44);
const ACCEPT_SECONDS = 25;

const t0 = Date.now();
const log = (who: string, line: string) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s  ${who.padEnd(10)} ${line}`);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const results: { what: string; ok: boolean; detail: string }[] = [];
const check = (what: string, ok: boolean, detail = "") => {
  results.push({ what, ok, detail });
  log("check", `${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
};

if (!existsSync(SO)) {
  console.error("rehearse-link-wagers: build the program first: (cd programs/link-wager && cargo build-sbf)");
  process.exit(2);
}
// A build older than the program's source rehearses the wrong program.
const sources = [...readdirSync(join(PROGRAM_DIR, "src")).map((f) => join(PROGRAM_DIR, "src", f)), join(PROGRAM_DIR, "Cargo.toml"), join(PROGRAM_DIR, "Cargo.lock")];
const stale = sources.filter((f) => statSync(f).mtimeMs > statSync(SO).mtimeMs);
if (stale.length) {
  console.error(`rehearse-link-wagers: ${SO} is older than ${stale.map((f) => f.slice(ROOT.length)).join(", ")}; rebuild it: (cd programs/link-wager && cargo build-sbf)`);
  process.exit(2);
}
// The address the program's source declares: the program checks its own accounts against it.
const declared = /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(readFileSync(join(PROGRAM_DIR, "src/lib.rs"), "utf8"))?.[1];
if (!declared) {
  console.error("rehearse-link-wagers: couldn't read the program's address from programs/link-wager/src/lib.rs");
  process.exit(2);
}
const PROGRAM = new PublicKey(declared);

// ---------------------------------------------------------------- the local validator, funded at genesis

const seed = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n));
const keys = { authority: seed(71), a: seed(72), b: seed(73) };
const dir = mkdtempSync(join(tmpdir(), "highwire-rehearse-link-"));
const accountFile = (k: Keypair, sol: number) => {
  const file = join(dir, `${k.publicKey.toBase58()}.json`);
  writeFileSync(file, JSON.stringify({ pubkey: k.publicKey.toBase58(), account: { lamports: sol * SOL, data: ["", "base64"], owner: "11111111111111111111111111111111", executable: false, rentEpoch: 0, space: 0 } }));
  return ["--account", k.publicKey.toBase58(), file];
};
const validator = spawn(
  "solana-test-validator",
  ["--reset", "--quiet", "--ledger", join(dir, "ledger"), "--rpc-port", String(PORT), "--faucet-port", String(PORT + 1_002), "--dynamic-port-range", `${PORT + 1_010}-${PORT + 1_040}`, "--upgradeable-program", PROGRAM.toBase58(), SO, keys.authority.publicKey.toBase58(), ...accountFile(keys.authority, 10), ...accountFile(keys.a, 5), ...accountFile(keys.b, 5)],
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

const chain = new Chain({ cluster: "devnet", rpcUrl: RPC });
const stakes = { chain, program: PROGRAM };
const admin = (ix: Parameters<Transaction["add"]>[0]) =>
  sendAndConfirmTransaction(connection, new Transaction().add(ix), [keys.authority]).catch(async (err) => {
    console.error((await (err as { getLogs?: (c: Connection) => Promise<string[]> }).getLogs?.(connection))?.join("\n"));
    throw err;
  });
await admin(
  linkInitConfigInstruction(PROGRAM, keys.authority.publicKey, {
    authority: keys.authority.publicKey.toBase58(),
    ticketKey: bs58.encode(ed25519.getPublicKey(TICKET_SECRET)),
    ticketKeyId: 1,
    resultKey: bs58.encode(ed25519.getPublicKey(RESULT_SECRET)),
    resultKeyId: 1,
    tiers: [STAKE],
    maxStake: STAKE,
    openStakeCap: BigInt(5 * SOL),
    refundAfterSeconds: 1800,
  }),
);
const config0 = await readLinkConfig(stakes);
check("the config holds the two keys, apart", config0.ticketKey !== config0.resultKey && config0.tiers.length === 1 && !config0.paused);

// ---------------------------------------------------------------- the referee and its desk, in process, on this ledger

const rpcFake = new FakeRpc();
const coins = new FakeCoins(Date.now());
const engine = new FakeLinkEngine();
const relay = createRelay({
  store: new MemoryStore(realClock),
  clock: realClock,
  rpc: rpcFake,
  coins,
  link: {
    engine,
    rated: true,
    // Turns resolve right after the answer that completes them, as the site's after() does.
    defer: (task) => void setTimeout(() => void task().catch((err: unknown) => log("referee", `a deferred task failed: ${String(err)}`)), 0),
    // A side asked and silent for 15 seconds forfeits here (two minutes in production), so walking away is quick to see.
    arena: { goneMs: 15_000, longPollMs: 5_000 },
    stakes: {
      programId: PROGRAM.toBase58(),
      ticketSecret: TICKET_SECRET,
      ticketKeyId: 1,
      resultSecret: RESULT_SECRET,
      resultKeyId: 1,
      tiers: [STAKE],
      perPairPerWeek: 50,
      acceptSeconds: ACCEPT_SECONDS,
      longPollMs: 12_000,
      chain: {
        status: (id) => linkBattleOutcome(stakes, id),
        config: async () => {
          const c = await readLinkConfig(stakes);
          return { paused: c.paused, ticketKeyId: c.ticketKeyId, resultKeyId: c.resultKeyId };
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
const desk = relay.linkStakes!;

// ---------------------------------------------------------------- two agents: home, policy, registration, server

const POLICY = { version: 1, cluster: "devnet", live: true, actions: ["wager"], max_sol_per_tx: 0.5, max_sol_per_day: 4, max_slippage_bps: 100, transfer_allowlist: [], wagers: { max_stake_sol: STAKE_SOL, max_open: 1, tiers: [STAKE_SOL] } };
const daemons = new AbortController();

interface Agent {
  name: string;
  wallet: string;
  key: Keypair;
  mint: string;
  call: (tool: string, args?: Record<string, unknown>) => Promise<any>;
  /** Starts its daemon, as `highwire-wager run` with the same environment as its server. */
  daemon: () => void;
}

async function agent(name: string, key: Keypair, n: number): Promise<Agent> {
  const home = join(dir, name);
  const paths = agentPaths({ HIGHWIRE_HOME: home });
  const keyFile = join(dir, `${name}-key.json`);
  writeFileSync(keyFile, JSON.stringify([...key.secretKey]), { mode: 0o600 });
  // Registered as line_register would: a launch and the challenge memo on the referee's (fake) mainnet RPC.
  const mint = bs58.encode(new Uint8Array(32).fill(210 + n));
  coins.coins.set(mint, { name, ticker: name.toUpperCase(), createdAt: 0, holders: 1, volumeSol: 0, rugFlag: false, creatorHolds: true, creator: key.publicKey.toBase58() });
  const post = (path: string, body: unknown) => relay.fetch(new Request(`https://relay.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).then((r) => r.json() as Promise<any>);
  const secret = createHash("sha256").update(name).digest("hex");
  const launch = rpcFake.add(launchTx({ payer: key.publicKey.toBase58(), mint }));
  const ch = await post("/api/agents/challenge", { wallet: key.publicKey.toBase58(), mint, launchSignature: launch, secretHash: createHash("sha256").update(secret).digest("hex") });
  const memo = rpcFake.add(memoTx(key.publicKey.toBase58(), ch.memo, Date.now() + 2_000));
  const reg = await post("/api/agents/register", { code: ch.code, signature: memo, secret });
  if (!reg.arenaToken) throw new Error(`${name} didn't register: ${JSON.stringify(reg)}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(paths.policy, JSON.stringify(POLICY));
  writeFileSync(paths.agent, JSON.stringify({ arena: { token: reg.arenaToken, fighter: mint, relay: "https://relay.test", registeredAt: "" } }), { mode: 0o600 });
  const env = { HIGHWIRE_CLUSTER: "devnet", HIGHWIRE_HOME: home, HIGHWIRE_KEYPAIR_PATH: keyFile, SOLANA_RPC_URL: RPC, HIGHWIRE_RELAY_URL: "https://relay.test" };
  const daemon = () => void runLine(["run"], { env, signal: daemons.signal, linkProgram: PROGRAM, out: () => undefined, err: (l) => (/link battle|refused/i.test(l) ? log(`${name} run`, l.slice(10)) : undefined) });
  const server = createServer({ cluster: "devnet", rpcUrl: RPC, relayUrl: "https://relay.test", arena: true, link: true, wagers: wagerToolsFor({ linkProgram: PROGRAM }), signer: wagerSigner(key, paths, undefined, undefined, { linkProgram: PROGRAM }) });
  const client = new Client({ name: `rehearse-${name}`, version: "0" });
  const [x, y] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(x), client.connect(y)]);
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const body = JSON.parse((res.content as { text: string }[])[0]!.text);
    return res.isError ? { error: body } : body;
  };
  return { name, wallet: key.publicKey.toBase58(), key, mint, call, daemon };
}

const a = await agent("alpha", keys.a, 1);
const b = await agent("beta", keys.b, 2);
const both = [a, b];
const balance = (p: Agent) => connection.getBalance(p.key.publicKey, "confirmed");
const HIT = { kind: "move", slot: 0 };
const WAIT = { kind: "move", slot: 1 };
const STAKE_ARGS = { stake: STAKE_SOL, fallback: "first", confirm: true };

/** Both stake until the battle is on: who is A, the battle's id and the match. */
async function stakeIn(): Promise<{ battle: string; match: string; A: Agent; B: Agent }> {
  let battle = "";
  const role = new Map<string, "A" | "B">();
  for (let i = 0; i < 60; i++) {
    const answers = await Promise.all(both.map(async (p) => [p, await p.call("link_stake", STAKE_ARGS)] as const));
    for (const [p, r] of answers) {
      if (r.error) throw new Error(`${p.name} couldn't stake: ${JSON.stringify(r.error)}`);
      if (r.you) role.set(p.name, r.you);
      if (r.battle) battle = r.battle;
    }
    const A = both.find((p) => role.get(p.name) === "A");
    const B = both.find((p) => role.get(p.name) === "B");
    if (A && B) {
      const match = answers.map(([, r]) => r?.match).find((m) => typeof m === "string");
      if (match) return { battle, match, A, B };
    }
    await sleep(1_000);
  }
  throw new Error("the two agents never got a battle");
}

/**
 * A is paired and opens; B never gets the chance to accept. One agent at a time, so the side that turns out to be B
 * has made its last call before A's stake lands: the first waits, the second is paired, and whichever is A then opens.
 */
async function openOnly(): Promise<{ battle: string; A: Agent; B: Agent }> {
  for (let i = 0; i < 20; i++) {
    const first = await a.call("link_stake", STAKE_ARGS);
    if (first.error) throw new Error(`alpha couldn't stake: ${JSON.stringify(first.error)}`);
    const second = await b.call("link_stake", STAKE_ARGS);
    if (second.error) throw new Error(`beta couldn't stake: ${JSON.stringify(second.error)}`);
    if (!second.battle) continue;
    const [A, B] = second.you === "A" ? [b, a] : [a, b];
    // B was told to wait for the opener; A opens now (it has, if it was the one that made the pairing).
    if (second.you === "B") {
      const opened = await a.call("link_stake", STAKE_ARGS);
      if (opened.error) throw new Error(`alpha couldn't open: ${JSON.stringify(opened.error)}`);
    }
    for (let j = 0; j < 20; j++) {
      if ((await readLinkBattle(stakes, second.battle))?.status === "open") return { battle: second.battle, A, B };
      await sleep(500);
    }
    throw new Error("A's stake never landed");
  }
  throw new Error("the two agents were never paired");
}

/** Plays the battle on until it ends: each agent that's asked answers with `choose(its engine side)`; null answers nothing. */
async function play(choose: (p: Agent, side: 0 | 1) => typeof HIT | null, limit = 90): Promise<void> {
  for (let i = 0; i < limit * 2; i++) {
    let ended = 0;
    for (const p of both) {
      const v = await p.call("link_state", { wait: false });
      if (v.error) throw new Error(`${p.name}: ${JSON.stringify(v.error)}`);
      if (v.status === "ended") ended++;
      else if (v.status === "your_decision") {
        const action = choose(p, v.view.only_for === "side 0" ? 0 : 1);
        if (action) await p.call("link_move", { action, turn: v.turn });
      }
    }
    if (ended === 2) return;
    await sleep(500);
  }
  throw new Error("the battle never ended");
}

const closed = async (battle: string) => {
  for (let i = 0; i < 40; i++) {
    const o = await linkBattleOutcome(stakes, battle);
    if (o.state === "closed") return o.how;
    await sleep(1_000);
  }
  return "still open";
};
const near = (got: number, want: number) => Math.abs(got - want) < 0.001 * SOL;
const ladderMoved = async () => {
  const board = (await (await relay.fetch(new Request("https://relay.test/api/link/leaderboard"))).json()) as { fighters: { rating: number; record: { rated: { win: number; loss: number; draw: number }; unrated: { win: number; loss: number; draw: number } } }[] };
  return board.fighters.some((f) => f.rating !== 1500 || Object.values(f.record.rated).some(Boolean) || Object.values(f.record.unrated).some(Boolean));
};
const deskResult = async (p: Agent) => {
  const token = JSON.parse(readFileSync(join(dir, p.name, "agent.json"), "utf8")).arena.token as string;
  return (await (await relay.fetch(new Request("https://relay.test/api/link/stake/state", { headers: { authorization: `Bearer ${token}` } }))).json()) as { status?: string; closed?: string; result?: { you: string; result: { outcome: string } }; you: { rating: number; record: { win: number; draw: number; loss: number } } };
};

try {
  // ---------------------------------------------------------------- 1. a knockout, settled by the winner's tool
  {
    const before = await Promise.all(both.map(balance));
    const s = await stakeIn();
    log("battle 1", `${s.A.name} is A; battle ${s.battle.slice(0, 8)}, match ${s.match}`);
    const onChain = await readLinkBattle(stakes, s.battle);
    check("1: both stakes are in the program's battle account", onChain?.status === "live" && onChain.stake === STAKE && onChain.playerA === s.A.wallet && onChain.playerB === s.B.wallet);
    let winner: Agent | null = null;
    await play((p, side) => {
      if (side === 0) winner = p;
      return side === 0 ? HIT : WAIT;
    });
    const w = winner as unknown as Agent;
    const l = both.find((p) => p !== w)!;
    const paid = await w.call("link_settle", { confirm: true });
    check("1: the winner's link_settle sent the referee's result", paid.settled?.[0]?.did === "settle" && paid.settled[0].sent?.confirmed === true, JSON.stringify(paid.settled?.[0] ?? paid));
    check("1: the program's closing event says settled", (await closed(s.battle)) === "settled");
    const after = await Promise.all(both.map(balance));
    const delta = (p: Agent) => after[both.indexOf(p)]! - before[both.indexOf(p)]!;
    check("1: the winner is up one stake, the loser down one (less fees)", near(delta(w), Number(STAKE)) && near(delta(l), -Number(STAKE)), `${w.name} ${delta(w) / SOL}, ${l.name} ${delta(l) / SOL}`);
    await relay.fetch(new Request("https://relay.test/api/arena/sweep"));
    const [dw, dl] = [await deskResult(w), await deskResult(l)];
    check("1: the desk's practice record shows the win and the loss, and the stake closed as settled", dw.you.record.win === 1 && dl.you.record.loss === 1 && (dw.closed === "settled" || dw.status === "over"), `${dw.status}/${dw.closed}`);
    check("1: the free ladder didn't move", !(await ladderMoved()));
    check("1: nothing of the loser's is left on-chain", (await l.call("link_settle", { confirm: true })).settled?.length === 0);
  }

  // ---------------------------------------------------------------- 2. a draw, refunded
  {
    const before = await Promise.all(both.map(balance));
    const s = await stakeIn();
    log("battle 2", `battle ${s.battle.slice(0, 8)}: both hit every turn`);
    await play(() => HIT);
    const out = await s.B.call("link_settle", { confirm: true });
    check("2: a draw settles as a refund of both", out.settled?.[0]?.did === "settle" && /draw: both refunded/.test(String(out.settled[0].result)), JSON.stringify(out.settled?.[0] ?? out));
    check("2: the program's closing event says settled", (await closed(s.battle)) === "settled");
    const after = await Promise.all(both.map(balance));
    check("2: both wallets are back where they were (less fees)", both.every((_, i) => near(after[i]! - before[i]!, 0)), both.map((p, i) => `${p.name} ${(after[i]! - before[i]!) / SOL}`).join(", "));
  }

  // ---------------------------------------------------------------- 3. a void on purpose, refunded
  {
    const before = await Promise.all(both.map(balance));
    const s = await stakeIn();
    log("battle 3", `battle ${s.battle.slice(0, 8)}: the engine refuses every turn`);
    engine.refuse = () => true;
    await play(() => HIT);
    engine.refuse = null;
    const view = await s.A.call("link_state", { wait: false });
    check("3: the battle was voided, after fallbacks were tried in the refused decisions' place", view.ended?.reason === "void", JSON.stringify(view.ended));
    const out = await s.A.call("link_settle", { confirm: true });
    check("3: a void settles as a refund of both", out.settled?.[0]?.did === "settle" && /void: both refunded/.test(String(out.settled[0].result)), JSON.stringify(out.settled?.[0] ?? out));
    await closed(s.battle);
    const after = await Promise.all(both.map(balance));
    check("3: both wallets are back where they were (less fees)", both.every((_, i) => near(after[i]! - before[i]!, 0)));
    const d = await deskResult(s.A);
    check("3: a void rates nothing", d.you.record.win + d.you.record.loss + d.you.record.draw === 2, JSON.stringify(d.you.record));
  }

  // ---------------------------------------------------------------- 4. paused: nothing new is paired
  {
    await admin(linkConfigUpdateInstruction(PROGRAM, keys.authority.publicKey, { paused: true }));
    await sleep(31_000); // the desk reads the config at most every 30 seconds
    const r = await a.call("link_stake", STAKE_ARGS);
    check("4: with the program paused, the desk pairs nobody", /paused/i.test(String(r.error?.error)), JSON.stringify(r.error ?? r).slice(0, 200));
    await admin(linkConfigUpdateInstruction(PROGRAM, keys.authority.publicKey, { paused: false }));
    await sleep(31_000);
  }

  // The daemons from here: what's left is settled, cancelled or refunded with no tool call.
  for (const p of both) p.daemon();

  // ---------------------------------------------------------------- 5. a stake nobody accepts, cancelled by the opener's daemon
  if (!QUICK) {
    const before = await Promise.all(both.map(balance));
    const s = await openOnly();
    log("battle 5", `battle ${s.battle.slice(0, 8)}: ${s.A.name} opened; ${s.B.name} never accepts`);
    const mid = await balance(s.A);
    // The opener also pays the battle account's rent, which comes back to it when the account closes.
    const rent = await connection.getMinimumBalanceForRentExemption(LINK_BATTLE_LEN);
    check("5: the opener's stake (and the battle account's rent) left its wallet", near(mid - before[both.indexOf(s.A)]!, -(Number(STAKE) + rent)), `${(mid - before[both.indexOf(s.A)]!) / SOL}`);
    let how = "still open";
    for (let i = 0; i < 200 && how === "still open"; i++) {
      const o = await linkBattleOutcome(stakes, s.battle);
      if (o.state === "closed") how = o.how;
      else await sleep(1_000);
    }
    check("5: a daemon cancelled it after the deadline and its margin", how === "cancelled", how);
    check("5: the opener has its stake back (less fees)", near((await balance(s.A)) - before[both.indexOf(s.A)]!, 0));
  }

  // ---------------------------------------------------------------- 6. an agent walks away; the other side's daemon settles
  {
    const before = await Promise.all(both.map(balance));
    const s = await stakeIn();
    const gone = s.A;
    const stayed = s.B;
    log("battle 6", `battle ${s.battle.slice(0, 8)}: ${gone.name} stops answering; no tool settles`);
    for (let i = 0; i < 80; i++) {
      const v = await stayed.call("link_state", { wait: false });
      if (v.status === "ended") break;
      if (v.status === "your_decision") await stayed.call("link_move", { action: HIT, turn: v.turn });
      await sleep(1_000);
    }
    const end = await stayed.call("link_state", { wait: false });
    check("6: the side that walked away forfeited", end.ended?.reason === "forfeit" && end.ended?.result === "won", JSON.stringify(end.ended));
    check("6: a daemon settled it, with no tool call", (await closed(s.battle)) === "settled");
    const after = await Promise.all(both.map(balance));
    const delta = (p: Agent) => after[both.indexOf(p)]! - before[both.indexOf(p)]!;
    check("6: the side that stayed is up one stake", near(delta(stayed), Number(STAKE)) && near(delta(gone), -Number(STAKE)), `${stayed.name} ${delta(stayed) / SOL}`);
  }

  const config = await readLinkConfig(stakes);
  check("the program's open-stake counter is back to zero", config.openStake === 0n, String(config.openStake));
  const played = await desk.played();
  check("the practice page's list has the battles that were played, and no amounts", played.length === 4 && !JSON.stringify(played).includes(String(STAKE)), `${played.length} battles`);
} finally {
  clearInterval(sweep);
  daemons.abort();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => f.what).join("; ")}` : ""}`);
stop();
process.exit(failed.length ? 1 : 0);
