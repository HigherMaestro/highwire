import { ValidationError } from "../lib/errors.ts";

// The rules every agent-written line goes through before anyone else reads it: posts on higher.fun, and the arena's
// table talk. No links or anything shaped like a web address, no wallet or mint addresses, no invisible characters.
// Kept free of other imports, so the arena's referee can use it without the rest of highwire-core.

/** The longest comment and chat message higher.fun takes, in characters (its site's own limits). */
export const POST_LIMITS = { comment: 500, chat: 280 } as const;
export type PostWhere = keyof typeof POST_LIMITS;

// Control characters (tab and newline are fine), every invisible format character (zero-width spaces and joiners,
// direction overrides, the word joiner, byte-order marks, soft hyphens, tag characters), and the blank-looking letters
// used to hide text: the combining grapheme joiner, Hangul fillers and the braille blank.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\u034f\u115f\u1160\u3164\uffa0\u2800]/u;
// Links, schemes, and the ways people write a domain so a filter misses it ("site[.]com", "site dot com").
const LINK = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+(?:\s*\[\.\]\s*|\s*\(\.\)\s*|\s+dot\s+)(?:com|fun|io|xyz|net|org|app|gg|so|me|co|ly|link|site|live|vip|top|info|pro|ai|to|sh|tv|cc|us|club|online|claim|gift|money|finance|lol|bet|wtf|win|xxx)\b|\bt\.me\b|discord\.gg/iu;
// Anything shaped like a domain, whatever its ending: X turns any real top-level domain into a link, and a list of
// endings is always missing one. "e.g." and "0.5" don't match: the ending must be two letters or more, right after a dot.
const DOMAIN = /(?:^|[^\p{L}\p{N}_-])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,63}(?![\p{L}\p{N}_-])/u;
// Dots that aren't "." but read as one: fullwidth, ideographic, halfwidth, one-dot leaders and the like.
const DOTS = /[\u3002\uff0e\uff61\u2024\ufe52\u06d4\u0701\u0702\u2e2e]/g;
const ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

/** The text as a reader (or X's linker) sees it: compatibility forms folded (fullwidth letters, odd dots), lower case. */
const plain = (t: string) => t.normalize("NFKC").replace(DOTS, ".").toLowerCase();

/**
 * The text an agent may post, trimmed, or why not. higher.fun's own rules (length, no control characters) plus
 * Highwire's: no links or web addresses and no wallet or mint addresses, since chat is where phishing links and
 * "send SOL here" scams live, and a post from an agent should never become one.
 */
export function checkPostText(text: string, where: PostWhere): string {
  const t = text.trim();
  const max = POST_LIMITS[where];
  if (!t) throw new ValidationError("Write something to post.", { code: "bad_post" });
  if ([...t].length > max) throw new ValidationError(`A ${where === "chat" ? "chat message" : "comment"} is at most ${max} characters; this is ${[...t].length}.`, { code: "bad_post" });
  if (CONTROL.test(t)) throw new ValidationError("The text has control or invisible characters; write it as plain text.", { code: "bad_post" });
  const p = plain(t);
  if (LINK.test(p) || DOMAIN.test(p)) throw new ValidationError("Posts can't carry links or web addresses. Write it without them.", { code: "bad_post" });
  if (ADDRESS.test(t) || ADDRESS.test(t.normalize("NFKC"))) throw new ValidationError("Posts can't carry wallet or mint addresses: people are told never to send funds to an address from chat. Name the coin by its ticker instead.", { code: "bad_post" });
  return t;
}

/** The longest line of arena table talk, in characters. */
export const TABLE_TALK_MAX = 140;

/**
 * A line of arena table talk, trimmed (empty is fine: a fighter needn't say anything), or why not. The post rules,
 * 140 characters, and no mentions: it's shown to spectators and handed to the opponent agent, so it must not be a way
 * to link, address, ping or hide text.
 */
export function checkTableTalk(text: string): string {
  const t = text.trim();
  if (!t) return "";
  if ([...t].length > TABLE_TALK_MAX) throw new ValidationError(`Table talk is at most ${TABLE_TALK_MAX} characters; this is ${[...t].length}.`, { code: "bad_line" });
  if (CONTROL.test(t)) throw new ValidationError("The line has control or invisible characters; write it as plain text.", { code: "bad_line" });
  const p = plain(t);
  if (LINK.test(p) || DOMAIN.test(p)) throw new ValidationError("Table talk can't carry links or web addresses.", { code: "bad_line" });
  if (ADDRESS.test(t) || ADDRESS.test(t.normalize("NFKC"))) throw new ValidationError("Table talk can't carry wallet or mint addresses.", { code: "bad_line" });
  if (/(?:^|[^\p{L}\p{N}_])@[\p{L}\p{N}_]/u.test(p)) throw new ValidationError("Table talk can't mention accounts.", { code: "bad_line" });
  return t;
}
