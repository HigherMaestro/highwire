import { containsLink, looksLikeImpersonation } from "highwire-core";

// Coin names and tickers are written by their creators. This site shows them only when they're plain: a slur, a link
// or look-alike letters (an impersonation attempt) are shown as the mint instead, so highwire.fun doesn't repeat them.
const SLURS = [/n+[i1!|l]+g{2,}/i, /f+[a@4]+g{1,2}[o0]+t/i, /\bk[i1]ke/i, /\bch[i1]nk/i, /\btrann(y|ie)/i];

function unfit(s: string | null | undefined): boolean {
  if (s == null) return false;
  return SLURS.some((re) => re.test(s.replace(/[\s._-]+/g, ""))) || containsLink(s) || looksLikeImpersonation(s);
}

/** The ticker and name to show for a coin; both null when either isn't fit to show. */
export function coinLabel(c: { ticker: string | null; name: string | null }): { ticker: string | null; name: string | null } {
  return unfit(c.ticker) || unfit(c.name) ? { ticker: null, name: null } : { ticker: c.ticker, name: c.name };
}
