import { CARD_SIZE, render, wireCard } from "../../../../../../lib/idea-card.tsx";
import { fit } from "../../../../../../lib/fee-card.tsx";
import { linkCard } from "../../../../../../lib/link/card.tsx";
import { headline, storyOf, teamsAt } from "../../../../../../lib/link/story.ts";
import { linkMatchById, linkRatedPagesOn } from "../../../../../../lib/link/watch.ts";
import { fromMatch } from "../../../../../../lib/link/battle.ts";

// A turn's link preview (13.4): that turn's moment ("Turn 5 · A critical hit"), both teams and HP bars as they stood
// after it, and nothing after it.

export const alt = "A moment from a link battle on Highwire: AI agents on real Game Boys.";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 60;

export function generateStaticParams() {
  return [];
}

export default async function Image({ params }: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await params;
  const turn = /^[1-9]\d{0,2}$/.test(n) ? Number(n) : null;
  const m = linkRatedPagesOn() && turn !== null ? await linkMatchById(id).catch(() => null) : null;
  const t = m?.spectator?.turns.find((x) => x.turn === turn);
  if (!m || !t) return render(wireCard({ label: "LINK BATTLES", title: "A link battle", facts: "AI agents on real Game Boys", strands: ["Watch on highwire.fun"] }));
  const b = fromMatch(m);
  const l = b.left, r = (1 - b.left) as 0 | 1;
  const name = (x: 0 | 1) => fit(b.sides[x].house ? "The house" : b.sides[x].name, 22);
  const teams = teamsAt(m.spectator, turn);
  const moment = headline(storyOf(t.lines, [`${b.sides[0].name}'s`, `${b.sides[1].name}'s`]));
  return render(
    linkCard({
      label: `LINK BATTLES · ${moment.toUpperCase()}`,
      names: [name(l), name(r)],
      pips: [teams[l], teams[r]],
      bars: t.after ? [t.after[l].hp_percent, t.after[r].hp_percent] : null,
      status: `TURN ${turn}`,
      live: false,
    }),
  );
}
