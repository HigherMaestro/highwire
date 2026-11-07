import { notFound } from "next/navigation";
import { IDEA_CARD_ALT, CARD_SIZE, ideaCard } from "../../../lib/idea-card.tsx";
import { getIdea, listIdeas } from "../../../lib/ideas.ts";

export const alt = IDEA_CARD_ALT;
export const size = CARD_SIZE;
export const contentType = "image/png";

// Drawn at build time, one per idea, like the pages.
export const dynamicParams = false;
export function generateStaticParams() {
  return listIdeas().map((i) => ({ slug: i.slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const idea = getIdea((await params).slug);
  if (!idea) notFound();
  return ideaCard(idea);
}
