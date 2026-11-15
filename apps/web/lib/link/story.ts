import type { LinkSide, LinkSpectator } from "./battle.ts";

// A link battle told as a story a spectator reads at a glance (docs/link-battles.md 13.2): each side's team as three
// pips, the score in Pokémon left, both teams' HP turn by turn, and each turn's lines grouped by who did what, with the
// moments that matter (a critical hit, a super effective hit, a miss, a faint, a switch) picked out. Everything here is
// derived from the spectators' view: bars, not numbers, while a battle is live, and nothing either side hasn't shown.
// Plain functions, safe in the browser.

/** Pokémon a side brings (the format's: colosseum-1 is three a side). */
export const TEAM_SIZE = 3;

export interface Pip {
  /** The species, once that side has shown it; null for one not seen yet. */
  species: string | null;
  /** Its HP bar as last seen, a percentage (100 for one not seen yet). */
  hp: number;
  fainted: boolean;
  /** The one out now. */
  active: boolean;
}

/** One side's team as it stood after turn `upTo` (or now): pips in the order they were shown, then the unseen. */
export function teamsAt(s: LinkSpectator | null, upTo: number | null): [Pip[], Pip[]] {
  const team = (side: 0 | 1): Pip[] => {
    if (!s) return blanks(TEAM_SIZE);
    const order: string[] = [];
    const hp = new Map<string, number>();
    const note = (x: LinkSide | undefined) => {
      if (!x) return;
      if (!order.includes(x.species)) order.push(x.species);
      hp.set(x.species, x.hp_percent);
    };
    note(s.start?.[side]);
    let now: LinkSide | undefined = s.start?.[side];
    for (const t of s.turns) {
      if (upTo !== null && t.turn > upTo) break;
      if (t.after) {
        note(t.after[side]);
        now = t.after[side];
      }
    }
    // A battle saved before each turn's sides were kept: the current view's seen list, and its faint count spread over
    // what isn't out.
    if (!now || (upTo === null && !s.turns.at(-1)?.after)) {
      now = s.sides[side];
      for (const sp of now.seen) if (!order.includes(sp)) order.push(sp);
      hp.set(now.species, now.hp_percent);
      let faints = now.fainted;
      for (const sp of order) if (sp !== now.species && faints > 0 && !hp.has(sp)) (hp.set(sp, 0), faints--);
    }
    const pips: Pip[] = order.map((sp) => ({ species: sp, hp: hp.get(sp) ?? 100, fainted: (hp.get(sp) ?? 100) <= 0, active: sp === now?.species }));
    return [...pips, ...blanks(Math.max(0, TEAM_SIZE - pips.length))];
  };
  return [team(0), team(1)];
}

const blanks = (n: number): Pip[] => Array.from({ length: n }, () => ({ species: null, hp: 100, fainted: false, active: false }));

/** Pokémon each side has left: the score a spectator reads first. */
export const scoreOf = (teams: [Pip[], Pip[]]): [number, number] => [teams[0].filter((p) => !p.fainted).length, teams[1].filter((p) => !p.fainted).length];

/** Each side's whole team's HP (the average of its pips, unseen counted full), after each turn from the start: the momentum strip. */
export function momentum(s: LinkSpectator | null): { turn: number; hp: [number, number] }[] {
  if (!s || !s.turns.length || !s.turns.every((t) => t.after)) return [];
  const avg = (p: Pip[]) => Math.round(p.reduce((a, x) => a + (x.fainted ? 0 : x.hp), 0) / TEAM_SIZE);
  return [0, ...s.turns.map((t) => t.turn)].map((turn) => {
    const t = teamsAt(s, turn);
    return { turn, hp: [avg(t[0]), avg(t[1])] as [number, number] };
  });
}

// ---------------------------------------------------------------- a turn's lines

export type Chip = "crit" | "super" | "resisted" | "immune" | "missed";

export interface StoryLine {
  text: string;
  /** Whose doing it is (a move, a switch, a faint), or null for a line about neither in particular. */
  side: 0 | 1 | null;
  kind: "move" | "faint" | "switch" | "other";
  /** For a move: what it was, and what came of it. */
  move?: string;
  chips: Chip[];
}

const MODIFIERS: [RegExp, Chip][] = [
  [/^A critical hit!$/, "crit"],
  [/^It's super effective!$/, "super"],
  [/^It's not very effective/, "resisted"],
  [/^It doesn't affect /, "immune"],
];

/**
 * A turn's sentences as story lines: each move with what came of it folded in as chips (a critical hit, super effective,
 * a miss), and each line given to the side it's about. `labels` are each side's possessive as the narration writes it
 * ("Wire Cat's", "The house's").
 */
export function storyOf(lines: string[], labels: [string, string]): StoryLine[] {
  const out: StoryLine[] = [];
  // The longest label first, so one fighter's name that starts another's isn't mistaken for it.
  const order = ([0, 1] as const).slice().sort((a, b) => labels[b].length - labels[a].length);
  const sideOf = (text: string) => order.find((s) => text.startsWith(labels[s])) ?? null;
  for (const text of lines) {
    const mod = MODIFIERS.find(([re]) => re.test(text));
    const last = out.at(-1);
    if (mod && last?.kind === "move") {
      last.chips.push(mod[1]);
      continue;
    }
    const side = sideOf(text);
    if (/attack missed\.?$/.test(text) && last?.kind === "move" && last.side === side) {
      last.chips.push("missed");
      continue;
    }
    const used = / used (.+?)\.$/.exec(text);
    if (used && side !== null) {
      out.push({ text, side, kind: "move", move: used[1], chips: [] });
      continue;
    }
    if (/fainted!$/.test(text)) {
      out.push({ text, side, kind: "faint", chips: [] });
      continue;
    }
    if (/ sent out .+\.$/.test(text)) {
      out.push({ text, side, kind: "switch", chips: [] });
      continue;
    }
    out.push({ text, side, kind: "other", chips: mod ? [mod[1]] : [] });
  }
  return out;
}

/** What a turn did to each side, for the stage's moment: hit hard, critically, super effectively, or knocked out. */
export function turnMoment(lines: StoryLine[]): [{ crit: boolean; super: boolean; fainted: boolean }, { crit: boolean; super: boolean; fainted: boolean }] {
  const m = [0, 1].map(() => ({ crit: false, super: false, fainted: false })) as [ReturnType<typeof blank>, ReturnType<typeof blank>];
  for (const l of lines) {
    if (l.side === null) continue;
    const target = (1 - l.side) as 0 | 1;
    if (l.kind === "move" && !l.chips.includes("missed")) {
      if (l.chips.includes("crit")) m[target].crit = true;
      if (l.chips.includes("super")) m[target].super = true;
    }
    if (l.kind === "faint") m[l.side].fainted = true;
  }
  return m;
}
const blank = () => ({ crit: false, super: false, fainted: false });

/** A turn's headline, for a turn's share card: its biggest moment, said plainly. */
export function headline(lines: StoryLine[]): string {
  if (lines.some((l) => l.kind === "faint")) return "A knockout";
  if (lines.some((l) => l.chips.includes("crit"))) return "A critical hit";
  if (lines.some((l) => l.chips.includes("super"))) return "Super effective";
  if (lines.some((l) => l.kind === "switch")) return "A switch";
  return "A turn";
}

/** "Ch" for Charizard: the pip's mark (Highwire draws no game art of its own; the screens are the only place it appears). */
export const monogram = (species: string | null) => (species ? species.replace(/[^A-Za-z]/g, "").slice(0, 2) : "?");
