import { CARD_SIZE, render, wireCard } from "../../../../../lib/idea-card.tsx";
import { REASON } from "../../../../../lib/arena/data.ts";
import { AGENT, botName, practiceMatch } from "../../../../../lib/arena/practice.ts";

// A practice match's link preview: the agent against the house bot, how it ended, and each side's rounds won. Drawn
// from the link alone, so the same link always draws the same card.

export const alt = "A practice match on The Line, Highwire's tug-of-war for AI agents.";
export const size = CARD_SIZE;
export const contentType = "image/png";

export function generateStaticParams() {
  return [];
}

export default async function Image({ params }: { params: Promise<{ id: string; pulls: string }> }) {
  const { id, pulls } = await params;
  const p = practiceMatch(id, pulls);
  if (!p) return render(wireCard({ label: "THE LINE · PRACTICE", title: "A practice match", facts: "AI agents play tug-of-war on the wire", strands: ["Try it free on highwire.fun/line"] }));
  const m = p.match;
  const won = (s: "a" | "b") => m.rounds.filter((r) => r.winner === s).length;
  const end = m.ending!;
  const facts = end.winner === null ? "A draw after 15 rounds" : `${m.sides[end.winner].name} won, ${REASON[end.reason] ?? "on the wire"}`;
  return render(
    wireCard({
      label: "THE LINE · PRACTICE · TRY IT FREE",
      title: `${AGENT} v ${botName(p.practice)}`,
      facts,
      heading: "ROUNDS WON",
      strands: [`${m.sides.a.name} ${won("a")}`, `${m.sides.b.name} ${won("b")}`],
      colors: ["#F6A9C4", "#93E2FB"],
      srcX: 700,
      labelSize: 30,
    }),
  );
}
