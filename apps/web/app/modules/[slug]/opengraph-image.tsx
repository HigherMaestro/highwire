import { notFound } from "next/navigation";
import { MODULE_CARD_ALT, CARD_SIZE, moduleCard } from "../../../lib/idea-card.tsx";
import { getModule, listModules } from "../../../lib/ideas.ts";

export const alt = MODULE_CARD_ALT;
export const size = CARD_SIZE;
export const contentType = "image/png";

// Drawn at build time, one per module, like the pages.
export const dynamicParams = false;
export function generateStaticParams() {
  return listModules().map((m) => ({ slug: m.slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const mod = getModule((await params).slug);
  if (!mod) notFound();
  return moduleCard(mod);
}
