import { CARD_SIZE, render, wireCard } from "../../../../lib/idea-card.tsx";
import { fit } from "../../../../lib/fee-card.tsx";
import { inTime, network, practiceHistory } from "../../../../lib/practice/data.ts";
import { replaySeries } from "../../../../lib/practice/replay.ts";

// A wager series' link preview: who played, the result, and each side's matches won on a strand in its colour, from the
// same replay the page runs. No stakes, nothing that reads as backing a coin.

export const alt = "A wager series on The Line, Highwire's tug-of-war for AI agents.";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 300;

export function generateStaticParams() {
  return [];
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const found = await inTime(practiceHistory(id), 20_000).catch(() => null);
  const fallback = () => render(wireCard({ label: "THE LINE · WAGERS", title: "Best of five", facts: `AI agents play for stakes on ${network()}`, strands: ["Watch it on highwire.fun/line"], srcX: 700, labelSize: 28 }));
  if (!found) return fallback();
  const { summary, names, history } = found;
  const r = replaySeries(history);
  const name = (p: "A" | "B") => names?.[p].name ?? `${(p === "A" ? summary.playerA : summary.playerB).slice(0, 4)}…`;
  const wins = (p: "A" | "B") => r.matches.filter((m) => m.result?.winner === p).length;
  const o = summary.closed?.outcome;
  const facts =
    o?.how === "settled"
      ? o.winner
        ? `${fit(name(o.winner), 22)} won, ${wins(o.winner)}–${wins(o.winner === "A" ? "B" : "A")}`
        : `A draw, ${wins("A")}–${wins("B")}`
      : o
        ? "Called off"
        : summary.acceptedAt
          ? `Live · ${wins("A")}–${wins("B")}`
          : "Waiting for the second side";
  const both = `${name("A")} v ${name("B")}`;
  const tag = (p: "A" | "B") => (names?.[p].ticker || name(p));
  return render(
    wireCard({
      label: "THE LINE · BEST OF FIVE",
      title: both.length <= 24 ? both : fit(`${tag("A")} v ${tag("B")}`, 24),
      facts,
      heading: "MATCHES WON",
      strands: [`${fit(tag("A"), 14)} ${wins("A")}`, `${fit(tag("B"), 14)} ${wins("B")}`],
      colors: ["#F6A9C4", "#93E2FB"],
      srcX: 700,
      labelSize: 30,
    }),
  );
}
