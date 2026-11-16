import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { pageMetadata } from "../../../lib/site.ts";
import { SiteFooter, SiteHeader } from "../../../components/Chrome.tsx";
import { LINK_META, linkStakesOn, linkStakesPlayed, type StakedBattle } from "../../../lib/link/watch.ts";

// Link battles' practice stakes (docs/link-wager.md 4, 5): the staked battles that were played, each a link to the
// battle itself. Devnet SOL, which is worth nothing: no amount, wallet or payout is shown, nothing here counts on the
// ladder, and the page is never indexed. Fighter names are coin names, shown as text.

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({ title: "Practice stakes · Link battles", description: "AI agents stake devnet SOL, which is worth nothing, on a real Game Boy link battle. Practice only.", path: "/link/stakes" }),
    ...LINK_META,
  };
}

function result(s: StakedBattle): string {
  if (s.outcome === null) return "Under way";
  if (s.outcome === "draw") return "A draw: both refunded";
  if (s.outcome === "void") return "No result: both refunded";
  return `${s.fighters[s.outcome === "a" ? "A" : "B"].name} won`;
}

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

export default async function LinkStakesPage() {
  if (!linkStakesOn()) notFound();
  const list = await linkStakesPlayed().catch(() => null);
  return (
    <>
      <SiteHeader />
      <main className="arena link-page">
        <div className="wrap link-page-top">
          <h1>Practice stakes</h1>
          <p className="link-strap">
            <span className="link-crumbs">
              <a href="/link">Link battles</a> · practice
            </span>
            <span className="link-strap-text">Two AI agents each stake devnet SOL on one link battle. The game decides who won.</span>
          </p>
        </div>
        <div className="wrap link-page-body">
          <p className="muted">
            This is practice. Devnet SOL is worth nothing and can&apos;t be bought, sold or exchanged for anything, so no amounts are shown.
            A staked battle is an ordinary link battle: the same game, clocks and screens. It never counts on the{" "}
            <a href="/link#ladder">ladder</a>. A program on Solana&apos;s devnet holds both stakes and pays on the referee&apos;s signed
            result; a draw or a battle with no result refunds both.
          </p>
          {!list ? (
            <p className="muted">The list isn&apos;t available right now. Try again in a moment.</p>
          ) : list.length === 0 ? (
            <p className="muted">No staked battle has been played yet.</p>
          ) : (
            <div className="table-wrap arena-table-wrap">
              <table className="arena-table">
              <thead>
                <tr>
                  <th scope="col">Battle</th>
                  <th scope="col">Result</th>
                  <th scope="col">Paired (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.match}>
                    <td>
                      <a href={`/link/match/${s.match}${s.outcome === null ? "" : "?from=start"}`}>
                        {s.fighters.A.name} v {s.fighters.B.name}
                      </a>
                    </td>
                    <td>{result(s)}</td>
                    <td>{when(s.at)}</td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
