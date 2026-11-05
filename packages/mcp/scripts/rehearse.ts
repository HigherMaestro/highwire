// Live rehearsal of the local signer. Runs the real MCP server in-process with a
// signer for a public wallet found on-chain and a "live": true policy, then calls
// the execute tools against the real cluster: build, policy, audit log, a fresh
// re-simulation and signing all run for real. Only the network send is replaced:
// the signer holds an all-zero key, so its signature is worthless, and
// sendRawTransaction re-simulates the exact signed bytes (sigVerify off) instead of
// sending them. Nothing reaches the chain, no airdrop, no keypair is created.
// Run with `npm run rehearse` (needs network access). SIM_CLUSTERS=devnet picks one.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LaunchpadPool } from "@raydium-io/raydium-sdk-v2";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { agentPaths, LocalSigner } from "highwire-agent";
import { Chain, DEFAULT_RPC_URLS, type Cluster } from "highwire-core";
import { createServer, serverOptionsFromEnv } from "../src/index.ts";

const clusters = (process.env.SIM_CLUSTERS ?? "mainnet,devnet").split(",") as Cluster[];
const rpcFor = (c: Cluster) => (c === "mainnet" ? process.env.SOLANA_RPC_URL : process.env.SOLANA_DEVNET_RPC_URL) || DEFAULT_RPC_URLS[c];
const pause = (ms = 3000) => new Promise((r) => setTimeout(r, ms));

// The one replaced step. Everything before it in LocalSigner runs unchanged.
const sends: { signature: string; signed: boolean; simulated: string }[] = [];
Connection.prototype.sendRawTransaction = async function (this: Connection, raw) {
  const tx = VersionedTransaction.deserialize(Uint8Array.from(raw as Uint8Array));
  const signed = tx.signatures[0]!.some((b) => b !== 0);
  const sim = await this.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  const simulated = sim.value.err ? `FAILED ${JSON.stringify(sim.value.err)}` : `ok, ${sim.value.unitsConsumed} CU`;
  const signature = bs58.encode(tx.signatures[0]!);
  sends.push({ signature, signed, simulated });
  if (sim.value.err) throw new Error(`the signed bytes don't simulate: ${simulated}`);
  return signature;
};
Connection.prototype.confirmTransaction = async () => ({ context: { slot: 0 }, value: { err: null } });
Connection.prototype.getTransaction = (async () => null) as Connection["getTransaction"];

interface Row {
  cluster: Cluster;
  what: string;
  ok: boolean;
  result: string;
}
const rows: Row[] = [];

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** A curve coin and a public wallet that holds it and SOL. */
async function findWallet(cluster: Cluster, chain: Chain): Promise<{ wallet: string; mint: string; tokens: number }> {
  const hasSol = async (w: string, min: number) => (await chain.connection.getBalance(new PublicKey(w))) >= min;
  if (cluster === "mainnet") {
    const { items } = await getJson("https://api.higher.fun/coins?sort=trending&limit=30");
    for (const coin of items.filter((c: any) => c.status === "curve").slice(0, 5)) {
      const { items: holders } = await getJson(`https://api.higher.fun/coins/${coin.mint}/holders`);
      for (const h of holders.filter((h: any) => !h.isCurve && !h.isCreator).slice(0, 6)) {
        if (await hasSol(h.wallet, 0.2e9)) return { wallet: h.wallet, mint: coin.mint, tokens: Math.min(10_000, Math.floor(Number(h.balance) / 1e6 / 10)) };
        await pause(400);
      }
    }
    throw new Error("no mainnet holder with 0.2 SOL");
  }
  for (const platform of [chain.addresses.rewardsPlatform, chain.addresses.classicPlatform]) {
    const accounts = await chain.connection.getProgramAccounts(chain.key("launchLabProgram"), {
      filters: [{ dataSize: LaunchpadPool.span }, { memcmp: { offset: LaunchpadPool.offsetOf("platformId"), bytes: platform } }],
    });
    for (const a of accounts) {
      const p = LaunchpadPool.decode(a.account.data);
      if (p.status !== 0) continue;
      const creator = p.creator.toBase58();
      if (!(await hasSol(creator, 0.1e9))) continue;
      const r = await chain.connection.getTokenAccountsByOwner(p.creator, { mint: p.mintA });
      let base = 0n;
      for (const { account } of r.value) base += Buffer.from(account.data).readBigUInt64LE(64);
      const tokens = Number(base / 1_000_000n);
      if (tokens > 10) return { wallet: creator, mint: p.mintA.toBase58(), tokens: Math.min(10_000, Math.floor(tokens / 10)) };
    }
  }
  throw new Error("no devnet curve coin whose creator holds SOL and tokens");
}

for (const cluster of clusters) {
  console.log(`\n== ${cluster} (${rpcFor(cluster)})`);
  const chain = new Chain({ cluster, rpcUrl: rpcFor(cluster) });
  const { wallet, mint, tokens } = await findWallet(cluster, chain);
  const recipient = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58();
  console.log(`wallet ${wallet}, coin ${mint}`);

  const home = mkdtempSync(join(tmpdir(), "highwire-rehearse-"));
  const paths = agentPaths({ HIGHWIRE_HOME: home });
  const policy = {
    version: 1,
    cluster,
    live: true,
    actions: ["trade", "transfer"],
    max_sol_per_tx: 0.02,
    max_sol_per_day: 0.03,
    max_slippage_bps: 300,
    transfer_allowlist: [recipient],
  };
  writeFileSync(paths.policy, JSON.stringify(policy));
  // A watch-only signer: the public wallet with an all-zero secret key. It can sign, worthlessly; it can't spend.
  const watchOnly = { publicKey: new PublicKey(wallet), secretKey: new Uint8Array(64) } as unknown as Keypair;
  const signer = new LocalSigner(watchOnly, paths);
  const server = createServer({ ...serverOptionsFromEnv({ ...process.env, HIGHWIRE_CLUSTER: cluster, SOLANA_RPC_URL: rpcFor(cluster) }), signer });
  const client = new Client({ name: "rehearse", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);

  const call = async (name: string, args: Record<string, unknown>) => {
    await pause();
    const res = await client.callTool({ name, arguments: args });
    return { isError: Boolean(res.isError), out: JSON.parse((res.content as Array<{ text: string }>)[0]!.text) };
  };
  const expectSent = async (what: string, name: string, args: Record<string, unknown>) => {
    const before = sends.length;
    const r = await call(name, args);
    const mine = sends.slice(before);
    const ok = !r.isError && r.out.status === "sent" && mine.length > 0 && mine.every((s) => s.signed && s.simulated.startsWith("ok"));
    rows.push({
      cluster,
      what,
      ok,
      result: r.isError
        ? `${r.out.code}: ${r.out.error}`
        : `${r.out.status}; ${mine.map((s) => `signed bytes simulate ${s.simulated}`).join("; ")}; day left ${r.out.policy?.dayLeftSol} SOL`,
    });
  };
  const expectRefused = async (what: string, code: string, name: string, args: Record<string, unknown>) => {
    const before = sends.length;
    const r = await call(name, args);
    const ok = r.isError && r.out.code === code && sends.length === before;
    rows.push({ cluster, what, ok, result: r.isError ? `${r.out.code}: ${r.out.error}` : `NOT refused: ${r.out.status}` });
  };
  const trade = { wallet, mint, max_slippage_bps: 300, max_sol: 0.05, confirm_trade: true };

  const status = await call("get_signer_status", {});
  rows.push({ cluster, what: "get_signer_status", ok: status.out.policy?.live === true && status.out.wallet === wallet, result: `live ${status.out.policy?.live}, day left ${status.out.dayLeftSol} SOL` });
  await expectSent("execute_trade buy 0.01 SOL", "execute_trade", { ...trade, side: "buy", sol: 0.01 });
  await expectSent(`execute_trade sell ${tokens} tokens`, "execute_trade", { ...trade, side: "sell", tokens });
  await expectSent("execute_transfer 0.001 SOL to the allowlisted wallet", "execute_transfer", { to: recipient, sol: 0.001, confirm_transfer: true });
  await expectRefused("execute_trade buy 0.03 SOL (over the 0.02 per-tx limit)", "policy_refused", "execute_trade", { ...trade, side: "buy", sol: 0.03 });
  await expectRefused("execute_trade buy 0.02 SOL (over what's left of the 0.03 day)", "policy_refused", "execute_trade", { ...trade, side: "buy", sol: 0.02 });
  await expectRefused("execute_transfer to a wallet not on the allowlist", "policy_refused", "execute_transfer", { to: mint, sol: 0.001, confirm_transfer: true });
  await expectRefused("execute_trade with 5% slippage (policy allows 3%)", "policy_refused", "execute_trade", { ...trade, side: "buy", sol: 0.001, max_slippage_bps: 500 });
  await expectRefused("execute_launch (not in the policy's actions)", "policy_refused", "execute_launch", {
    wallet,
    name: "Highwire Rehearsal",
    ticker: "HWREH",
    fee_mode: "rewards",
    metadata_uri: "https://highwire.fun/sim/metadata.json",
    idempotency_key: `rehearse-${Date.now()}`,
    confirm_launch: true,
  });
  writeFileSync(paths.stop, "");
  await expectRefused("execute_trade with ~/.highwire/STOP present", "signer_stopped", "execute_trade", { ...trade, side: "buy", sol: 0.001 });

  const log = signer.audit.entries();
  const count = (o: string) => log.filter((e) => e.outcome === o).length;
  rows.push({
    cluster,
    what: "audit log",
    ok: count("sent") === 3 && count("confirmed") === 3 && count("refused") === 6,
    result: `${log.length} lines: ${count("sent")} sent, ${count("confirmed")} confirmed, ${count("refused")} refused`,
  });
  await client.close();
  rmSync(home, { recursive: true, force: true });
}

console.log("\nResults");
for (const r of rows) console.log(`${r.ok ? "ok  " : "FAIL"} [${r.cluster}] ${r.what}: ${r.result}`);
const failed = rows.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} failed` : "\nall rehearsals passed; nothing was sent");
process.exit(failed ? 1 : 0);
