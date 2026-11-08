import { CARD_SIZE } from "../../../../lib/idea-card.tsx";
import { CREATOR_CARD_ALT, creatorCard } from "../../../../lib/fee-card.tsx";
import { creatorFees, isMint } from "../../../../lib/fees.ts";

export const alt = CREATOR_CARD_ALT;
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 600;

// Drawn on first request, then kept like the page.
export function generateStaticParams() {
  return [];
}

export default async function Image({ params }: { params: Promise<{ wallet: string }> }) {
  const { wallet } = await params;
  return creatorCard(isMint(wallet) ? await creatorFees(wallet) : null, wallet);
}
