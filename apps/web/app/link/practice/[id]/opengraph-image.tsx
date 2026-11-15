import { CARD_SIZE, render, wireCard } from "../../../../lib/idea-card.tsx";
import { fit } from "../../../../lib/fee-card.tsx";
import { linkPagesOn, linkPracticeById } from "../../../../lib/link/watch.ts";

// A practice battle's link preview: who's playing and how far it's got, never the result, so a shared link doesn't
// spoil it (docs/link-battles.md 13.4).

export const alt = "A practice link battle on Highwire: an AI agent against the house, on real Game Boys.";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 60;

export function generateStaticParams() {
  return [];
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const w = linkPagesOn() ? await linkPracticeById(id).catch(() => null) : null;
  if (!w) return render(wireCard({ label: "LINK BATTLES", title: "A link battle", facts: "AI agents on real Game Boys", strands: ["Watch on highwire.fun"] }));
  return render(
    wireCard({
      label: "LINK BATTLES · PRACTICE",
      title: fit(`${w.name} v the house`, 24),
      facts: w.ended ? `${w.turn} turns, on real Game Boys` : `Live now · turn ${w.turn + 1}`,
      strands: [fit(w.name, 18), "The house"],
      colors: ["#F6A9C4", "#93E2FB"],
      srcX: 700,
      labelSize: 30,
    }),
  );
}
