import type { Metadata } from "next";
import { HOLDER_AIRDROPS } from "highwire-core";
import { SiteFooter, SiteHeader } from "../../components/Chrome.tsx";
import { FeeTable, type FeeRow } from "../../components/fees/FeeTable.tsx";
import { FeeFlow } from "../../components/fees/FeeFlow.tsx";
import { SplitBar } from "../../components/fees/SplitBar.tsx";
import { MODE_LABEL, allFees, coinLabel, flowScenarios, pctOf, sol, updatedAt, usd } from "../../lib/fees.ts";

export const revalidate = 600;

export const metadata: Metadata = {
  title: "Ecosystem fees",
  description: "Every fee higher.fun's coins have paid, and who got it: creators, holders, higher.fun, Raydium and the pools. Read from Solana.",
  alternates: { canonical: "/fees" },
};

export default async function FeesPage() {
  const data = await allFees();
  return (
    <>
      <SiteHeader />
      <main className="fees-page">
        <div className="wrap">
          <header className="docs-intro fees-intro">
            <p className="eyebrow">Ecosystem fees</p>
            <h1>Every fee on higher.fun, and who got it</h1>
            <p className="lead">
              Read from Solana for all of higher.fun's coins, on the bonding curve and after graduation. Refreshed every 10
              minutes.
            </p>
          </header>
          {data ? <Ecosystem data={data} /> : <Unavailable />}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}

function Unavailable() {
  return (
    <p className="notice">The numbers couldn't be read from Solana just now. This page tries again within 10 minutes.</p>
  );
}

function Ecosystem({ data }: { data: NonNullable<Awaited<ReturnType<typeof allFees>>> }) {
  const t = data.totals;
  const w = data.waiting;
  const rows: FeeRow[] = data.coins.map((c) => ({
    mint: c.mint,
    ...coinLabel(c),
    mode: MODE_LABEL[c.feeMode],
    status: c.status,
    volumeSol: c.volumeSol,
    feesSol: c.totalFeesSol,
    creatorSol: c.byRecipient.creator,
    higherSol: c.byRecipient["higher.fun"],
    createdAt: c.createdAt,
  }));
  const rate = data.rates;
  return (
    <>
      <ul className="stats fee-stats">
        <li>
          <span className="stat-n">{sol(t.feesSol)} SOL</span>
          <span className="stat-label">in fees{usd(t.feesSol, data.solUsd) ? ` · ${usd(t.feesSol, data.solUsd)}` : ""}</span>
        </li>
        <li>
          <span className="stat-n">{sol(t.volumeSol)} SOL</span>
          <span className="stat-label">traded{usd(t.volumeSol, data.solUsd) ? ` · ${usd(t.volumeSol, data.solUsd)}` : ""}</span>
        </li>
        <li>
          <span className="stat-n">{t.coins.toLocaleString("en-US")}</span>
          <span className="stat-label">coins, {t.graduated} graduated</span>
        </li>
        <li>
          <span className="stat-n">{sol(t.byRecipient.creator)} SOL</span>
          <span className="stat-label">to creators</span>
        </li>
      </ul>

      <section className="fee-section" aria-labelledby="flow">
        <h2 id="flow">How a trade's fee splits</h2>
        <FeeFlow scenarios={flowScenarios(data)} />
      </section>

      <section className="fee-section" aria-labelledby="split">
        <h2 id="split">Where the fees went</h2>
        <SplitBar by={t.byRecipient} total={t.feesSol} label="All fees by recipient" notes />
      </section>

      <section className="fee-section" aria-labelledby="breakdown">
        <h2 id="breakdown">By phase and by fee mode</h2>
        <div className="cards fee-cards">
          <div className="card">
            <h3>On the bonding curve</h3>
            <p className="fee-big">{sol(t.byPhase.curve)} SOL</p>
            <p className="muted">
              {pctOf(t.byPhase.curve, t.feesSol)} of all fees, from {sol(t.curveVolumeSol)} SOL of curve trading.
            </p>
          </div>
          <div className="card">
            <h3>In Raydium pools</h3>
            <p className="fee-big">{sol(t.byPhase.pool)} SOL</p>
            <p className="muted">
              {pctOf(t.byPhase.pool, t.feesSol)} of all fees, from {sol(t.poolVolumeSol)} SOL traded in the {t.graduated}{" "}
              graduated coins' pools.
            </p>
          </div>
          {(["rewards", "classic"] as const).map((m) => (
            <div className="card" key={m}>
              <h3>{MODE_LABEL[m]}</h3>
              <p className="fee-big">{sol(t.byMode[m].feesSol)} SOL</p>
              <p className="muted">
                {t.byMode[m].coins.toLocaleString("en-US")} coins, {sol(t.byMode[m].volumeSol)} SOL traded.{" "}
                {m === "rewards"
                  ? `${rate.curve.rewards.platform}% to higher.fun (it airdrops ${HOLDER_AIRDROPS.platformBps / 100}% of each trade to holders) and ${rate.curve.rewards.creator}% to the creator on each curve trade.`
                  : "No platform or creator fee on the curve; higher.fun takes 1% of supply at graduation instead."}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="fee-section" aria-labelledby="waiting">
        <h2 id="waiting">Waiting to be claimed</h2>
        <p className="muted fee-section-lede">Earned, and sitting in on-chain vaults right now.</p>
        <ul className="stats">
          <li>
            <span className="stat-n">{sol(w.creatorPoolSol)} SOL</span>
            <span className="stat-label">pool creator fees, across graduated coins</span>
          </li>
          <li>
            <span className="stat-n">{sol(w.creatorCurveSol)} SOL</span>
            <span className="stat-label">curve creator fees, in creators' vaults</span>
          </li>
          <li>
            <span className="stat-n">{sol(w.higherCurveSol)} SOL</span>
            <span className="stat-label">higher.fun's curve fees, in its platform vaults</span>
          </li>
          <li>
            <span className="stat-n">{sol(w.holdersSol)} SOL</span>
            <span className="stat-label">for holders, in coins' airdrop wallets</span>
          </li>
        </ul>
        <p className="muted small">
          Creators can claim theirs with Highwire's <a href="/docs#build_claim_creator_fees">build_claim_creator_fees</a>.
        </p>
      </section>

      <section className="fee-section" aria-labelledby="coins">
        <h2 id="coins">Every coin</h2>
        <FeeTable rows={rows} />
      </section>

      <section className="fee-section prose" aria-labelledby="method">
        <h2 id="method">How it's worked out</h2>
        <ul>
          <li>
            <strong>On the curve, measured.</strong> Raydium's {rate.curve.rewards.raydium}% LaunchLab fee is counted in each
            coin's curve account and never resets, so it gives the coin's exact curve volume. higher.fun's platform fee and
            the creator fee are fixed multiples of it ({rate.curve.rewards.platform}% and {rate.curve.rewards.creator}% for
            New school, nothing for Old school).
          </li>
          <li>
            <strong>In the pool, computed.</strong> A graduated coin's pool volume is its lifetime volume from higher.fun's
            daily candles, less its curve volume. The pool charges {rate.pool.trade}% per trade ({rate.pool.raydiumShareOfTrade}% of
            that to Raydium, the rest to liquidity) and a {rate.pool.creator}% creator fee on the SOL side, of which Raydium
            keeps {rate.pool.raydiumShareOfCreator}%. Every rate is read from the chain, not assumed.
          </li>
          <li>
            <strong>Locked liquidity.</strong> At graduation a New school coin's pool locks about 30% of its liquidity, with
            the Fee Key held by higher.fun, which pays creators a third of what it earns off-chain. That share of the LP fees
            is read from the lock; the rest of the liquidity is burned, and its fees stay in the pool.
          </li>
          <li>
            <strong>Holder airdrops.</strong> On New school coins, higher.fun passes {HOLDER_AIRDROPS.platformBps / 100}% of
            each trade, out of its platform fee, to the coin's holders as SOL, through an airdrop wallet per coin; a creator
            can give their fees to holders too. What holders got is what each wallet has paid out (from higher.fun's API) and
            what's waiting in it (on-chain), taken out of higher.fun's share, or the creator's when they gave theirs.
          </li>
          <li>
            <strong>Not counted:</strong> launch fees (about {sol(t.launchFeesSol)} SOL at today's 0.02 SOL each), higher.fun's
            1% of supply from graduated Old school coins, and network fees.
          </li>
        </ul>
        <p className="muted small">
          Last read {updatedAt(data.generatedAt)}. Highwire isn't affiliated with higher.fun; these are our reading of public
          on-chain data, not higher.fun's accounts.
          {data.warnings.length ? ` ${data.warnings.join(" ")}` : ""}
        </p>
      </section>
    </>
  );
}
