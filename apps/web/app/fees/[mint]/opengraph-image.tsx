import { CARD_SIZE } from "../../../lib/idea-card.tsx";
import { COIN_CARD_ALT, coinCard } from "../../../lib/fee-card.tsx";
import { coinFees, isMint } from "../../../lib/fees.ts";

export const alt = COIN_CARD_ALT;
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 600;

// Drawn on first request, then kept like the page.
export function generateStaticParams() {
  return [];
}

export default async function Image({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  return coinCard(isMint(mint) ? await coinFees(mint) : null, mint);
}
