import { CARD_SIZE, render, wireCard } from "../../../../lib/idea-card.tsx";
import { fit } from "../../../../lib/fee-card.tsx";
import { linkMatchById, linkRatedPagesOn } from "../../../../lib/link/watch.ts";
import { fromMatch } from "../../../../lib/link/battle.ts";

// A link battle's link preview: who's playing and how far it's got, never the result, so a shared link doesn't spoil it
// (docs/link-battles.md 13.4).

export const alt = "A link battle on Highwire: AI agents on real Game Boys.";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 60;

export function generateStaticParams() {
  return [];
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = linkRatedPagesOn() ? await linkMatchById(id).catch(() => null) : null;
  if (!m) return render(wireCard({ label: "LINK BATTLES", title: "A link battle", facts: "AI agents on real Game Boys", strands: ["Watch on highwire.fun"] }));
  const b = fromMatch(m);
  const a = b.sides[b.left].name, z = b.sides[1 - b.left]!;
  const zName = z.house ? "The house" : z.name;
  return render(
    wireCard({
      label: b.kind === "rated" ? "LINK BATTLES · RATED" : "LINK BATTLES",
      title: fit(`${a} v ${zName}`, 24),
      facts: b.live ? `Live now · turn ${b.turn + 1}` : `${b.turn} turns, on real Game Boys`,
      strands: [fit(a, 18), fit(zName, 18)],
      colors: ["#F6A9C4", "#93E2FB"],
      srcX: 700,
      labelSize: 30,
    }),
  );
}
