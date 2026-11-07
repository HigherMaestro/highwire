import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { coinUrl } from "highwire-core";
import { SiteFooter, SiteHeader } from "../../../components/Chrome.tsx";
import { SplitBar } from "../../../components/fees/SplitBar.tsx";
import { MODE_LABEL, RECIPIENTS, coinFees, coinLabel, isMint, sol, updatedAt, usd } from "../../../lib/fees.ts";

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
  return {
    title: ticker ? `$${ticker} fees` : "Coin fees",
    description: coin ? `The fees ${ticker ? `$${ticker}` : "this coin"} has paid on higher.fun, and who got them.` : undefined,
    alternates: { canonical: `/fees/${mint}` },
  };
}

const PHASE = { curve: "Bonding curve", pool: "Raydium pool" } as const;
const TO = Object.fromEntries(RECIPIENTS.map((r) => [r.key, r.label])) as Record<string, string>;
TO.creator = "Creator";

export default async function CoinFeesPage({ params }: Props) {
  const { mint } = await params;
  if (!isMint(mint)) notFound();
  const data = await coinFees(mint);
  if (data === null) notFound();
  const c = data?.coins[0];
  const label = c ? coinLabel(c) : null;
  return (
    <>
      <SiteHeader />
      <main className="fees-page">
        <div className="wrap">
          <p className="small">
            <a href="/fees">← All coins</a>
          </p>
          {!data || !c ? (
            <p className="notice">This coin's numbers couldn't be read from Solana just now. Try again in a few minutes.</p>
          ) : (
            <>
              <header className="docs-intro fees-intro">
                <p className="eyebrow">
                  {MODE_LABEL[c.feeMode]} · {c.status === "graduated" ? "graduated" : c.status === "migrating" ? "graduating" : "on the curve"}
                </p>
                <h1>
                  {label?.ticker ? `$${label.ticker}` : `${c.mint.slice(0, 4)}…${c.mint.slice(-4)}`}
                  {label?.name ? <span className="muted fee-name"> {label.name}</span> : null}
                </h1>
                <p className="mono-wrap muted small">{c.mint}</p>
              </header>

              <ul className="stats fee-stats">
                <li>
                  <span className="stat-n">{sol(c.totalFeesSol)} SOL</span>
                  <span className="stat-label">in fees{usd(c.totalFeesSol, data.solUsd) ? ` · ${usd(c.totalFeesSol, data.solUsd)}` : ""}</span>
                </li>
                <li>
                  <span className="stat-n">{sol(c.volumeSol)} SOL</span>
                  <span className="stat-label">traded</span>
                </li>
                <li>
                  <span className="stat-n">{sol(c.byRecipient.creator)} SOL</span>
                  <span className="stat-label">to the creator</span>
                </li>
                {c.holders ? (
                  <li>
                    <span className="stat-n">{sol(c.byRecipient.holders)} SOL</span>
                    <span className="stat-label">to holders, as airdrops</span>
                  </li>
                ) : null}
                {c.volume24hSol != null ? (
                  <li>
                    <span className="stat-n">{sol(c.volume24hSol)} SOL</span>
                    <span className="stat-label">traded in 24 hours</span>
                  </li>
                ) : null}
              </ul>

              {c.totalFeesSol > 0 ? (
                <section className="fee-section" aria-labelledby="split">
                  <h2 id="split">Where its fees went</h2>
                  <SplitBar by={c.byRecipient} total={c.totalFeesSol} label="This coin's fees by recipient" />
                </section>
              ) : null}

              <section className="fee-section" aria-labelledby="lines">
                <h2 id="lines">Every fee</h2>
                <p className="muted fee-section-lede">
                  {sol(c.curveVolumeSol)} SOL traded on the curve
                  {c.status === "graduated" ? (c.poolVolumeSol == null ? "; the pool's volume couldn't be read" : `, ${sol(c.poolVolumeSol)} SOL in the pool`) : ""}.
                </p>
                <div className="table-wrap">
                  <table className="params fees">
                    <thead>
                      <tr>
                        <th scope="col">Where</th>
                        <th scope="col">Fee</th>
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
                          <td data-label="Where">{PHASE[l.phase]}</td>
                          <td data-label="Fee">{l.label}</td>
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

              {c.pool ? (
                <section className="fee-section" aria-labelledby="claims">
                  <h2 id="claims">Claims</h2>
                  <ul className="stats">
                    <li>
                      <span className="stat-n">{sol(c.pool.creatorWaitingSol)} SOL</span>
                      <span className="stat-label">pool creator fees waiting for the creator</span>
                    </li>
                    {c.pool.lockedLp ? (
                      <li>
                        <span className="stat-n">{sol(c.pool.lockedLp.harvestedSol)} SOL</span>
                        <span className="stat-label">
                          of locked-LP fees collected by higher.fun's Fee Key so far ({c.pool.lockedLp.sharePct}% of the pool is
                          locked)
                        </span>
                      </li>
                    ) : null}
                    {c.feeMode === "rewards" ? (
                      <li>
                        <span className="stat-n">{sol(data.waiting.creatorCurveSol)} SOL</span>
                        <span className="stat-label">curve creator fees in the creator's vault (all their coins)</span>
                      </li>
                    ) : null}
                  </ul>
                  <p className="muted small">
                    The creator can claim with Highwire's <a href="/docs#build_claim_creator_fees">build_claim_creator_fees</a>.
                    {c.pool.lockedLp ? " Their third of the locked-LP fees is paid by higher.fun, off-chain." : ""}
                  </p>
                </section>
              ) : c.feeMode === "rewards" ? (
                <section className="fee-section" aria-labelledby="claims">
                  <h2 id="claims">Claims</h2>
                  <ul className="stats">
                    <li>
                      <span className="stat-n">{sol(data.waiting.creatorCurveSol)} SOL</span>
                      <span className="stat-label">curve creator fees in the creator's vault (all their coins)</span>
                    </li>
                  </ul>
                </section>
              ) : null}

              {c.holders ? (
                <section className="fee-section" aria-labelledby="airdrops">
                  <h2 id="airdrops">Holder airdrops</h2>
                  <ul className="stats">
                    <li>
                      <span className="stat-n">{sol(c.holders.paidSol)} SOL</span>
                      <span className="stat-label">airdropped to holders so far</span>
                    </li>
                    <li>
                      <span className="stat-n">{sol(c.holders.waitingSol)} SOL</span>
                      <span className="stat-label">waiting in the airdrop wallet</span>
                    </li>
                  </ul>
                  <p className="muted small">
                    higher.fun passes part of its fee on each trade to this coin's holders as SOL
                    {c.holders.creatorAdds ? ", and the creator gave their fees to holders too: the airdrop wallet is the coin's creator, so the creator fees above are theirs" : ""}.
                    Holders claim on the coin's page on higher.fun. Airdrop wallet:{" "}
                    <a className="mono-wrap" href={`https://solscan.io/account/${c.holders.wallet}`}>
                      {c.holders.wallet}
                    </a>
                    .
                  </p>
                </section>
              ) : null}

              <section className="fee-section" aria-labelledby="links">
                <h2 id="links">Look it up</h2>
                <ul className="fee-links">
                  <li>
                    <a href={coinUrl(c.mint)}>On higher.fun</a>
                  </li>
                  <li>
                    <a href={`https://solscan.io/token/${c.mint}`}>The coin on Solscan</a>
                  </li>
                  <li>
                    <a href={`https://solscan.io/account/${c.creator}`}>The creator's wallet on Solscan</a>
                  </li>
                  {c.pool ? (
                    <li>
                      <a href={`https://solscan.io/account/${c.pool.poolId}`}>The Raydium pool on Solscan</a>
                    </li>
                  ) : null}
                </ul>
                <p className="muted small">
                  Measured lines are read from the chain; computed ones are volume times the on-chain rate.{" "}
                  <a href="/fees#method">How it's worked out</a>. Last read {updatedAt(data.generatedAt)}. Coin names are
                  written by their creators.
                </p>
              </section>
            </>
          )}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
