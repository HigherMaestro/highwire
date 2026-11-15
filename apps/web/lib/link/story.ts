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

// ---------------------------------------------------------------- a turn as beats, for the stage to play

/** One thing that happened in a turn, in the game's order: what the stage plays one after another. */
export type Beat =
  | { kind: "move"; side: 0 | 1; species: string | null; move: string; chips: Chip[]; text: string }
  | { kind: "switch"; side: 0 | 1; species: string; text: string }
  | { kind: "faint"; side: 0 | 1; species: string; text: string }
  | { kind: "other"; side: 0 | 1 | null; text: string };

/** "Wire Cat's Charizard used Flamethrower." without the fighter's label: "Charizard used Flamethrower." */
const unlabel = (text: string, labels: [string, string], side: 0 | 1 | null) => (side !== null && text.startsWith(labels[side]) ? text.slice(labels[side].length).trim() : text);

/** A turn's story lines as beats: each move with its species and what came of it, each switch and faint with its species. */
export function beatsOf(lines: StoryLine[], labels: [string, string]): Beat[] {
  return lines.map((l): Beat => {
    const bare = unlabel(l.text, labels, l.side);
    if (l.kind === "move" && l.side !== null) {
      const m = /^(.+?) used (.+?)\.$/.exec(bare);
      return { kind: "move", side: l.side, species: m ? m[1]! : null, move: l.move ?? m?.[2] ?? "", chips: l.chips, text: l.text };
    }
    if (l.kind === "switch" && l.side !== null) {
      const m = / sent out (.+)\.$/.exec(l.text);
      if (m) return { kind: "switch", side: l.side, species: m[1]!, text: l.text };
    }
    if (l.kind === "faint" && l.side !== null) {
      const m = /^(.+) fainted!$/.exec(bare);
      if (m) return { kind: "faint", side: l.side, species: m[1]!, text: l.text };
    }
    return { kind: "other", side: l.side, text: l.text };
  });
}

/** What a beat did to the bars, for the stage: the sides as they stand once it has landed, and the hit it made. */
export interface Step {
  beat: Beat;
  sides: [LinkSide, LinkSide];
  /** The HP a move took, in points of the bar, from the side it hit: the turn's whole loss for that side, put on the last move that landed on it. */
  hit: { side: 0 | 1; amount: number } | null;
}

const lands = (b: Beat) => b.kind === "move" && !b.chips.includes("missed") && !b.chips.includes("immune");

/**
 * A turn played as steps, from the sides before it to the sides after it. Only each turn's sides are known, never each
 * move's damage, so a side's whole loss in the turn lands with the last move that hit it; a switch brings in its Pokémon
 * at the HP it was last seen with; a faint empties the bar. The last step's sides are always the turn's own.
 */
export function stepsOf(before: [LinkSide, LinkSide], after: [LinkSide, LinkSide], beats: Beat[], lastSeen: [Pip[], Pip[]]): Step[] {
  const cur: [LinkSide, LinkSide] = [{ ...before[0] }, { ...before[1] }];
  // The last move that landed on each side this turn.
  const lastHit: [number, number] = [-1, -1];
  beats.forEach((b, i) => {
    if (b.kind === "move" && lands(b)) lastHit[(1 - b.side) as 0 | 1] = i;
  });
  const steps: Step[] = beats.map((b, i) => {
    let hit: Step["hit"] = null;
    if (b.kind === "switch") {
      const seen = lastSeen[b.side].find((p) => p.species === b.species);
      const base = after[b.side].species === b.species ? after[b.side] : cur[b.side];
      const pct = seen ? seen.hp : 100;
      cur[b.side] = { ...base, species: b.species, hp_percent: pct, status: null, field: [] };
      if (base.max_hp !== undefined) cur[b.side].hp = Math.round((base.max_hp * pct) / 100);
    } else if (b.kind === "move") {
      const target = (1 - b.side) as 0 | 1;
      if (lastHit[target] === i && cur[target].species === after[target].species) {
        const was = cur[target].hp_percent;
        cur[target] = after[target].hp_percent < was ? { ...cur[target], hp_percent: after[target].hp_percent, ...(after[target].hp !== undefined ? { hp: after[target].hp } : {}) } : cur[target];
        if (was > cur[target].hp_percent) hit = { side: target, amount: was - cur[target].hp_percent };
      }
    } else if (b.kind === "faint") {
      const was = cur[b.side].hp_percent;
      cur[b.side] = { ...cur[b.side], hp_percent: 0, ...(cur[b.side].hp !== undefined ? { hp: 0 } : {}) };
      // A faint with no hit before it (poison, recoil, a move that hit for it all): the loss lands here.
      if (was > 0 && !steps.some((s) => s.hit?.side === b.side)) hit = { side: b.side, amount: was };
    }
    return { beat: b, sides: [{ ...cur[0] }, { ...cur[1] }], hit };
  });
  if (steps.length) steps[steps.length - 1]!.sides = [after[0], after[1]];
  return steps;
}

/** How long the stage gives a beat, in milliseconds: a move's hit, a switch, a knockout. */
export function beatMs(b: Beat): number {
  if (b.kind === "move") return b.chips.includes("missed") ? 900 : 1100;
  if (b.kind === "switch") return 800;
  if (b.kind === "faint") return 1600;
  return 700;
}

/** The lead, turn by turn: the left side's whole-team HP minus the right side's (positive: the left is ahead). */
export const leadSeries = (points: { turn: number; hp: [number, number] }[], left: 0 | 1) => points.map((p) => ({ turn: p.turn, lead: p.hp[left] - p.hp[(1 - left) as 0 | 1] }));

export interface Highlight {
  turn: number;
  kind: "ko" | "double" | "lead";
  /** The side it was good for: the one that scored the knockout, landed the hit or took the lead. */
  side: 0 | 1;
  text: string;
}

/** The turns worth a tile: knockouts, a critical hit that was super effective too, and a change of lead. */
export function highlights(s: LinkSpectator | null, labels: [string, string], left: 0 | 1): Highlight[] {
  if (!s) return [];
  const out: Highlight[] = [];
  for (const t of s.turns) {
    for (const b of beatsOf(storyOf(t.lines, labels), labels)) {
      if (b.kind === "faint") out.push({ turn: t.turn, kind: "ko", side: (1 - b.side) as 0 | 1, text: `${b.species} knocked out` });
      if (b.kind === "move" && b.chips.includes("crit") && b.chips.includes("super")) out.push({ turn: t.turn, kind: "double", side: b.side, text: `${b.move}: critical and super effective` });
    }
  }
  const lead = leadSeries(momentum(s), left);
  for (let i = 1; i < lead.length; i++) {
    const a = Math.sign(lead[i - 1]!.lead), b = Math.sign(lead[i]!.lead);
    if (a && b && a !== b) out.push({ turn: lead[i]!.turn, kind: "lead", side: b > 0 ? left : ((1 - left) as 0 | 1), text: "Takes the lead" });
  }
  return out.sort((x, y) => x.turn - y.turn);
}

/** The deepest the eventual winner trailed by, in points of team HP (0 if it never did): a comeback worth saying. */
export function deepestDeficit(s: LinkSpectator | null, winner: 0 | 1): number {
  const lead = leadSeries(momentum(s), winner);
  return Math.max(0, ...lead.map((p) => -p.lead));
}
