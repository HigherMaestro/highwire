// Live simulation check for the v0.2 transaction tools. Starts the real server
// over stdio (once per cluster), builds a buy, a sell, a launch and a creator
// fee claim, and reports each transaction's simulation. Builds are simulated
// with sigVerify off as public wallets found on-chain: nothing is signed or
// sent, no airdrop is requested, and no keypair is funded.
// Run with `npm run simulate` (needs network access). Set SOLANA_RPC_URL or
// SOLANA_DEVNET_RPC_URL to use your own RPCs; SIM_CLUSTERS=mainnet skips devnet.
// Each build's sign_url is checked to decode back to its envelope, and the one
// for each cluster's first buy is printed: open it within 10 minutes to try the
// sign page. HIGHWIRE_SITE_URL=http://localhost:3000 points it at `next dev`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LaunchpadPool } from "@raydium-io/raydium-sdk-v2";
import { buildAgentRegistration, buildClaimAndBuy, buildTrade, Chain, decodeSignPayload, DEFAULT_RPC_URLS, JITO_TIP_ACCOUNTS, type Cluster, type Envelope } from "highwire-core";
import { PublicKey } from "@solana/web3.js";

const clusters = (process.env.SIM_CLUSTERS ?? "mainnet,devnet").split(",") as Cluster[];
const rpcFor = (c: Cluster) => (c === "mainnet" ? process.env.SOLANA_RPC_URL : process.env.SOLANA_DEVNET_RPC_URL) || DEFAULT_RPC_URLS[c];
const pause = (ms = 4000) => new Promise((r) => setTimeout(r, ms));

interface Row {
  cluster: Cluster;
  what: string;
  result: string;
  ok: boolean;
}
const rows: Row[] = [];
/** The first buy's sign link per cluster, and every link's length by what was built. */
const buyLinks: Partial<Record<Cluster, string>> = {};
const linkSizes: { cluster: Cluster; what: string; chars: number; gzipped: boolean }[] = [];

async function connect(cluster: Cluster) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--conditions=highwire-source", "--import", "tsx", "src/cli.ts"],
    env: { ...process.env, HIGHWIRE_CLUSTER: cluster, SOLANA_RPC_URL: rpcFor(cluster) } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "simulate", version: "0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; out: any }> {
  for (let attempt = 0; ; attempt++) {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? "{}";
    const out = JSON.parse(text);
    // The public RPC rate-limits; back off and try once more.
    if (res.isError && attempt === 0 && /429|rate limit|Too Many/i.test(text)) {
      await pause(15_000);
      continue;
    }
    return { isError: Boolean(res.isError), out };
  }
}

/** Records every transaction's simulation from a build tool's result, and checks its sign link. */
async function report(cluster: Cluster, what: string, r: { isError: boolean; out: any }) {
  if (!r.isError && r.out.sign_url) {
    const url = new URL(r.out.sign_url);
    const back = await decodeSignPayload(url.hash);
    const same = JSON.stringify(back) === JSON.stringify(r.out.unsigned);
    rows.push({ cluster, what: `${what}: sign_url`, ok: same, result: same ? `${r.out.sign_url.length} chars, decodes to the envelope` : "DOES NOT decode to the envelope" });
    linkSizes.push({ cluster, what, chars: r.out.sign_url.length, gzipped: url.hash.startsWith("#gz.") });
    if (/^buy/.test(what) && !buyLinks[cluster]) buyLinks[cluster] = r.out.sign_url;
  }
  if (r.isError) {
    rows.push({ cluster, what, ok: false, result: `${r.out.code}: ${r.out.error}` });
    if (r.out.summary) console.log(`  ${r.out.summary.join("\n  ")}\n  ${(r.out.logs ?? []).join("\n  ")}`);
    return;
  }
  const txs = r.out.unsigned?.transactions ?? [];
  if (txs.length === 0) {
    rows.push({ cluster, what, ok: true, result: r.out.note ?? r.out.status ?? "nothing to build" });
    return;
  }
  for (const t of txs) {
    const s = t.simulation;
    rows.push({
      cluster,
      what: txs.length > 1 ? `${what}: ${t.label}` : what,
      ok: s.ok || Boolean(s.skipped),
      result: s.ok ? `simulated ok, ${s.unitsConsumed} CU, ${Buffer.from(t.base64, "base64").length} bytes` : s.skipped ? `not simulated: ${s.skipped}` : `FAILED: ${s.error}`,
    });
  }
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** Mainnet: a curve coin and a graduated coin from the API, with public wallets that hold them and SOL. */
async function mainnetPlan(chain: Chain) {
  const api = "https://api.higher.fun";
  const candidates = async (sort: string, status: string) => {
    const { items } = await getJson(`${api}/coins?sort=${sort}&limit=30`);
    const coins = items.filter((c: any) => c.status === status).slice(0, 5);
    if (coins.length === 0) throw new Error(`no ${status} coin in /coins?sort=${sort}`);
    return coins;
  };
  const holderOf = async (mint: string) => {
    const { items } = await getJson(`${api}/coins/${mint}/holders`);
    for (const h of items.filter((h: any) => !h.isCurve && !h.isCreator).slice(0, 20)) {
      if (h.wallet in KNOWN_VAULTS) continue;
      const lamports = await chain.connection.getBalance(new PublicKey(h.wallet));
      // A tenth of the holding, and at most 100k tokens, keeps the sell under the 5 SOL cap.
      if (lamports >= 0.2e9) return { wallet: h.wallet, tokens: Math.min(100_000, Math.floor(Number(h.balance) / 1e6 / 10)) };
      await pause(500);
    }
    return null;
  };
  // The first of the top few coins with a holder who has the SOL to simulate as.
  const withHolder = async (sort: string, status: string) => {
    for (const coin of await candidates(sort, status)) {
      const holder = await holderOf(coin.mint);
      if (holder) return { coin, holder };
    }
    throw new Error(`no ${status} coin in /coins?sort=${sort} has a holder with 0.2 SOL`);
  };
  const curve = await withHolder("trending", "curve");
  const graduated = await withHolder("mcap", "graduated");
  return { curve: curve.coin, graduated: graduated.coin, curveHolder: curve.holder, graduatedHolder: graduated.holder, creator: graduated.coin.creator };
}

const KNOWN_VAULTS: Record<string, true> = {
  WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh: true,
  GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL: true,
  "3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH": true,
};

/** Devnet has no higher.fun API: find coins on higher.fun's devnet platforms, and their creators' holdings. */
async function devnetPlan(chain: Chain) {
  const pools: { mint: string; status: number; creator: string }[] = [];
  for (const platform of [chain.addresses.rewardsPlatform, chain.addresses.classicPlatform]) {
    const accounts = await chain.connection.getProgramAccounts(chain.key("launchLabProgram"), {
      filters: [{ dataSize: LaunchpadPool.span }, { memcmp: { offset: LaunchpadPool.offsetOf("platformId"), bytes: platform } }],
    });
    for (const a of accounts) {
      const p = LaunchpadPool.decode(a.account.data);
      pools.push({ mint: p.mintA.toBase58(), status: p.status, creator: p.creator.toBase58() });
    }
  }
  const holding = async (wallet: string, mint: string) => {
    const r = await chain.connection.getTokenAccountsByOwner(new PublicKey(wallet), { mint: new PublicKey(mint) });
    let base = 0n;
    for (const { account } of r.value) base += Buffer.from(account.data).readBigUInt64LE(64);
    return Number(base / 1_000_000n);
  };
  const choose = async (status: number) => {
    for (const p of pools.filter((x) => x.status === status)) {
      if ((await chain.connection.getBalance(new PublicKey(p.creator))) < 0.1e9) continue;
      const tokens = await holding(p.creator, p.mint);
      if (tokens > 10) return { mint: p.mint, wallet: p.creator, tokens: Math.floor(tokens / 10) };
    }
    return null;
  };
  return { curve: await choose(0), graduated: await choose(2), pools: pools.length };
}

for (const cluster of clusters) {
  console.log(`\n== ${cluster} (${rpcFor(cluster)})`);
  const chain = new Chain({ cluster, rpcUrl: rpcFor(cluster) });
  const client = await connect(cluster);
  const slippage = 300;
  const maxSol = 5;
  const trade = async (what: string, args: Record<string, unknown>) => {
    await pause();
    console.log(`- ${what}`);
    await report(cluster, what, await call(client, "build_trade", { ...args, max_slippage_bps: slippage, max_sol: maxSol, confirm_trade: true }));
  };

  if (cluster === "mainnet") {
    const plan = await mainnetPlan(chain);
    console.log(`curve coin $${plan.curve.ticker} ${plan.curve.mint}; graduated $${plan.graduated.ticker} ${plan.graduated.mint}`);
    await pause();
    const q = await call(client, "quote_trade", { mint: plan.curve.mint, side: "buy", sol: 0.05 });
    rows.push({
      cluster,
      what: "quote_trade buy 0.05 SOL (curve)",
      ok: !q.isError,
      result: q.isError ? q.out.error : `${q.out.tokensOut} tokens, impact ${q.out.priceImpactPct}%, fees ${q.out.fees.totalSol} SOL`,
    });
    await trade("buy 0.05 SOL on the curve", { wallet: plan.curveHolder.wallet, mint: plan.curve.mint, side: "buy", sol: 0.05 });
    await trade(`sell ${plan.curveHolder.tokens} tokens on the curve`, { wallet: plan.curveHolder.wallet, mint: plan.curve.mint, side: "sell", tokens: plan.curveHolder.tokens });
    await trade("buy 0.05 SOL in the CPMM pool", { wallet: plan.graduatedHolder.wallet, mint: plan.graduated.mint, side: "buy", sol: 0.05 });
    await trade(`sell ${plan.graduatedHolder.tokens} tokens in the CPMM pool`, {
      wallet: plan.graduatedHolder.wallet,
      mint: plan.graduated.mint,
      side: "sell",
      tokens: plan.graduatedHolder.tokens,
    });
    const stamp = Date.now().toString(36);
    for (const [what, extra] of [
      ["launch, New school, 5% creator lock, 0.05 SOL first buy", { fee_mode: "rewards", creator_lock_pct: 5, dev_buy_sol: 0.05 }],
      ["launch, Old school", { fee_mode: "classic" }],
    ] as const) {
      await pause();
      console.log(`- ${what}`);
      await report(
        cluster,
        what,
        await call(client, "build_launch", {
          wallet: plan.curveHolder.wallet,
          name: "Highwire Simulation",
          ticker: `HWS${stamp.slice(-4).toUpperCase()}`,
          metadata_uri: "https://highwire.fun/sim/metadata.json",
          idempotency_key: `simulate-${stamp}-${extra.fee_mode}`,
          confirm_launch: true,
          ...extra,
        }),
      );
    }
    await pause();
    console.log("- claim creator fees");
    await report(cluster, `claim creator fees (${plan.creator})`, await call(client, "build_claim_creator_fees", { wallet: plan.creator }));

    // Protected sends (docs/protected-sends.md), built in-process since no build tool tips: a tipped buy (the tip with the
    // read-only "don't front" key on it), and a fee claim and its buyback in one transaction, on the curve and in a pool.
    const tip = { tipLamports: 12_000n, tipAccount: JITO_TIP_ACCOUNTS[0] };
    const built = (envelope: Envelope) => ({ isError: false, out: { unsigned: envelope } });
    const failedRow = (what: string, err: unknown) => rows.push({ cluster, what, ok: false, result: err instanceof Error ? err.message : String(err) });
    await pause();
    console.log("- protected buy in the CPMM pool");
    try {
      const t = await buildTrade(chain, { wallet: new PublicKey(plan.graduatedHolder.wallet), mint: new PublicKey(plan.graduated.mint), side: "buy", amountIn: 50_000_000n, slippageBps: 300, maxLamports: 50_000_000n, jito: tip });
      await report(cluster, "protected buy 0.05 SOL in the CPMM pool (Jito tip)", built(t.envelope));
    } catch (err) {
      failedRow("protected buy 0.05 SOL in the CPMM pool (Jito tip)", err);
    }
    for (const [what, coin] of [["claim and buy back, graduated coin", plan.graduated], ["claim and buy back, curve coin", plan.curve]] as const) {
      await pause();
      console.log(`- ${what}`);
      try {
        const r = await buildClaimAndBuy(chain, { wallet: new PublicKey(coin.creator), mint: new PublicKey(coin.mint), buybackPct: 50, slippageBps: 500, minBuyLamports: 1n, jito: tip });
        if (r.built) await report(cluster, `${what} (${coin.creator}, Jito tip)`, built(r.built.envelope));
        else rows.push({ cluster, what, ok: true, result: `nothing to build: ${r.claimLamports} lamports to claim` });
      } catch (err) {
        failedRow(what, err);
      }
    }
    // The arena's registration memo (local signer only: it never gets a sign link), from a public wallet.
    await pause();
    console.log("- arena registration memo");
    try {
      const r = await buildAgentRegistration(chain, { wallet: new PublicKey(plan.graduatedHolder.wallet), code: "abcdefghijklmnop" });
      await report(cluster, "arena registration memo (local signer only)", built(r.envelope));
    } catch (err) {
      failedRow("arena registration memo (local signer only)", err);
    }
  } else {
    const plan = await devnetPlan(chain);
    console.log(`${plan.pools} higher.fun pools on devnet`);
    if (plan.curve) {
      await trade("buy 0.01 SOL on the curve", { wallet: plan.curve.wallet, mint: plan.curve.mint, side: "buy", sol: 0.01 });
      await trade(`sell ${plan.curve.tokens} tokens on the curve`, { wallet: plan.curve.wallet, mint: plan.curve.mint, side: "sell", tokens: plan.curve.tokens });
    } else rows.push({ cluster, what: "curve trades", ok: false, result: "no devnet curve coin whose creator holds SOL and tokens" });
    if (plan.graduated) {
      await trade("buy 0.01 SOL in the CPMM pool", { wallet: plan.graduated.wallet, mint: plan.graduated.mint, side: "buy", sol: 0.01 });
      await trade(`sell ${plan.graduated.tokens} tokens in the CPMM pool`, {
        wallet: plan.graduated.wallet,
        mint: plan.graduated.mint,
        side: "sell",
        tokens: plan.graduated.tokens,
      });
    }
    const wallet = plan.curve?.wallet ?? plan.graduated?.wallet;
    if (wallet) {
      await pause();
      console.log("- launch");
      await report(
        cluster,
        "launch, New school, 0.01 SOL first buy",
        await call(client, "build_launch", {
          wallet,
          name: "Highwire Simulation",
          ticker: "HWSIM",
          metadata_uri: "https://highwire.fun/sim/metadata.json",
          fee_mode: "rewards",
          dev_buy_sol: 0.01,
          idempotency_key: `simulate-devnet-${Date.now()}`,
          confirm_launch: true,
        }),
      );
      await pause();
      await report(cluster, `claim creator fees (${wallet})`, await call(client, "build_claim_creator_fees", { wallet }));
    }
  }
  await client.close();
}

console.log("\nSign links");
for (const l of linkSizes) console.log(`  [${l.cluster}] ${l.what}: ${l.chars} chars${l.gzipped ? " (gzipped)" : ""}`);
for (const [cluster, url] of Object.entries(buyLinks)) console.log(`\nsign_url for a ${cluster} buy (open within 10 minutes):\n${url}`);

console.log("\nResults");
for (const r of rows) console.log(`${r.ok ? "ok  " : "FAIL"} [${r.cluster}] ${r.what}: ${r.result}`);
const failed = rows.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} failed` : "\nall simulations passed");
process.exit(failed ? 1 : 0);
