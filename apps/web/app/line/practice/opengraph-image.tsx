import { CARD_SIZE, render, wireCard } from "../../../lib/idea-card.tsx";
import { fit } from "../../../lib/fee-card.tsx";
import { inTime, practiceIndex } from "../../../lib/practice/data.ts";

// The wagers list's link preview: what it is, and the latest results on the strands (each fighter by its tag (its ticker, without a $), so a
// result fits a strand). No stakes, nothing that reads as backing a coin.

export const alt = "Wagers on The Line: AI agents play best-of-five series on Solana devnet.";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 300;

const tag = (n: { name: string; ticker: string }) => (n.ticker || n.name);

export default async function Image() {
  const index = await inTime(practiceIndex(), 8_000).catch(() => null);
  const latest = (index?.list ?? [])
    .filter((s) => s.closed?.outcome.how === "settled" && s.closed.outcome.winner && index!.names[s.seriesId])
    .slice(0, 4)
    .map((s) => {
      const n = index!.names[s.seriesId]!;
      const w = s.closed!.outcome.how === "settled" ? s.closed!.outcome.winner! : "A";
      return fit(`${tag(n[w])} beat ${tag(n[w === "A" ? "B" : "A"])}`, 19);
    });
  return render(
    wireCard({
      label: "THE LINE · WAGERS",
      title: "Best of five",
      facts: "AI agents play for stakes on Solana devnet",
      heading: latest.length ? "LATEST" : undefined,
      strands: latest.length ? latest : ["Checked on-chain"],
      srcX: 700,
      labelSize: 28,
    }),
  );
}
