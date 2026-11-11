// A scripted practice series on devnet (docs/wager-devnet.md 7): two fighters, each through its own MCP server, local
// signer, devnet home and policy, play one best-of-5 wager series against each other, start to finish, using only the
// tools an agent uses (line_stake, line_state, line_move). The two reveal daemons (`highwire line run`) must be running:
// they reveal and settle. At the end it checks the result three ways: the program's closing event, the referee's record,
// and both wallets' balances.
//
// It signs and sends real devnet transactions from both wallets, inside their devnet policies. Run by the maintainer;
// it never prints a key, a nonce or a salt.
//
//   npm run wager-pair -w highwire-mcp -- --a ~/.highwire-lgtm-devnet:~/.highwire/buyback-coin/wallet.json \
//     --b ~/.highwire-mc-devnet:~/.highwire/second-fighter/wallet.json [--stake 0.01]
//
// Each side is HIGHWIRE_HOME:keypair file. SOLANA_RPC_URL sets the devnet RPC (default devnet's public one).
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { agentPaths, loadKeypair, LocalSigner } from "highwire-agent";
import { Chain, DEFAULT_RPC_URLS, lamportsNumber, seriesOutcome } from "highwire-core";
import { createServer } from "../src/server.ts";

const { values } = parseArgs({ options: { a: { type: "string" }, b: { type: "string" }, stake: { type: "string" } } });
const expand = (p: string) => p.replace(/^~(?=\/)/, homedir());
const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URLS.devnet;
const stake = Number(values.stake ?? "0.01");
const t0 = Date.now();
const log = (who: string, line: string) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s  ${who.padEnd(14)} ${line}`);

interface Player {
  name: string;
  wallet: string;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
}

async function player(spec: string | undefined, label: string): Promise<Player> {
  if (!spec || !spec.includes(":")) throw new Error(`--${label} is HIGHWIRE_HOME:keypair file`);
  const [home, key] = spec.split(":").map(expand) as [string, string];
  const { keypair, warning } = loadKeypair(key);
  if (warning) console.error(`warning (${label}): ${warning}`);
  const signer = new LocalSigner(keypair, agentPaths({ HIGHWIRE_HOME: home }));
  const server = createServer({ cluster: "devnet", rpcUrl, signer, arena: true, wagers: true });
  const client = new Client({ name: `wager-pair-${label}`, version: "0" });
  const [x, y] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(x), client.connect(y)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const body = JSON.parse((res.content as { text: string }[])[0]!.text);
    return res.isError ? { error: body } : body;
  };
  return { name: label, wallet: signer.wallet, call };
}

/** Stakes until this side is in a live series; returns its id. */
async function stakeIn(p: Player): Promise<string> {
  for (;;) {
    const r = await p.call("line_stake", { stake, fallback: "steady:2", confirm: true });
    if (r.error) throw new Error(`${p.name}: line_stake: ${r.error.error} (${r.error.code})`);
    if (r.waiting) {
      log(p.name, `waiting to be paired (${r.waiting_at_this_tier} at this tier, ${r.owners_needed} owners needed)`);
      continue;
    }
    if (r.waiting_for_opener) {
      log(p.name, `paired as B in ${r.series.slice(0, 8)}; waiting for A to open`);
      await new Promise((ok) => setTimeout(ok, 3_000));
      continue;
    }
    if (r.staked) log(p.name, `paired as ${r.you} in ${r.series.slice(0, 8)}: staked ${r.stake_sol} SOL (${r.staked.status}${r.staked.confirmed ? ", confirmed" : ""})`);
    if (r.staked && (r.staked.status !== "sent" || !r.staked.confirmed)) throw new Error(`${p.name}: the stake didn't land: ${JSON.stringify(r.staked)}`);
    if (r.status === "live" || (r.staked && r.you === "B")) return r.series;
    // A, opened: wait for B to accept.
    const s = await p.call("line_state", { series: r.series, wait: true });
    if (s.status === "live") return r.series;
    log(p.name, "opened; waiting for B to accept");
  }
}

/** Plays this side until the series ends: a move whenever it's this side's turn, a modest random pull. */
async function play(p: Player, series: string): Promise<any> {
  let last = "";
  for (;;) {
    const s = await p.call("line_state", { series, wait: true });
    if (s.error) {
      log(p.name, `line_state: ${s.error.error}`);
      await new Promise((ok) => setTimeout(ok, 3_000));
      continue;
    }
    if (s.status === "closed") return s;
    const where = `match ${s.match}, round ${s.round}, ${s.phase}: node ${s.node}, energy ${s.energy?.you}/${s.energy?.them}, score ${s.score?.you}-${s.score?.them}`;
    if (where !== last) {
      log(p.name, where);
      last = where;
    }
    if (s.ending) {
      log(p.name, `series over: ${s.ending.result} (${s.ending.how}); waiting for the daemon to settle`);
      await new Promise((ok) => setTimeout(ok, 5_000));
      continue;
    }
    if (!s.your_move) continue;
    const pull = Math.floor(Math.random() * (Math.min(6, s.energy.you) + 1));
    const m = await p.call("line_move", { series, series_match: s.match, round: s.round, pull });
    if (m.error) {
      // A refusal (the daemon is down, say) stays until something changes: don't hammer the RPC meanwhile.
      log(p.name, `line_move: ${m.error.error} (${m.error.code})`);
      await new Promise((ok) => setTimeout(ok, 5_000));
    } else log(p.name, `committed ${pull} (${m.committed.status}${m.committed.confirmed ? ", confirmed" : ""})`);
  }
}

const a = await player(values.a, "a");
const b = await player(values.b, "b");
a.name = `a ${a.wallet.slice(0, 4)}`;
b.name = `b ${b.wallet.slice(0, 4)}`;
const connection = new Connection(rpcUrl, "confirmed");
const before = { a: await connection.getBalance(new PublicKey(a.wallet)), b: await connection.getBalance(new PublicKey(b.wallet)) };
log("pair", `${a.wallet} and ${b.wallet}, ${stake} SOL a side, on ${rpcUrl.replace(/\?.*$/, "")}`);
for (const p of [a, b]) {
  const w = await p.call("line_wagers");
  if (w.error) throw new Error(`${p.name}: line_wagers: ${w.error.error}`);
  log(p.name, `reveal daemon: ${w.reveal_daemon}`);
  if (!String(w.reveal_daemon).startsWith("working")) throw new Error("start both reveal daemons first");
}

const [sa, sb] = await Promise.all([stakeIn(a), stakeIn(b)]);
if (sa !== sb) throw new Error(`paired into different series: ${sa} and ${sb}`);
log("pair", `series ${sa} is live`);
const [ea, eb] = await Promise.all([play(a, sa), play(b, sa)]);

const outcome = await seriesOutcome(new Chain({ cluster: "devnet", rpcUrl }), sa);
const after = { a: await connection.getBalance(new PublicKey(a.wallet)), b: await connection.getBalance(new PublicKey(b.wallet)) };
const [wa, wb] = [await a.call("line_wagers"), await b.call("line_wagers")];
console.log("\n== result");
console.log(`series ${sa}`);
console.log(`a (${a.wallet}): ${ea.result} as ${ea.you ?? "?"}; balance ${lamportsNumber(BigInt(after.a - before.a))} SOL (fees and rent included); referee record ${JSON.stringify(wa.you?.record)}`);
console.log(`b (${b.wallet}): ${eb.result} as ${eb.you ?? "?"}; balance ${lamportsNumber(BigInt(after.b - before.b))} SOL; referee record ${JSON.stringify(wb.you?.record)}`);
console.log(`the program's closing event: ${JSON.stringify(outcome)}`);
const agree = outcome.state === "closed" && ((ea.result === "win") !== (eb.result === "win") || (ea.result === "draw" && eb.result === "draw"));
console.log(agree ? "both sides and the chain agree on the result" : "MISMATCH: check the series on an explorer");
console.log(`took ${Math.round((Date.now() - t0) / 60_000)} minutes`);
process.exit(agree ? 0 : 1);
