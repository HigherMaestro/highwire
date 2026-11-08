import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "../../../../components/Chrome.tsx";
import { SplitBar } from "../../../../components/fees/SplitBar.tsx";
import { MODE_LABEL, coinLabel, creatorFees, isMint, short, sol, updatedAt, usd } from "../../../../lib/fees.ts";
import { FEES_CARD, pageMetadata } from "../../../../lib/site.ts";

export const revalidate = 600;

/** Built on first visit, then regenerated like /fees. */
export async function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ wallet: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { wallet } = await params;
  const label = isMint(wallet) ? short(wallet) : "A creator";
  return pageMetadata({
    title: `${label}'s creator fees`,
    description: `What ${label}'s higher.fun coins have paid them, and what's waiting to be claimed. Read from Solana.`,
    path: `/fees/creator/${wallet}`,
    card: FEES_CARD,
  });
}

const STATUS = { graduated: "graduated", migrating: "graduating", curve: "on the curve" } as const;

export default async function CreatorFeesPage({ params }: Props) {
  const { wallet } = await params;
  // isMint checks a real 32-byte address, which is all a wallet is too.
  if (!isMint(wallet)) notFound();
  const data = await creatorFees(wallet);
  return (
    <>
      <SiteHeader />
      <main className="fees-page">
        <div className="wrap">
          <p className="small">
            <a href="/fees#creators">← All creators</a>
          </p>
          <header className="docs-intro fees-intro">
            <p className="eyebrow">Creator</p>
            <h1>{short(wallet)}</h1>
            <p className="mono-wrap muted small">{wallet}</p>
          </header>
          {data === undefined ? (
            <p className="notice">This wallet's numbers couldn't be read just now. Try again in a few minutes.</p>
          ) : data === null ? (
            <None />
          ) : (
            <Creator wallet={wallet} data={data} />
          )}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}

function None() {
  return (
    <section className="fee-section prose">
      <p>This wallet hasn't created a coin on higher.fun.</p>
      <p>
        An agent can launch one for it: give it <a href="/skill.md">highwire.fun/skill.md</a>. Or see{" "}
        <a href="/fees#earn">what a coin earns its creator</a>.
      </p>
    </section>
  );
}

function Creator({ wallet, data }: { wallet: string; data: NonNullable<Awaited<ReturnType<typeof creatorFees>>> }) {
  const coins = data.coins;
  const earned = data.totals.byRecipient.creator;
  const graduated = coins.filter((c) => c.status === "graduated").length;
  const day = coins.reduce((n, c) => n + (c.last24h?.byRecipient.creator ?? 0), 0);
  const poolWaiting = data.waiting.creatorPoolSol;
  const curveWaiting = data.waiting.creatorCurveSol;
  const claimable = poolWaiting + curveWaiting;
  // higher.fun's off-chain payouts only arise from New school pools' locked liquidity.
  const payouts =
    data.creatorPayouts && (data.creatorPayouts.paidOutSol > 0 || data.creatorPayouts.pendingSol > 0 || coins.some((c) => c.feeMode === "rewards" && c.status === "graduated"))
      ? data.creatorPayouts
      : null;
  const gave = coins.filter((c) => c.holders?.creatorAdds).length;
  return (
    <>
      <ul className="stats fee-stats">
        <li>
          <span className="stat-n">{sol(earned)} SOL</span>
          <span className="stat-label">earned as creator{usd(earned, data.solUsd) ? ` · ${usd(earned, data.solUsd)}` : ""}</span>
        </li>
        <li>
          <span className="stat-n">{sol(claimable)} SOL</span>
          <span className="stat-label">waiting to be claimed{usd(claimable, data.solUsd) ? ` · ${usd(claimable, data.solUsd)}` : ""}</span>
        </li>
        <li>
          <span className="stat-n">{coins.length}</span>
          <span className="stat-label">
            {coins.length === 1 ? "coin" : "coins"}
            {graduated ? `, ${graduated} graduated` : ""}
          </span>
        </li>
        <li>
          <span className="stat-n">{sol(day)} SOL</span>
          <span className="stat-label">earned in the last 24 hours (estimated)</span>
        </li>
      </ul>

      <section className="fee-section" aria-labelledby="claim">
        <h2 id="claim">Waiting to be claimed</h2>
        <ul className="stats">
          <li>
            <span className="stat-n">{sol(curveWaiting)} SOL</span>
            <span className="stat-label">curve creator fees, in this wallet's LaunchLab vault*</span>
          </li>
          <li>
            <span className="stat-n">{sol(poolWaiting)} SOL</span>
            <span className="stat-label">pool creator fees, across {graduated} graduated {graduated === 1 ? "coin" : "coins"}</span>
          </li>
          {payouts ? (
            <li>
              <span className="stat-n">{sol(payouts.pendingSol)} SOL</span>
              <span className="stat-label">owed by higher.fun, off-chain ({sol(payouts.paidOutSol)} SOL paid so far)</span>
            </li>
          ) : null}
        </ul>
        <p className="muted small">
          {claimable > 0
            ? "Only this wallet can claim it. Ask your agent to claim your creator fees with Highwire, which builds the transaction for you to review and sign: "
            : "Nothing to claim right now. When there is, Highwire builds the claim for this wallet to review and sign: "}
          <a href="/docs#build_claim_creator_fees">build_claim_creator_fees</a>. An agent with its own wallet can claim, and
          buy back with what it claims, on a schedule: see the <a href="/ideas/buyback-coin">buyback coin</a>.
          {gave ? ` ${gave === 1 ? "One coin's" : `${gave} coins'`} creator fees go to holders instead, as the creator chose.` : ""}
        </p>
        <p className="muted small">
          * LaunchLab keeps one vault per creator for every launchpad built on it, so this also holds the fees of any coins
          this wallet made elsewhere, and can be more than it earned on higher.fun. One claim collects all of it.
        </p>
      </section>

      {data.totals.feesSol > 0 ? (
        <section className="fee-section" aria-labelledby="split">
          <h2 id="split">Where their coins' fees went</h2>
          <SplitBar by={data.totals.byRecipient} total={data.totals.feesSol} label="This creator's coins' fees by recipient" />
        </section>
      ) : null}

      <section className="fee-section" aria-labelledby="coins">
        <h2 id="coins">Their coins</h2>
        <div className="table-wrap">
          <table className="params fees">
            <thead>
              <tr>
                <th scope="col">Coin</th>
                <th scope="col">Mode</th>
                <th scope="col" className="num">
                  Volume (SOL)
                </th>
                <th scope="col" className="num">
                  Fees (SOL)
                </th>
                <th scope="col" className="num">
                  To creator
                </th>
                <th scope="col" className="num">
                  Last 24h
                </th>
              </tr>
            </thead>
            <tbody>
              {coins.map((c) => {
                const l = coinLabel(c);
                return (
                  <tr key={c.mint}>
                    <td data-label="Coin">
                      <a href={`/fees/${c.mint}`} className="fee-coin">
                        <strong>{l.ticker ? `$${l.ticker}` : short(c.mint)}</strong>
                        {l.name ? <span className="muted"> {l.name}</span> : null}
                      </a>
                      {c.status !== "curve" ? <span className="badge fee-grad">{STATUS[c.status]}</span> : null}
                    </td>
                    <td data-label="Mode">{MODE_LABEL[c.feeMode]}</td>
                    <td data-label="Volume (SOL)" className="num">
                      {sol(c.volumeSol)}
                    </td>
                    <td data-label="Fees (SOL)" className="num">
                      {sol(c.totalFeesSol)}
                    </td>
                    <td data-label="To creator" className="num">
                      <strong>{sol(c.byRecipient.creator)}</strong>
                    </td>
                    <td data-label="Last 24h" className="num">
                      {c.last24h && c.last24h.byRecipient.creator > 0 ? sol(c.last24h.byRecipient.creator) : <span className="muted">–</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="fee-section" aria-labelledby="links">
        <h2 id="links">Look it up</h2>
        <ul className="fee-links">
          <li>
            <a href={`https://solscan.io/account/${wallet}`}>This wallet on Solscan</a>
          </li>
        </ul>
        <p className="muted small">
          Earned counts every creator fee these coins have paid, claimed or not; the last 24 hours are estimated from
          higher.fun's volume. <a href="/fees#method">How it's worked out</a>. Last read {updatedAt(data.generatedAt)}. Coin
          names are written by their creators.
          {data.warnings.length ? ` ${data.warnings.join(" ")}` : ""}
        </p>
      </section>
    </>
  );
}
