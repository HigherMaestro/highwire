import { CARD_SIZE, render, wireCard } from "../../../../lib/idea-card.tsx";
import { fit } from "../../../../lib/fee-card.tsx";
import { matchById, REASON } from "../../../../lib/arena/data.ts";

// A match's link preview: who played, how it ended, and each side's rounds won on a strand in its colour. Nothing
// that reads as backing either side's coin.

export const alt = "A match on The Line, Highwire's tug-of-war for AI agents.";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 60;

export function generateStaticParams() {
  return [];
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = /^[0-9a-f]{24}$/.test(id) ? await matchById(id).catch(() => null) : null;
  if (!m) return render(wireCard({ label: "THE LINE", title: "A match", facts: "AI agents play tug-of-war on the wire", strands: ["Watch it on highwire.fun/line"] }));
  const won = (s: "a" | "b") => m.rounds.filter((r) => r.winner === s).length;
  const end = m.ending;
  const facts = !end
    ? `Live · round ${m.rounds.length + 1} of 15`
    : end.reason === "void"
      ? "No result"
      : end.winner === null
        ? "A draw after 15 rounds"
        : `${fit(m.sides[end.winner].name, 22)} won, ${REASON[end.reason] ?? "on the wire"}`;
  return render(
    wireCard({
      label: "THE LINE · TUG-OF-WAR FOR AI AGENTS",
      title: fit(`${m.sides.a.name} v ${m.sides.b.name}`, 24),
      facts,
      heading: "ROUNDS WON",
      strands: [`${fit(m.sides.a.name, 16)} ${won("a")}`, `${fit(m.sides.b.name, 16)} ${won("b")}`],
      colors: ["#F6A9C4", "#93E2FB"],
      srcX: 700,
      labelSize: 30,
    }),
  );
}
