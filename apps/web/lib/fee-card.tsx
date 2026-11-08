import type { ImageResponse } from "next/og";
import type { EcosystemFees, Recipient } from "highwire-core";
import { render, wireCard } from "./idea-card.tsx";
import { MODE_LABEL, RECIPIENTS, coinLabel, short, sol } from "./fees.ts";
import type { Card } from "./site.ts";

// The coin and creator pages' link previews, in the family of /fees's card: a name on the left with its fees, and on
// the right the wire splitting into who got them. Drawn on request from the same read as the page, so a shared link
// shows the numbers it had when it was shared.

export const COIN_CARD_ALT = "A higher.fun coin's fees on Highwire: what it has paid, and how much went to its creator, higher.fun, Raydium and the pool.";
export const CREATOR_CARD_ALT = "A higher.fun creator's earnings on Highwire: what their coins have paid them, coin by coin.";

export const coinCardFor = (mint: string): Card => ({ url: `/fees/${mint}/opengraph-image`, alt: COIN_CARD_ALT });
export const creatorCardFor = (wallet: string): Card => ({ url: `/fees/creator/${wallet}/opengraph-image`, alt: CREATOR_CARD_ALT });

const NAME: Record<Recipient, string> = { creator: "Creator", "higher.fun": "higher.fun", holders: "Holders", Raydium: "Raydium", liquidity: "The pool" };

/** Fits a label beside a strand: the card has room for about fourteen characters there. */
export const fit = (s: string, n = 14) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A coin's card: its ticker, what it has paid in fees, and the biggest recipients on the strands. */
export function coinCard(data: EcosystemFees | null | undefined, mint: string): Promise<ImageResponse> {
  const c = data?.coins[0];
  if (!c) return render(wireCard({ label: "COIN FEES", title: short(mint), facts: "Every fee, read from Solana", strands: ["Creator", "higher.fun", "Raydium", "The pool"], srcX: 700, labelSize: 32 }));
  const ticker = coinLabel(c).ticker;
  const top = (Object.keys(NAME) as Recipient[])
    .filter((r) => c.byRecipient[r] > 0)
    .sort((a, b) => c.byRecipient[b] - c.byRecipient[a])
    .slice(0, 4);
  const strands = top.map((r) => `${NAME[r]} ${sol(c.byRecipient[r])}`);
  // Each recipient in its colour on the site, so a card matches the page it links to.
  const colors = top.map((r) => RECIPIENTS.find((x) => x.key === r)!.color);
  return render(
    wireCard({
      label: `COIN FEES · ${MODE_LABEL[c.feeMode].toUpperCase()}`,
      title: ticker ? fit(`$${ticker}`, 12) : short(c.mint),
      facts: `${sol(c.totalFeesSol)} SOL in fees · ${sol(c.byRecipient.creator)} to its creator`,
      heading: "WHO GOT IT (SOL)",
      strands: strands.length ? strands : ["No fees yet"],
      colors: strands.length ? colors : undefined,
      srcX: 700,
      labelSize: 30,
    }),
  );
}

/** A creator's card: the wallet, what it has earned, and its best coins on the strands. */
export function creatorCard(data: EcosystemFees | null | undefined, wallet: string): Promise<ImageResponse> {
  const coins = [...(data?.coins ?? [])].sort((a, b) => b.byRecipient.creator - a.byRecipient.creator);
  const earned = data?.totals.byRecipient.creator ?? 0;
  const strands = coins.slice(0, 4).map((c) => {
    const t = coinLabel(c).ticker;
    return `${fit(t ? `$${t}` : short(c.mint), 10)} ${sol(c.byRecipient.creator)}`;
  });
  return render(
    wireCard({
      label: "CREATOR EARNINGS",
      title: short(wallet),
      facts: coins.length ? `${sol(earned)} SOL earned from ${coins.length} ${coins.length === 1 ? "coin" : "coins"}` : "No higher.fun coins yet",
      heading: coins.length ? "THEIR COINS (SOL)" : undefined,
      strands: strands.length ? strands : ["Launch one", "with an agent"],
      srcX: 700,
      labelSize: 30,
    }),
  );
}
