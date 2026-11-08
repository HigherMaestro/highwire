import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "../../../../components/Chrome.tsx";
import { SplitBar } from "../../../../components/fees/SplitBar.tsx";
import { COLOR, FeeHero, Head, LinkCards, Tile } from "../../../../components/fees/Parts.tsx";
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

type Data = NonNullable<Awaited<ReturnType<typeof creatorFees>>>;

export default async function CreatorFeesPage({ params }: Props) {
  const { wallet } = await params;
  // isMint checks a real 32-byte address, which is all a wallet is too.
  if (!isMint(wallet)) notFound();
  const data = await creatorFees(wallet);
  const eyebrow = (
    <>
      <a href="/fees#creators">Ecosystem fees</a> · Creator
    </>
  );
  return (
    <>
      <SiteHeader />
      <main>
        {data ? (
          <Creator wallet={wallet} data={data} eyebrow={eyebrow} />
        ) : (
          <>
            <FeeHero id="creator-title" eyebrow={eyebrow} title={short(wallet)} sub={wallet}>
              <p className="lead">
                {data === null
                  ? "This wallet hasn't created a coin on higher.fun."
                  : "This wallet's numbers couldn't be read just now. Try again in a few minutes."}
              </p>
              {data === null ? (
                <div className="fee-hero-ctas">
                  <a className="button" href="/skill.md">
                    Launch one with an agent
                  </a>
                  <a className="button button-quiet" href="/fees#earn">
                    What a coin earns its creator
                  </a>
                </div>
              ) : null}
            </FeeHero>
          </>
        )}
      </main>
      <SiteFooter />
    </>
  );
}

function Creator({ wallet, data, eyebrow }: { wallet: string; data: Data; eyebrow: ReactNode }) {
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
  const best = Math.max(...coins.map((c) => c.byRecipient.creator), 0);
  return (
    <>
      <FeeHero
        id="creator-title"
        eyebrow={eyebrow}
        title={short(wallet)}
        sub={wallet}
        figure={sol(earned)}
        figureSub={`earned as a creator${usd(earned, data.solUsd) ? ` (${usd(earned, data.solUsd)})` : ""}, claimed or not`}
        facts={[
          { label: "Waiting to claim", value: `${sol(claimable)} SOL` },
          { label: "Coins", value: graduated ? `${coins.length}, ${graduated} graduated` : String(coins.length) },
          { label: "Last 24 hours", value: `${sol(day)} SOL` },
          { label: "Their coins traded", value: `${sol(data.totals.volumeSol)} SOL` },
        ]}
        readAt={data.generatedAt}
      />

      <div className="wrap fees-body">
        <section id="claim" className="fee-block" aria-labelledby="claim-title">
          <Head id="claim" n="01" title="Waiting to be claimed">
            {claimable > 0 ? `${sol(claimable)} SOL that only this wallet can claim.` : "Nothing to claim right now."}
          </Head>
          <div className="fee-tiles fee-tiles-auto">
            <Tile
              label="Curve vault"
              value={sol(curveWaiting)}
              unit="SOL"
              sub="curve creator fees in this wallet's LaunchLab vault, which also holds fees from any coins it made on other launchpads"
              accent={COLOR.creator}
            />
            <Tile label="Pool creator fees" value={sol(poolWaiting)} unit="SOL" sub={`across ${graduated} graduated ${graduated === 1 ? "coin" : "coins"}`} accent={COLOR.creator} />
            {payouts ? (
              <Tile label="Owed by higher.fun" value={sol(payouts.pendingSol)} unit="SOL" sub={`its third of the locked-LP fees, paid off-chain; ${sol(payouts.paidOutSol)} SOL paid so far`} accent={COLOR["higher.fun"]} />
            ) : null}
          </div>
          <p className="fee-cta">
            <span>
              Your agent can claim with Highwire, building the transaction for you to sign, or claim and buy back on a schedule
              from its own wallet.
              {gave ? ` ${gave === 1 ? "One coin's" : `${gave} coins'`} creator fees go to holders instead, as the creator chose.` : ""}
            </span>
            <span className="fee-cta-buttons">
              <a className="button" href="/docs#build_claim_creator_fees">
                How to claim
              </a>
              <a className="button button-quiet" href="/ideas/buyback-coin">
                Buyback coin
              </a>
            </span>
          </p>
        </section>

        {data.totals.feesSol > 0 ? (
          <section id="split" className="fee-block" aria-labelledby="split-title">
            <Head id="split" n="02" title="Where their coins' fees went">
              All {sol(data.totals.feesSol)} SOL their coins have paid in fees, by who got it.
            </Head>
            <div className="fee-panel fee-split-panel">
              <SplitBar by={data.totals.byRecipient} total={data.totals.feesSol} label="This creator's coins' fees by recipient" />
            </div>
          </section>
        ) : null}

        <section id="coins" className="fee-block" aria-labelledby="coins-title">
          <Head id="coins" n="03" title="Their coins">
            By what each has paid its creator.
          </Head>
          <div className="fee-panel">
            <ol className="fee-board">
              {[...coins]
                .sort((a, b) => b.byRecipient.creator - a.byRecipient.creator)
                .map((c, i) => {
                  const l = coinLabel(c);
                  return (
                    <li key={c.mint}>
                      <span className="fee-board-rank">{String(i + 1).padStart(2, "0")}</span>
                      <span className="fee-board-who">
                        <a href={`/fees/${c.mint}`} className="fee-board-coin">
                          {l.ticker ? `$${l.ticker}` : short(c.mint)}
                          {l.name ? <span className="muted"> {l.name}</span> : null}
                        </a>
                        <span className="muted small">
                          {MODE_LABEL[c.feeMode]} · {STATUS[c.status]} · {sol(c.volumeSol)} SOL traded
                        </span>
                      </span>
                      <span className="fee-board-bar" aria-hidden="true">
                        <span style={{ width: `${best > 0 ? (c.byRecipient.creator / best) * 100 : 0}%` }} />
                      </span>
                      <span className="fee-board-value">
                        <strong>{sol(c.byRecipient.creator)} SOL</strong>
                        <span className="muted small">
                          {c.last24h && c.last24h.byRecipient.creator > 0 ? `+${sol(c.last24h.byRecipient.creator)} in 24h` : `${sol(c.totalFeesSol)} in fees`}
                        </span>
                      </span>
                    </li>
                  );
                })}
            </ol>
          </div>
        </section>

        <section id="links" className="fee-block" aria-labelledby="links-title">
          <Head id="links" n="04" title="Look it up" />
          <LinkCards
            links={[
              { href: `https://solscan.io/account/${wallet}`, label: "This wallet on Solscan", sub: short(wallet) },
              { href: "/fees#creators", label: "Top creators", sub: "Every creator on higher.fun, ranked" },
              { href: "/fees#earn", label: "What a coin earns", sub: "The calculator, at a volume you pick" },
            ]}
          />
          <p className="muted small">
            Earned counts every creator fee these coins have paid, claimed or not; the last 24 hours are estimated from
            higher.fun's volume. <a href="/fees#method">How it's worked out</a>. Last read {updatedAt(data.generatedAt)}. Coin
            names are written by their creators.
            {data.warnings.length ? ` ${data.warnings.join(" ")}` : ""}
          </p>
        </section>
      </div>
    </>
  );
}
