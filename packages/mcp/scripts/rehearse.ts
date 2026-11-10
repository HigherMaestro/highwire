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
import { agentPaths, jitoClient, JitoRejected, LocalSigner, OrderBook, OrderRunner, type JitoClient } from "highwire-agent";
import { Chain, DEFAULT_RPC_URLS, type Cluster } from "highwire-core";
import { createServer, serverOptionsFromEnv } from "../src/index.ts";
import { createDeps } from "../src/server.ts";
import { orderMarket } from "../src/tools/orders.ts";

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
Connection.prototype.getSignatureStatuses = (async (sigs: string[]) => ({ context: { slot: 0 }, value: sigs.map(() => ({ slot: 0, confirmations: 1, err: null, confirmationStatus: "confirmed" as const })) })) as Connection["getSignatureStatuses"];
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

  // A protected send (docs/protected-sends.md), mainnet only: the policy routes trades through Jito, so the build tips;
  // Jito's real tip accounts and tip floor are read, and the block engine is replaced by a simulation of the signed bytes.
  if (cluster === "mainnet") {
    const jhome = mkdtempSync(join(tmpdir(), "highwire-rehearse-jito-"));
    const jpaths = agentPaths({ HIGHWIRE_HOME: jhome });
    writeFileSync(jpaths.policy, JSON.stringify({ ...policy, send: { route: "jito", max_tip_sol: 0.0005 } }));
    const real = jitoClient();
    const engine: JitoClient = {
      tipAccounts: () => real.tipAccounts(),
      tipFloorLamports: () => real.tipFloorLamports(),
      send: async (b64) => {
        const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
        const sim = await chain.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
        const simulated = sim.value.err ? `FAILED ${JSON.stringify(sim.value.err)}` : `ok, ${sim.value.unitsConsumed} CU`;
        sends.push({ signature: bs58.encode(tx.signatures[0]!), signed: tx.signatures[0]!.some((x) => x !== 0), simulated });
        if (sim.value.err) throw new JitoRejected(`the signed bytes don't simulate: ${simulated}`);
        return { bundleId: "rehearsal" };
      },
    };
    const jsigner = new LocalSigner(watchOnly, jpaths, undefined, () => new Date(), engine);
    const jclient = new Client({ name: "rehearse-jito", version: "0" });
    const [ja, jb] = InMemoryTransport.createLinkedPair();
    await Promise.all([createServer({ ...serverOptionsFromEnv({ ...process.env, HIGHWIRE_CLUSTER: cluster, SOLANA_RPC_URL: rpcFor(cluster) }), signer: jsigner }).connect(ja), jclient.connect(jb)]);
    await pause();
    const before = sends.length;
    const res = await jclient.callTool({ name: "execute_trade", arguments: { ...trade, side: "buy", sol: 0.001 } });
    const out = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    const mine = sends.slice(before);
    const t0 = out.transactions?.[0];
    rows.push({
      cluster,
      what: "execute_trade buy 0.001 SOL through Jito's route",
      ok: !res.isError && out.status === "sent" && t0?.route === "jito" && t0?.tipSol > 0 && mine.length === 1 && mine[0]!.signed && mine[0]!.simulated.startsWith("ok"),
      result: res.isError ? `${out.code}: ${out.error}` : `${out.status} via ${t0?.route}, tip ${t0?.tipSol} SOL; signed bytes simulate ${mine[0]?.simulated}`,
    });
    const jlog = jsigner.audit.entries().find((e) => e.outcome === "sent");
    rows.push({ cluster, what: "audit log records the route and tip", ok: jlog?.route === "jito" && Number(jlog?.tip) > 0, result: `route ${jlog?.route}, tip ${jlog?.tip} lamports` });
    await jclient.close();
    rmSync(jhome, { recursive: true, force: true });
  }

  // Standing orders, in a home of their own: placed through the tools, then filled by one pass of the real runner,
  // with the stop-loss's trigger moved above the price so it fires.
  const ohome = mkdtempSync(join(tmpdir(), "highwire-rehearse-orders-"));
  const opaths = agentPaths({ HIGHWIRE_HOME: ohome });
  writeFileSync(opaths.policy, JSON.stringify({ ...policy, actions: ["trade", "claim"], orders: { kinds: ["stop_loss", "limit_buy", "recurring_buy", "fee_claim"], max_open: 6 } }));
  const osigner = new LocalSigner(watchOnly, opaths);
  const options = { ...serverOptionsFromEnv({ ...process.env, HIGHWIRE_CLUSTER: cluster, SOLANA_RPC_URL: rpcFor(cluster) }), signer: osigner };
  const oclient = new Client({ name: "rehearse-orders", version: "0" });
  const [oa, ob] = InMemoryTransport.createLinkedPair();
  await Promise.all([createServer(options).connect(oa), oclient.connect(ob)]);
  const ocall = async (name: string, args: Record<string, unknown>) => {
    await pause();
    const res = await oclient.callTool({ name, arguments: args });
    return { isError: Boolean(res.isError), out: JSON.parse((res.content as Array<{ text: string }>)[0]!.text) };
  };
  const stopLoss = await ocall("place_order", { kind: "stop_loss", mint, trigger_change_pct: -50, sell_pct: 10, max_slippage_bps: 300, confirm_order: true });
  rows.push({ cluster, what: "place_order stop_loss 50% down, 10%", ok: !stopLoss.isError && stopLoss.out.order?.status === "open", result: stopLoss.isError ? `${stopLoss.out.code}: ${stopLoss.out.error}` : `${stopLoss.out.order.description}; now ${stopLoss.out.now.spotPriceSol} SOL` });
  const dca = await ocall("place_order", { kind: "recurring_buy", mint, sol: 0.005, every_hours: 24, times: 2, max_slippage_bps: 300, confirm_order: true });
  rows.push({ cluster, what: "place_order recurring_buy 0.005 SOL daily, twice", ok: !dca.isError && dca.out.order?.status === "open", result: dca.isError ? `${dca.out.code}: ${dca.out.error}` : dca.out.order.description });
  const dip = await ocall("place_order", { kind: "limit_buy", mint, sol: 0.005, trigger_change_pct: -50, max_slippage_bps: 300, confirm_order: true });
  rows.push({ cluster, what: "place_order limit_buy 0.005 SOL at 50% down", ok: !dip.isError && dip.out.order?.status === "open", result: dip.isError ? `${dip.out.code}: ${dip.out.error}` : `${dip.out.order.description}; now ${dip.out.now.spotPriceSol} SOL` });
  const refusedKind = await ocall("place_order", { kind: "take_profit", mint, trigger_change_pct: 100, max_slippage_bps: 300, confirm_order: true });
  rows.push({ cluster, what: "place_order take_profit (not in the policy's kinds)", ok: refusedKind.isError && refusedKind.out.code === "policy_refused", result: `${refusedKind.out.code}: ${refusedKind.out.error}` });

  if (!stopLoss.isError && !dca.isError && !dip.isError) {
    const book = new OrderBook(opaths.orders);
    await book.update(stopLoss.out.order.id, (o) => (o.triggerPriceSol = 1e9));
    await book.update(dip.out.order.id, (o) => (o.triggerPriceSol = 1e9));
    const before = sends.length;
    const runner = new OrderRunner({ book, wallet, cluster, market: orderMarket(createDeps(options), osigner), log: (l) => console.log(`  runner: ${l}`) });
    await runner.tick();
    const mine = sends.slice(before);
    const sl = book.get(stopLoss.out.order.id)!;
    const rb = book.get(dca.out.order.id)!;
    const lb = book.get(dip.out.order.id)!;
    const last = (o: typeof sl) => `${o.history.at(-1)?.outcome}${o.history.at(-1)?.reason ? `: ${o.history.at(-1)?.reason}` : ""}`;
    rows.push({
      cluster,
      what: "runner fills the triggered stop-loss and limit buy, and the due recurring buy",
      ok: sl.status === "done" && lb.status === "done" && rb.runsDone === 1 && rb.status === "open" && mine.length === 3 && mine.every((s) => s.signed && s.simulated.startsWith("ok")),
      result: `stop-loss ${sl.status} (${last(sl)}), limit buy ${lb.status} (${last(lb)}), recurring buy ${rb.runsDone}/2 (${last(rb)}); ${mine.map((s) => `signed bytes simulate ${s.simulated}`).join("; ")}`,
    });
    const tagged = osigner.audit.entries().filter((e) => e.outcome === "sent" && e.order);
    rows.push({ cluster, what: "audit log ties each fill to its order", ok: tagged.length === 3, result: `${tagged.length} sends tagged with their order` });

    // A fee claim that buys back with all of it: devnet's wallet created its coin, so it has curve fees to claim;
    // mainnet's only holds one, so its claim should find nothing and wait for the next run.
    const claim = await ocall("place_order", { kind: "fee_claim", every_hours: 6, min_claim_sol: 0, buyback_pct: 100, mint, max_slippage_bps: 300, confirm_order: true });
    if (claim.isError) rows.push({ cluster, what: "place_order fee_claim with a full buyback", ok: false, result: `${claim.out.code}: ${claim.out.error}` });
    else {
      const sentBefore = sends.length;
      await runner.tick();
      const fc = book.get(claim.out.order.id)!;
      const steps = fc.history.map((h) => `${h.step} ${h.outcome}${h.reason ? ` (${h.reason})` : ""}`).join(", ");
      const claimStep = fc.history.find((h) => h.step === "claim");
      const signedOk = sends.slice(sentBefore).every((x) => x.signed && x.simulated.startsWith("ok"));
      rows.push({
        cluster,
        what: `place_order fee_claim, then the runner claims ${claim.out.now.claimableSol} SOL and buys back`,
        ok: fc.status === "open" && fc.failures === 0 && (claimStep?.outcome === "sent" || claimStep?.outcome === "skipped") && signedOk,
        result: `${steps}; next run ${fc.nextRunAt}${sends.length > sentBefore ? `; ${sends.slice(sentBefore).map((x) => `signed bytes simulate ${x.simulated}`).join("; ")}` : ""}`,
      });
    }
  }
  await oclient.close();
  rmSync(ohome, { recursive: true, force: true });
}

console.log("\nResults");
for (const r of rows) console.log(`${r.ok ? "ok  " : "FAIL"} [${r.cluster}] ${r.what}: ${r.result}`);
const failed = rows.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} failed` : "\nall rehearsals passed; nothing was sent");
process.exit(failed ? 1 : 0);
