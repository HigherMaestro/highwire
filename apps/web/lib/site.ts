import type { Metadata } from "next";
import { HIGHWIRE_WALLET } from "highwire-core/browser";

export const SITE_URL = "https://highwire.fun";
export const MCP_URL = `${SITE_URL}/mcp`;
export const REPO_URL = "https://github.com/HigherMaestro/highwire";
export const X_HANDLE = "@Highwiredotfun";
export const X_URL = "https://x.com/Highwiredotfun";

/** Highwire's one wallet: donations and the 0.3% trade fee. Anything else claiming to collect for Highwire isn't us. */
export const DONATION_WALLET = HIGHWIRE_WALLET;
export const DONATION_URL = `https://solscan.io/account/${DONATION_WALLET}`;

/** A link preview image: the same one serves Open Graph and X. */
export type Card = { url: string; alt: string };

/** The site's own card, app/opengraph-image.png (and its twin twitter-image.png), with the alt text in its .alt.txt. */
export const SITE_CARD: Card = {
  url: "/opengraph-image.png",
  alt: "Highwire: your agent can now trade, launch and claim on higher.fun. An MCP server, on npm and the MCP Registry.",
};

/** /fees's card, app/fees/opengraph-image.png, which the coins' fee pages share. */
export const FEES_CARD: Card = {
  url: "/fees/opengraph-image.png",
  alt: "Highwire: every fee on higher.fun, and who got it. Creators, higher.fun, Raydium and the pool, read from Solana.",
};

/**
 * A page's title, description, canonical path and card, for search and for link previews. A page that sets only
 * `title` and `description` shares the homepage's Open Graph and X tags, so its links preview as the homepage. Once a
 * page sets them, its tags win over any opengraph-image file, so a page with its own card names it here.
 */
export function pageMetadata({ title, description, path, card = SITE_CARD }: { title: string; description: string; path: string; card?: Card }): Metadata {
  const full = `${title} · Highwire`;
  const images = [{ ...card, width: 1200, height: 630 }];
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: "website", siteName: "Highwire", url: path, title: full, description, images },
    twitter: { card: "summary_large_image", site: X_HANDLE, creator: X_HANDLE, title: full, description, images },
  };
}
