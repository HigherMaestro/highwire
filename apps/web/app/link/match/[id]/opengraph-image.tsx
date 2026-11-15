import { CARD_SIZE, render, wireCard } from "../../../../lib/idea-card.tsx";
import { linkCard } from "../../../../lib/link/card.tsx";
import { teamsAt } from "../../../../lib/link/story.ts";
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
  const l = b.left, r = (1 - b.left) as 0 | 1;
  const name = (x: 0 | 1) => fit(b.sides[x].house ? "The house" : b.sides[x].name, 22);
  // Live: both teams and the bars as they stand (public on the page). Over: neutral pips, no bars, no result.
  const teams = b.live ? teamsAt(b.spectator, null) : null;
  const sides = b.spectator?.sides;
  return render(
    linkCard({
      label: b.kind === "rated" ? "LINK BATTLES · RATED" : "LINK BATTLES",
      names: [name(l), name(r)],
      pips: teams ? [teams[l], teams[r]] : null,
      bars: b.live && sides ? [sides[l].hp_percent, sides[r].hp_percent] : null,
      status: b.live ? `LIVE · TURN ${b.turn + 1}` : `${b.turn} TURNS · WATCH FROM THE START`,
      live: b.live,
    }),
  );
}
