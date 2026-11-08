import type { ReactNode } from "react";
import type { Metadata } from "next";
import { HOLDER_AIRDROPS } from "highwire-core";
import { SiteFooter, SiteHeader } from "../../components/Chrome.tsx";
import { SectionNav } from "../../components/ideas/SectionNav.tsx";
import { FeeTable, type FeeRow } from "../../components/fees/FeeTable.tsx";
import { FeeFlow } from "../../components/fees/FeeFlow.tsx";
import { SplitBar } from "../../components/fees/SplitBar.tsx";
import { EarningsCalculator } from "../../components/fees/EarningsCalculator.tsx";
import { WalletLookup } from "../../components/fees/WalletLookup.tsx";
import { COLOR, FeeHero, Head as SectionHead, HistoryChart, Tile, weekOnWeek } from "../../components/fees/Parts.tsx";
import { MODE_LABEL, RECIPIENTS, allFees, coinLabel, feeHistory, type FeeHistory, flowScenarios, pctOf, short, sol, topCreators, topToday, updatedAt, usd, volumes24h } from "../../lib/fees.ts";
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

const SECTIONS = [
  { id: "today", label: "Today" },
  { id: "history", label: "Over time" },
  { id: "flow", label: "The split" },
  { id: "waiting", label: "To claim" },
  { id: "creators", label: "Creators" },
  { id: "earn", label: "Earnings" },
  { id: "coins", label: "Every coin" },
  { id: "method", label: "Method" },
];

const n = (id: string) => String(SECTIONS.findIndex((s) => s.id === id) + 1).padStart(2, "0");

function Head({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  return (
    <SectionHead id={id} n={n(id)} title={title}>
      {children}
    </SectionHead>
  );
}

export default async function FeesPage() {
  const data = await allFees();
  const history = data ? await feeHistory(data.coins) : null;
  const t = data?.totals;
  return (
    <>
      <SiteHeader />
      <main>
        {data && t ? (
          <FeeHero
            id="fees-title"
            eyebrow="Ecosystem fees · read from Solana"
            title="Every fee on higher.fun, and who got it"
            figure={sol(t.feesSol)}
            figureSub={`paid in fees${usd(t.feesSol, data.solUsd) ? ` (${usd(t.feesSol, data.solUsd)})` : ""}, across all ${t.coins.toLocaleString("en-US")} coins`}
            facts={[
              { label: "Traded", value: `${sol(t.volumeSol)} SOL` },
              { label: "To creators", value: `${sol(t.byRecipient.creator)} SOL` },
              { label: "Graduated", value: `${t.graduated} of ${t.coins.toLocaleString("en-US")}` },
              { label: "Last 24 hours", value: `${sol(t.last24h.feesSol)} SOL` },
            ]}
            readAt={data.generatedAt}
          />
        ) : (
          <FeeHero id="fees-title" eyebrow="Ecosystem fees · read from Solana" title="Every fee on higher.fun, and who got it">
            <p className="lead">
              Read from Solana for all of higher.fun's coins, on the bonding curve and after graduation. Refreshed every 10
              minutes.
            </p>
          </FeeHero>
        )}
        {data ? (
          <>
            <SectionNav sections={SECTIONS} />
            <Ecosystem data={data} history={history} />
          </>
        ) : (
          <div className="wrap fees-body">
            <p className="notice">The numbers couldn't be read from Solana just now. This page tries again within 10 minutes.</p>
          </div>
        )}
      </main>
      <SiteFooter />
    </>
  );
}

function Ecosystem({ data, history }: { data: NonNullable<Awaited<ReturnType<typeof allFees>>>; history: FeeHistory | null }) {
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
  const today = topToday(data, 6);
  const todayMax = today[0]?.feesSol ?? 0;
  const creatorMax = creators[0]?.earnedSol ?? 0;
  const waiting = w.creatorPoolSol + w.creatorCurveSol + w.higherCurveSol + w.holdersSol;
  const dayRecipients = RECIPIENTS.filter((r) => today.some((c) => c.byRecipient[r.key] > 0));
  return (
    <div className="wrap fees-body">
      <section id="today" className="fee-block" aria-labelledby="today-title">
        <Head id="today" title="The last 24 hours">
          Estimated from each coin's 24-hour volume on higher.fun, at the rates of the phase it trades in now.
        </Head>
        <div className="fee-today">
          <div className="fee-tiles">
            <Tile label="Fees" value={sol(day.feesSol)} unit="SOL" sub={usd(day.feesSol, data.solUsd) ?? undefined} />
            <Tile label="To creators" value={sol(day.byRecipient.creator)} unit="SOL" sub={usd(day.byRecipient.creator, data.solUsd) ?? undefined} accent={COLOR.creator} />
            <Tile label="Traded" value={sol(day.volumeSol)} unit="SOL" sub={usd(day.volumeSol, data.solUsd) ?? undefined} />
            <Tile label="Coins traded" value={day.coinsTraded.toLocaleString("en-US")} sub={`of ${t.coins.toLocaleString("en-US")}`} />
          </div>
          {today.length ? (
            <figure className="fee-panel fee-rank">
              <figcaption>
                <span className="fee-panel-title">Most fees today</span>
                <span className="fee-legend" aria-hidden="true">
                  {dayRecipients.map((r) => (
                    <span key={r.key}>
                      <i style={{ background: r.color }} />
                      {r.label}
                    </span>
                  ))}
                </span>
              </figcaption>
              <ol>
                {today.map((c) => (
                  <li key={c.mint}>
                    <a href={`/fees/${c.mint}`} className="fee-rank-name">
                      {c.ticker ? `$${c.ticker}` : short(c.mint)}
                    </a>
                    <span
                      className="fee-rank-bar"
                      role="img"
                      aria-label={`${sol(c.feesSol)} SOL in fees from ${sol(c.volumeSol)} SOL traded: ${dayRecipients
                        .filter((r) => c.byRecipient[r.key] > 0)
                        .map((r) => `${r.label} ${sol(c.byRecipient[r.key])} SOL`)
                        .join(", ")}`}
                    >
                      {dayRecipients.map((r) =>
                        c.byRecipient[r.key] > 0 ? (
                          <span
                            key={r.key}
                            title={`${r.label}: ${sol(c.byRecipient[r.key])} SOL`}
                            style={{ width: `${(c.byRecipient[r.key] / todayMax) * 100}%`, background: r.color }}
                          />
                        ) : null,
                      )}
                    </span>
                    <span className="fee-rank-value">{sol(c.feesSol)}</span>
                  </li>
                ))}
              </ol>
              <p className="fee-panel-foot">SOL in fees, estimated; each bar is split by who got it.</p>
            </figure>
          ) : null}
        </div>
      </section>

      <section id="history" className="fee-block" aria-labelledby="history-title">
        <Head id="history" title="Day by day">
          {history ? weekOnWeek(history).line : "Fees day by day, and who got them."}
        </Head>
        {history ? (
          <HistoryChart
            history={history}
            solUsd={data.solUsd}
            title="Fees a day"
            scope={`from the ${history.coins} busiest coins, ${history.sharePct.toFixed(1)}% of all volume`}
          />
        ) : (
          <p className="notice">The daily numbers couldn't be read from higher.fun just now. This page tries again within 10 minutes.</p>
        )}
      </section>

      <section id="flow" className="fee-block" aria-labelledby="flow-title">
        <Head id="flow" title="Where every trade's fee goes">
          One trade's fee, split by the rates read on-chain. Pick where the coin trades and its fee mode.
        </Head>
        <FeeFlow scenarios={scenarios} />
        <div className="fee-panel fee-split-panel">
          <h3 className="fee-panel-title">All {sol(t.feesSol)} SOL, by who got it</h3>
          <SplitBar by={t.byRecipient} total={t.feesSol} label="All fees by recipient" />
        </div>
        <div className="fee-pairs">
          <Pair
            title="By phase"
            a={{ label: "Bonding curve", sol: t.byPhase.curve, sub: `from ${sol(t.curveVolumeSol)} SOL of curve trading` }}
            b={{ label: "Raydium pools", sol: t.byPhase.pool, sub: `from ${sol(t.poolVolumeSol)} SOL in ${t.graduated} graduated coins' pools` }}
            total={t.feesSol}
          />
          <Pair
            title="By fee mode"
            a={{ label: MODE_LABEL.rewards, sol: t.byMode.rewards.feesSol, sub: `${t.byMode.rewards.coins.toLocaleString("en-US")} coins: ${rate.curve.rewards.platform}% to higher.fun and ${rate.curve.rewards.creator}% to the creator per curve trade, ${HOLDER_AIRDROPS.platformBps / 100}% airdropped to holders` }}
            b={{ label: MODE_LABEL.classic, sol: t.byMode.classic.feesSol, sub: `${t.byMode.classic.coins.toLocaleString("en-US")} coins: no platform or creator fee on the curve; higher.fun takes 1% of supply at graduation` }}
            total={t.feesSol}
          />
        </div>
      </section>

      <section id="waiting" className="fee-block" aria-labelledby="waiting-title">
        <Head id="waiting" title="Waiting to be claimed">
          {sol(waiting)} SOL earned and sitting in on-chain vaults right now.
        </Head>
        <div className="fee-tiles fee-tiles-4">
          <Tile label="Pool creator fees" value={sol(w.creatorPoolSol)} unit="SOL" sub="across graduated coins" accent={COLOR.creator} />
          <Tile label="Curve creator fees" value={sol(w.creatorCurveSol)} unit="SOL" sub="in creators' LaunchLab vaults, which also hold fees from other launchpads" accent={COLOR.creator} />
          <Tile label="higher.fun" value={sol(w.higherCurveSol)} unit="SOL" sub="curve fees in its platform vaults" accent={COLOR["higher.fun"]} />
          <Tile label="Holders" value={sol(w.holdersSol)} unit="SOL" sub="in coins' airdrop wallets" accent={COLOR.holders} />
        </div>
        <p className="fee-cta">
          <span>Made a coin? Your agent can claim your creator fees with Highwire.</span>
          <a className="button" href="/docs#build_claim_creator_fees">
            How to claim
          </a>
        </p>
      </section>

      <section id="creators" className="fee-block" aria-labelledby="creators-title">
        <Head id="creators" title="Top creators">
          Creator wallets by what their coins have paid them, across every coin they made.
        </Head>
        <div className="fee-panel">
          <WalletLookup />
          <ol className="fee-board">
            {creators.map((r, i) => (
              <li key={r.wallet}>
                <span className="fee-board-rank">{String(i + 1).padStart(2, "0")}</span>
                <span className="fee-board-who">
                  <a href={`/fees/creator/${r.wallet}`} className="mono-wrap">
                    {short(r.wallet)}
                  </a>
                  <span className="muted small">
                    {r.coins} {r.coins === 1 ? "coin" : "coins"}
                    {r.graduated ? `, ${r.graduated} graduated` : ""} · best{" "}
                    <a href={`/fees/${r.best.mint}`}>{r.best.ticker ? `$${r.best.ticker}` : short(r.best.mint)}</a>
                  </span>
                </span>
                <span className="fee-board-bar" aria-hidden="true">
                  <span style={{ width: `${(r.earnedSol / creatorMax) * 100}%` }} />
                </span>
                <span className="fee-board-value">
                  <strong>{sol(r.earnedSol)} SOL</strong>
                  <span className="muted small">{r.last24hSol > 0 ? `+${sol(r.last24hSol)} in 24h` : `${sol(r.volumeSol)} traded`}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="earn" className="fee-block" aria-labelledby="earn-title">
        <Head id="earn" title="What a coin earns its creator">
          Pick a fee mode, where the coin trades, and a daily volume.
        </Head>
        <EarningsCalculator scenarios={scenarios} volumes={volumes24h(data)} solUsd={data.solUsd} />
        <p className="fee-cta">
          <span>
            Launch one from an agent: give it <a href="/skill.md">highwire.fun/skill.md</a>, or start from an agent that already
            spends its fees.
          </span>
          <a className="button" href="/ideas">
            See the ideas
          </a>
        </p>
      </section>

      <section id="coins" className="fee-block" aria-labelledby="coins-title">
        <Head id="coins" title="Every coin">
          All {t.coins.toLocaleString("en-US")} of higher.fun's coins. Search, sort, and open one for its fees line by line.
        </Head>
        <FeeTable rows={rows} />
      </section>

      <section id="method" className="fee-block" aria-labelledby="method-title">
        <Head id="method" title="How it's worked out">
          Every rate is read from the chain, not assumed.
        </Head>
        <ul className="fee-method">
          <li>
            <h3>On the curve, measured</h3>
            <p>
              Raydium's {rate.curve.rewards.raydium}% LaunchLab fee is counted in each coin's curve account and never resets,
              so it gives the coin's exact curve volume. higher.fun's platform fee and the creator fee are fixed multiples of
              it ({rate.curve.rewards.platform}% and {rate.curve.rewards.creator}% for New school, nothing for Old school).
            </p>
          </li>
          <li>
            <h3>In the pool, computed</h3>
            <p>
              A graduated coin's pool volume is its lifetime volume from higher.fun's daily candles, less its curve volume.
              The pool charges {rate.pool.trade}% per trade ({rate.pool.raydiumShareOfTrade}% of that to Raydium, the rest to
              liquidity) and a {rate.pool.creator}% creator fee on the SOL side, of which Raydium keeps{" "}
              {rate.pool.raydiumShareOfCreator}%.
            </p>
          </li>
          <li>
            <h3>Locked liquidity</h3>
            <p>
              At graduation a New school coin's pool locks about 30% of its liquidity, with the Fee Key held by higher.fun,
              which pays creators a third of what it earns off-chain. That share of the LP fees is read from the lock; the rest
              of the liquidity is burned, and its fees stay in the pool.
            </p>
          </li>
          <li>
            <h3>Holder airdrops</h3>
            <p>
              On New school coins, higher.fun passes {HOLDER_AIRDROPS.platformBps / 100}% of each trade, out of its platform
              fee, to the coin's holders as SOL, through an airdrop wallet per coin; a creator can give their fees to holders
              too. What holders got is what each wallet has paid out (from higher.fun's API) and what's waiting in it
              (on-chain).
            </p>
          </li>
          <li>
            <h3>The last 24 hours, estimated</h3>
            <p>
              higher.fun's 24-hour volume for each coin, which counts curve and pool trades alike, priced at the rates of the
              phase the coin trades in now. A coin that graduated during the day is priced at pool rates throughout.
            </p>
          </li>
          <li>
            <h3>Day by day, estimated</h3>
            <p>
              Each of the busiest coins' daily volume from higher.fun's candles, at its on-chain rates: curve rates until
              the days add up to its measured curve volume, pool rates after. Together they make up 99% of all volume; the
              rest is too small to see.
            </p>
          </li>
          <li>
            <h3>Creators</h3>
            <p>
              A creator is the wallet each coin's curve names as its creator: the one that launched it, or the one it was
              launched for. Earned is every creator line, claimed or not.
            </p>
          </li>
          <li>
            <h3>Not counted</h3>
            <p>
              Launch fees (about {sol(t.launchFeesSol)} SOL at today's 0.02 SOL each), higher.fun's 1% of supply from
              graduated Old school coins, and network fees.
            </p>
          </li>
          <li>
            <h3>For agents</h3>
            <p>
              The same numbers through Highwire's MCP: <a href="/docs#get_ecosystem_fees">get_ecosystem_fees</a>,{" "}
              <a href="/docs#get_coin_fees">get_coin_fees</a> and <a href="/docs#get_creator_fees">get_creator_fees</a>.
            </p>
          </li>
        </ul>
        <p className="muted small">
          Last read {updatedAt(data.generatedAt)}. Highwire isn't affiliated with higher.fun; these are our reading of public
          on-chain data, not higher.fun's accounts. Coin names are written by their creators.
          {data.warnings.length ? ` ${data.warnings.join(" ")}` : ""}
        </p>
      </section>
    </div>
  );
}

/** Two halves of the same whole, as one bar and two figures. */
function Pair({ title, a, b, total }: { title: string; a: { label: string; sol: number; sub: string }; b: { label: string; sol: number; sub: string }; total: number }) {
  const share = total > 0 ? (a.sol / total) * 100 : 50;
  return (
    <div className="fee-panel fee-pair">
      <h3 className="fee-panel-title">{title}</h3>
      <div className="fee-pair-bar" role="img" aria-label={`${a.label} ${pctOf(a.sol, total)}, ${b.label} ${pctOf(b.sol, total)}`}>
        <span style={{ width: `${share}%` }} />
        <span style={{ width: `${100 - share}%` }} />
      </div>
      <div className="fee-pair-sides">
        {[a, b].map((x, i) => (
          <div key={x.label}>
            <span className="fee-tile-label">
              <i className={i === 0 ? "fee-pair-a" : "fee-pair-b"} aria-hidden="true" />
              {x.label} · {pctOf(x.sol, total)}
            </span>
            <span className="fee-pair-n">{sol(x.sol)} SOL</span>
            <span className="fee-tile-sub">{x.sub}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
