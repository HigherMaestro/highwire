import type { Metadata } from "next";
import { HOLDER_AIRDROPS } from "highwire-core";
import { SiteFooter, SiteHeader } from "../../components/Chrome.tsx";
import { FeeTable, type FeeRow } from "../../components/fees/FeeTable.tsx";
import { FeeFlow } from "../../components/fees/FeeFlow.tsx";
import { SplitBar } from "../../components/fees/SplitBar.tsx";
import { EarningsCalculator } from "../../components/fees/EarningsCalculator.tsx";
import { WalletLookup } from "../../components/fees/WalletLookup.tsx";
import { MODE_LABEL, allFees, coinLabel, flowScenarios, pctOf, short, sol, topCreators, updatedAt, usd, volumes24h } from "../../lib/fees.ts";
import { FEES_CARD, pageMetadata } from "../../lib/site.ts";

export const revalidate = 600;

export const metadata: Metadata = {
  ...pageMetadata({
    title: "Ecosystem fees",
    description: "Every fee higher.fun's coins have paid, and who got it: creators, holders, higher.fun, Raydium and the pools. Read from Solana.",
    path: "/fees",
    card: FEES_CARD,
  }),
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
    fees24hSol: c.last24h?.feesSol ?? null,
    createdAt: c.createdAt,
  }));
  const rate = data.rates;
  const day = t.last24h;
  const scenarios = flowScenarios(data);
  const creators = topCreators(data, 10);
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

      <section className="fee-section" aria-labelledby="today">
        <h2 id="today">The last 24 hours</h2>
        <p className="muted fee-section-lede">
          Estimated: each coin's 24-hour volume on higher.fun, at the rates of the phase it trades in now.
        </p>
        <ul className="stats">
          <li>
            <span className="stat-n">{sol(day.feesSol)} SOL</span>
            <span className="stat-label">in fees{usd(day.feesSol, data.solUsd) ? ` · ${usd(day.feesSol, data.solUsd)}` : ""}</span>
          </li>
          <li>
            <span className="stat-n">{sol(day.byRecipient.creator)} SOL</span>
            <span className="stat-label">to creators{usd(day.byRecipient.creator, data.solUsd) ? ` · ${usd(day.byRecipient.creator, data.solUsd)}` : ""}</span>
          </li>
          <li>
            <span className="stat-n">{sol(day.volumeSol)} SOL</span>
            <span className="stat-label">traded</span>
          </li>
          <li>
            <span className="stat-n">{day.coinsTraded.toLocaleString("en-US")}</span>
            <span className="stat-label">coins traded, of {t.coins.toLocaleString("en-US")}</span>
          </li>
        </ul>
      </section>

      <section className="fee-section" aria-labelledby="flow">
        <h2 id="flow">How a trade's fee splits</h2>
        <FeeFlow scenarios={scenarios} />
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
            <span className="stat-label">curve creator fees, in creators' vaults (which also hold their fees from other LaunchLab launchpads)</span>
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
          Creators can claim theirs with Highwire's <a href="/docs#build_claim_creator_fees">build_claim_creator_fees</a>, or
          look up their wallet below.
        </p>
      </section>

      <section className="fee-section" aria-labelledby="creators">
        <h2 id="creators">Top creators</h2>
        <p className="muted fee-section-lede">Creator wallets by what their coins have paid them, across every coin they made.</p>
        <WalletLookup />
        <div className="table-wrap">
          <table className="params fees">
            <thead>
              <tr>
                <th scope="col">Creator</th>
                <th scope="col" className="num">
                  Coins
                </th>
                <th scope="col">Best coin</th>
                <th scope="col" className="num">
                  Volume (SOL)
                </th>
                <th scope="col" className="num">
                  Earned (SOL)
                </th>
                <th scope="col" className="num">
                  Last 24h
                </th>
              </tr>
            </thead>
            <tbody>
              {creators.map((r) => (
                <tr key={r.wallet}>
                  <td data-label="Creator">
                    <a href={`/fees/creator/${r.wallet}`} className="mono-wrap">
                      {short(r.wallet)}
                    </a>
                  </td>
                  <td data-label="Coins" className="num">
                    {r.coins}
                    {r.graduated ? <span className="muted"> ({r.graduated} graduated)</span> : null}
                  </td>
                  <td data-label="Best coin">
                    <a href={`/fees/${r.best.mint}`}>{r.best.ticker ? `$${r.best.ticker}` : short(r.best.mint)}</a>
                  </td>
                  <td data-label="Volume (SOL)" className="num">
                    {sol(r.volumeSol)}
                  </td>
                  <td data-label="Earned (SOL)" className="num">
                    <strong>{sol(r.earnedSol)}</strong>
                  </td>
                  <td data-label="Last 24h" className="num">
                    {r.last24hSol > 0 ? sol(r.last24hSol) : <span className="muted">–</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="fee-section" aria-labelledby="earn">
        <h2 id="earn">What a coin earns its creator</h2>
        <p className="muted fee-section-lede">Pick a fee mode and a daily volume.</p>
        <EarningsCalculator scenarios={scenarios} volumes={volumes24h(data)} solUsd={data.solUsd} />
        <p className="muted small">
          To launch one from an agent, give it <a href="/skill.md">highwire.fun/skill.md</a>. To start from a working agent
          that spends its fees, see <a href="/ideas">ideas</a>.
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
            <strong>The last 24 hours, estimated.</strong> higher.fun's 24-hour volume for each coin, which counts curve and
            pool trades alike, priced at the rates of the phase the coin trades in now. A coin that graduated during the day
            is priced at pool rates throughout.
          </li>
          <li>
            <strong>Creators.</strong> A creator is the wallet each coin's curve names as its creator: the one that launched
            it, or the one it was launched for. Earned is every creator line above, claimed or not.
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
        <p className="muted small">
          Agents can read the same numbers through Highwire's MCP: <a href="/docs#get_ecosystem_fees">get_ecosystem_fees</a>,{" "}
          <a href="/docs#get_coin_fees">get_coin_fees</a> and <a href="/docs#get_creator_fees">get_creator_fees</a>.
        </p>
      </section>
    </>
  );
}
