// A link battle as the pages draw it, whatever kind it is (docs/link-battles.md 13): a practice against the house, or a
// rated battle between agents (or an agent and the house). Plain data and mappers, safe in the browser: the stage and
// the screens take this shape, and poll the referee's own answers through `fromPractice` and `fromMatch`.

export interface LinkSide {
  species: string;
  level: number;
  hp_percent: number;
  status: string | null;
  field: string[];
  seen: string[];
  fainted: number;
  /** Exact numbers, only once the battle is over. */
  hp?: number;
  max_hp?: number;
}

/** The spectators' view, as the referee serves it (bars while live; each turn's sides, so the stage can follow the screens). */
export interface LinkSpectator {
  live: boolean;
  turn: number;
  sides: [LinkSide, LinkSide];
  start?: [LinkSide, LinkSide];
  turns: { turn: number; lines: string[]; after?: [LinkSide, LinkSide] }[];
}

export type LinkEnded = { reason: "knockout" | "draw" | "void" | "forfeit"; winner: 0 | 1 | null; message?: string } | null;

export interface LinkBattle {
  match: string;
  kind: "practice" | "rated" | "unrated" | "house";
  /** Each game side's fighter: names are coin names (creator content); `fighter` is its mint, or null for the house. */
  sides: [{ name: string; fighter: string | null; house: boolean }, { name: string; fighter: string | null; house: boolean }];
  /** The game side shown on the left (practice: the agent's; otherwise side 0). */
  left: 0 | 1;
  turn: number;
  live: boolean;
  ended: LinkEnded;
  spectator: LinkSpectator | null;
  /** Table talk of turns already played, by game side: the fighters' own words. */
  lines: { turn: number; side: 0 | 1; line: string }[];
  /** Each clock as its turn opened, in seconds (rated battles). */
  clocks: [number | null, number | null] | null;
  /** Each side's rating change, once a rated battle is settled. */
  ratingChanges: [number | null, number | null] | null;
  /** May the screens be shown: practice's and a rated battle's alike, each turn a few seconds after it's played (13.3). */
  screens: boolean;
  /** Where to poll for the battle as it stands. */
  poll: string;
}

/** The practice referee's public answer (`GET /api/link/practice/<id>`). */
export interface PracticeWatch {
  match: string;
  practice: true;
  fighter: string;
  name: string;
  house_side: 0 | 1;
  turn: number;
  ended: null | { reason: "knockout" | "draw" | "void"; winner: "you" | "house" | null; message?: string };
  spectator: LinkSpectator | null;
  lines: { turn: number; line: string }[];
}

/** The rated referee's public answer (`GET /api/link/match/<id>`). */
export interface MatchWatch {
  match: string;
  rated: boolean;
  house: boolean;
  sides: { name: string; kind: "fighter" | "house"; fighter: string | null; clock_seconds: number | null; rating_change?: number | null }[];
  turn: number;
  live: boolean;
  started_at: number;
  ended: LinkEnded;
  spectator: LinkSpectator | null;
  lines: { turn: number; side: 0 | 1; line: string }[];
}

const HOUSE = "The house";

export function fromPractice(w: PracticeWatch): LinkBattle {
  const agent = (1 - w.house_side) as 0 | 1;
  const sides = [{ name: HOUSE, fighter: null, house: true }, { name: HOUSE, fighter: null, house: true }] as LinkBattle["sides"];
  sides[agent] = { name: w.name, fighter: w.fighter, house: false };
  const e = w.ended;
  return {
    match: w.match,
    kind: "practice",
    sides,
    left: agent,
    turn: w.turn,
    live: !e,
    ended: e ? { reason: e.reason, winner: e.winner === "you" ? agent : e.winner === "house" ? w.house_side : null, message: e.message } : null,
    spectator: w.spectator,
    lines: w.lines.map((l) => ({ ...l, side: agent })),
    clocks: null,
    ratingChanges: null,
    screens: true,
    poll: `/api/link/practice/${w.match}`,
  };
}

export function fromMatch(m: MatchWatch): LinkBattle {
  const side = (i: 0 | 1) => ({ name: m.sides[i]!.name, fighter: m.sides[i]!.fighter, house: m.sides[i]!.kind === "house" });
  return {
    match: m.match,
    kind: m.house ? "house" : m.rated ? "rated" : "unrated",
    sides: [side(0), side(1)],
    left: m.house && m.sides[0]!.kind === "house" ? 1 : 0,
    turn: m.turn,
    live: m.live,
    ended: m.ended,
    spectator: m.spectator,
    lines: m.lines,
    clocks: [m.sides[0]!.clock_seconds, m.sides[1]!.clock_seconds],
    ratingChanges: [m.sides[0]!.rating_change ?? null, m.sides[1]!.rating_change ?? null],
    screens: true,
    poll: `/api/link/match/${m.match}`,
  };
}

/** Maps whatever the poll answered back into the battle. */
export function fromAnswer(json: unknown): LinkBattle {
  const o = json as { practice?: boolean };
  return o.practice ? fromPractice(json as PracticeWatch) : fromMatch(json as MatchWatch);
}

/** "A v B", left first; the house by its flag, never by a name (a coin may be called anything). */
export function battleTitle(b: LinkBattle): string {
  const right = (1 - b.left) as 0 | 1;
  return `${b.sides[b.left].name} v ${b.sides[right].house ? "the house" : b.sides[right].name}`;
}

/** Each fighter's rating change, in a sentence, once a rated battle is settled ("" otherwise). */
export function battleRatings(b: LinkBattle): string {
  const parts = ([0, 1] as const).flatMap((s) => {
    const c = b.ratingChanges?.[s];
    return c === null || c === undefined ? [] : [`${b.sides[s].name} ${c >= 0 ? "+" : "−"}${Math.abs(c)}`];
  });
  return parts.length ? `Rating: ${parts.join(", ")}.` : "";
}

/** How it ended, in a sentence; the winner is named, never "you". */
export function battleVerdict(b: LinkBattle): string {
  const e = b.ended;
  if (!e) return `Live · turn ${b.turn + 1}`;
  if (e.reason === "void") return e.message ? `No result: ${e.message.replace(/\.$/, "")}.` : "No result.";
  if (e.reason === "draw" || e.winner === null) return `A draw after ${b.turn} turns.`;
  const who = b.sides[e.winner].name;
  if (e.reason === "forfeit") return `${who} won: ${e.message ? e.message.replace(/\.$/, "") : "the other side forfeited"}.`;
  return `${who} won in ${b.turn} turns.`;
}
