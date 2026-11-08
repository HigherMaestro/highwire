import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { coinUrl } from "highwire-core";
import { SiteFooter, SiteHeader } from "../../../components/Chrome.tsx";
import { SplitBar } from "../../../components/fees/SplitBar.tsx";
import { COLOR, FeeHero, Head, LinkCards, Tile, type Fact } from "../../../components/fees/Parts.tsx";
import { MODE_LABEL, RECIPIENTS, coinFees, coinLabel, isMint, short, sol, updatedAt, usd } from "../../../lib/fees.ts";
import { FEES_CARD, pageMetadata } from "../../../lib/site.ts";

export const revalidate = 600;

/** Built on first visit, then regenerated like /fees. */
export async function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ mint: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { mint } = await params;
  const data = isMint(mint) ? await coinFees(mint) : null;
  const coin = data?.coins[0];
  const ticker = coin ? coinLabel(coin).ticker : null;
  return pageMetadata({
    title: ticker ? `$${ticker} fees` : "Coin fees",
    description: `The fees ${ticker ? `$${ticker}` : "this coin"} has paid on higher.fun, and who got them.`,
    path: `/fees/${mint}`,
    card: FEES_CARD,
  });
}

const PHASE = { curve: "Bonding curve", pool: "Raydium pool" } as const;
const TO = Object.fromEntries(RECIPIENTS.map((r) => [r.key, r.label])) as Record<string, string>;
TO.creator = "Creator";
const STATUS = { graduated: "graduated", migrating: "graduating", curve: "on the curve" } as const;

export default async function CoinFeesPage({ params }: Props) {
  const { mint } = await params;
  if (!isMint(mint)) notFound();
  const data = await coinFees(mint);
  if (data === null) notFound();
  const c = data?.coins[0];
  if (!data || !c) {
    return (
      <>
        <SiteHeader />
        <main>
          <FeeHero id="coin-title" eyebrow={<a href="/fees">Ecosystem fees</a>} title={short(mint)} sub={mint} />
          <div className="wrap fees-body">
            <p className="notice">This coin's numbers couldn't be read from Solana just now. Try again in a few minutes.</p>
          </div>
        </main>
        <SiteFooter />
      </>
    );
  }
  const label = coinLabel(c);
  const facts: Fact[] = [
    { label: "Traded", value: `${sol(c.volumeSol)} SOL` },
    { label: "To the creator", value: `${sol(c.byRecipient.creator)} SOL` },
  ];
  if (c.holders) facts.push({ label: "To holders", value: `${sol(c.byRecipient.holders)} SOL` });
  if (c.last24h) facts.push({ label: "Last 24 hours", value: `${sol(c.last24h.feesSol)} SOL` });
  let i = 0;
  const next = () => String(++i).padStart(2, "0");
  return (
    <>
      <SiteHeader />
      <main>
        <FeeHero
          id="coin-title"
          eyebrow={
            <>
              <a href="/fees">Ecosystem fees</a> · {MODE_LABEL[c.feeMode]} · {STATUS[c.status]}
            </>
          }
          title={
            <>
              {label.ticker ? `$${label.ticker}` : short(c.mint)}
              {label.name ? <span className="muted fee-name"> {label.name}</span> : null}
            </>
          }
          sub={c.mint}
          figure={sol(c.totalFeesSol)}
          figureSub={`paid in fees${usd(c.totalFeesSol, data.solUsd) ? ` (${usd(c.totalFeesSol, data.solUsd)})` : ""}${c.last24h && c.last24h.feesSol > 0 ? `, ${sol(c.last24h.feesSol)} SOL of it in the last 24 hours (estimated)` : ""}`}
          facts={facts}
          readAt={data.generatedAt}
        />

        <div className="wrap fees-body">
          {c.totalFeesSol > 0 ? (
            <section id="split" className="fee-block" aria-labelledby="split-title">
              <Head id="split" n={next()} title="Where its fees went" />
              <div className="fee-panel fee-split-panel">
                <SplitBar by={c.byRecipient} total={c.totalFeesSol} label="This coin's fees by recipient" />
              </div>
            </section>
          ) : null}

          <section id="lines" className="fee-block" aria-labelledby="lines-title">
            <Head id="lines" n={next()} title="Every fee">
              {sol(c.curveVolumeSol)} SOL traded on the curve
              {c.status === "graduated" ? (c.poolVolumeSol == null ? "; the pool's volume couldn't be read" : `, ${sol(c.poolVolumeSol)} SOL in the pool`) : ""}.
              Measured lines are read from the chain; computed ones are volume times the on-chain rate.
            </Head>
            <div className="table-wrap fee-panel fee-table-panel">
              <table className="params fees">
                <thead>
                  <tr>
                    <th scope="col">Fee</th>
                    <th scope="col">Where</th>
                    <th scope="col">To</th>
                    <th scope="col" className="num">
                      Rate
                    </th>
                    <th scope="col" className="num">
                      SOL
                    </th>
                    <th scope="col">How we know</th>
                  </tr>
                </thead>
                <tbody>
                  {c.lines.map((l) => (
                    <tr key={`${l.phase}-${l.label}`}>
                      <td data-label="Fee">
                        <span className="fee-line-name">
                          <i style={{ background: COLOR[l.to] }} aria-hidden="true" />
                          {l.label}
                        </span>
                      </td>
                      <td data-label="Where">{PHASE[l.phase]}</td>
                      <td data-label="To">{TO[l.to]}</td>
                      <td data-label="Rate" className="num">
                        {Number(l.ratePct.toFixed(4))}%
                      </td>
                      <td data-label="SOL" className="num">
                        <strong>{sol(l.sol)}</strong>
                      </td>
                      <td data-label="How we know">
                        <span className={l.basis === "measured" ? "badge" : "badge fee-computed"}>{l.basis}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {c.pool || c.feeMode === "rewards" ? (
            <section id="claims" className="fee-block" aria-labelledby="claims-title">
              <Head id="claims" n={next()} title="Claims" />
              <div className="fee-tiles fee-tiles-auto">
                {c.pool ? (
                  <Tile label="Pool creator fees" value={sol(c.pool.creatorWaitingSol)} unit="SOL" sub="waiting in the pool for the creator" accent={COLOR.creator} />
                ) : null}
                {c.feeMode === "rewards" ? (
                  <Tile
                    label="Creator's curve vault"
                    value={sol(data.waiting.creatorCurveSol)}
                    unit="SOL"
                    sub={
                      <>
                        for <a href={`/fees/creator/${c.creator}`}>all the creator's coins</a>, and any on other LaunchLab launchpads
                      </>
                    }
                    accent={COLOR.creator}
                  />
                ) : null}
                {c.pool?.lockedLp ? (
                  <Tile
                    label="Locked-LP fees"
                    value={sol(c.pool.lockedLp.harvestedSol)}
                    unit="SOL"
                    sub={`collected by higher.fun's Fee Key so far; ${c.pool.lockedLp.sharePct}% of the pool is locked, and the creator gets a third, paid off-chain`}
                    accent={COLOR["higher.fun"]}
                  />
                ) : null}
              </div>
              <p className="fee-cta">
                <span>The creator can claim with Highwire: their agent builds the transaction for them to review and sign.</span>
                <a className="button" href="/docs#build_claim_creator_fees">
                  How to claim
                </a>
              </p>
            </section>
          ) : null}

          {c.holders ? (
            <section id="airdrops" className="fee-block" aria-labelledby="airdrops-title">
              <Head id="airdrops" n={next()} title="Holder airdrops">
                higher.fun passes part of its fee on each trade to this coin's holders as SOL
                {c.holders.creatorAdds ? ", and the creator gave their fees to holders too: the airdrop wallet is the coin's creator, so the creator fees above are theirs" : ""}.
                Holders claim on the coin's page on higher.fun.
              </Head>
              <div className="fee-tiles fee-tiles-auto">
                <Tile label="Airdropped" value={sol(c.holders.paidSol)} unit="SOL" sub="paid out to holders so far" accent={COLOR.holders} />
                <Tile label="Waiting" value={sol(c.holders.waitingSol)} unit="SOL" sub="in the airdrop wallet" accent={COLOR.holders} />
              </div>
            </section>
          ) : null}

          <section id="links" className="fee-block" aria-labelledby="links-title">
            <Head id="links" n={next()} title="Look it up" />
            <LinkCards
              links={[
                { href: coinUrl(c.mint), label: "On higher.fun", sub: c.holders ? "Trade it; holders claim their airdrops there" : "Its page, chart and trades" },
                { href: `/fees/creator/${c.creator}`, label: "The creator's earnings", sub: `${short(c.creator)}, across their coins` },
                { href: `https://solscan.io/token/${c.mint}`, label: "The coin on Solscan", sub: "Its mint, holders and transfers" },
                ...(c.holders ? [{ href: `https://solscan.io/account/${c.holders.wallet}`, label: "The airdrop wallet", sub: short(c.holders.wallet) }] : []),
                ...(c.pool ? [{ href: `https://solscan.io/account/${c.pool.poolId}`, label: "The Raydium pool", sub: short(c.pool.poolId) }] : []),
              ]}
            />
            <p className="muted small">
              <a href="/fees#method">How it's worked out</a>. Last read {updatedAt(data.generatedAt)}. Coin names are written by
              their creators.
              {data.warnings.length ? ` ${data.warnings.join(" ")}` : ""}
            </p>
          </section>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
