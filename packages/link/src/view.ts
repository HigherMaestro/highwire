import type { Action, Legal, Phase, SideChange, TurnEvent } from "./battle.ts";
import type { Field, Mon, PartyMon } from "./yellow.ts";

// What each side sees, and what spectators see (docs/link-battles.md 6.1, 13.2). Every view is built here, from facts
// read out of that side's own game and from the turn records, and a view never holds more than that side's screen
// shows: the other side's exact HP and PP, its unrevealed Pokémon and its pending decision never appear. Pure, so the
// tests can check exactly that without the game.

/** Names, from the cartridge (data.ts's GameData), or a fake in the tests. */
export interface Names {
  species(id: number): string;
  move(id: number): { name: string; pp: number } | null;
}

/** What one side's own game holds at a decision point (match.ts reads it). */
export interface SideFacts {
  team: PartyMon[];
  /** The party place of the Pokémon that's out. */
  out: number;
  /** Its own active Pokémon, from battle memory (current HP, stages, field). */
  mine: Mon;
  /** The other side's active Pokémon, as this game holds it: exact numbers this side must not be shown. */
  theirs: Mon;
  /** The active Pokémon's moves by slot, and their PP, from battle memory (a transformed Pokémon's are the copied ones). */
  mineMoves: number[];
  mineMovePP: number[];
}

/** One turn, as the match keeps it. */
export interface Turn {
  turn: number;
  decisions: [Action | null, Action | null];
  events: TurnEvent[];
  sides: [SideChange, SideChange];
}

export type ViewPhase = "choose" | "replace" | "waiting" | "ended";

const STAGES = ["Attack", "Defense", "Speed", "Special", "Accuracy", "Evasion"];

export function statusName(status: number, field?: Field): string | null {
  if (status & 0b111) return "asleep";
  if (status & (1 << 5)) return "frozen";
  if (status & (1 << 6)) return "paralyzed";
  if (status & (1 << 4)) return "burned";
  if (status & (1 << 3)) return field?.badlyPoisoned ? "badly poisoned" : "poisoned";
  return null;
}

/** HP as the game draws it for the other side: a bar of 48 pixels, given as a percentage. */
export function hpBar(hp: number, maxHp: number): number {
  if (hp <= 0 || maxHp <= 0) return 0;
  const px = Math.max(1, Math.floor((hp * 48) / maxHp));
  return Math.round((px * 100) / 48);
}

function fieldList(f: Field): string[] {
  const out: string[] = [];
  if (f.reflect) out.push("Reflect");
  if (f.lightScreen) out.push("Light Screen");
  if (f.substitute) out.push("a substitute");
  if (f.confused) out.push("confused");
  if (f.seeded) out.push("Leech Seed");
  if (f.badlyPoisoned) out.push("Toxic");
  if (f.mist) out.push("Mist");
  if (f.focusEnergy) out.push("Focus Energy");
  if (f.transformed) out.push("transformed");
  if (f.recharging) out.push("recharging");
  return out;
}

/** Announced stat stages, as "+1"-style changes from neutral, only the ones that moved. */
function stages(m: Mon): Record<string, number> {
  const out: Record<string, number> = {};
  m.stages.forEach((v, i) => {
    if (v !== 7) out[STAGES[i]!] = v - 7;
  });
  return out;
}

/** Which of a side's Pokémon have been seen, in order, and which have fainted: from the opening and the records. */
export function revealed(side: 0 | 1, opening: number, turns: Turn[]): { species: number[]; fainted: number[] } {
  const species = [opening], fainted: number[] = [];
  for (const t of turns) {
    const c = t.sides[side];
    if (!species.includes(c.species[1])) species.push(c.species[1]);
    if (c.fainted && !fainted.includes(c.species[1])) fainted.push(c.species[1]);
  }
  return { species, fainted };
}

/** The moves a side has been seen to use, by species. */
export function movesSeen(side: 0 | 1, turns: Turn[], names: Names): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of turns) {
    for (const e of t.events) {
      if (e.kind !== "used" || e.side !== side) continue;
      const who = names.species(t.sides[side].species[1]);
      const move = names.move(e.move)?.name ?? `move ${e.move}`;
      (out[who] ??= []).includes(move) || out[who]!.push(move);
    }
  }
  return out;
}

/**
 * One turn told in plain sentences (13.2), as either side or a spectator saw it: no damage numbers, which only the
 * finished replay shows. `label` names each side ("Your", "Their", or the fighters').
 */
export function narrate(t: Turn, names: Names, label: (side: 0 | 1) => string): string[] {
  const out: string[] = [];
  const name = (side: 0 | 1) => `${label(side)} ${names.species(t.sides[side].species[1])}`;
  for (const side of [0, 1] as const) {
    if (t.sides[side].switched) out.push(`${label(side)} side sent out ${names.species(t.sides[side].species[1])}.`);
  }
  t.events.forEach((e, i) => {
    if (e.kind === "acts") {
      // A side whose part of the turn started with no move used, without switching: what it was locked into says why.
      const next = t.events.slice(i + 1).find((x) => x.side === e.side && x.kind !== "resolved");
      const c = t.sides[e.side];
      if (!c.switched && (!next || next.kind !== "used")) out.push(`${name(e.side)} ${idle(c)}`);
    }
    if (e.kind === "used") out.push(`${name(e.side)} used ${names.move(e.move)?.name ?? "a move"}.`);
    if (e.kind === "resolved") {
      const target = (1 - e.side) as 0 | 1;
      if (e.missed) out.push(e.effectiveness === 0 ? `It doesn't affect ${name(target)}…` : `${name(e.side)}'s attack missed.`);
      else {
        if (e.critical) out.push("A critical hit!");
        if (e.effectiveness > 10) out.push("It's super effective!");
        else if (e.effectiveness > 0 && e.effectiveness < 10) out.push("It's not very effective…");
      }
    }
  });
  for (const side of [0, 1] as const) {
    const c = t.sides[side];
    if (c.switched) {
      if (c.fainted) out.push(`${name(side)} fainted!`);
      continue;
    }
    const [was, is] = c.status;
    const before = statusName(was), now = statusName(is);
    // Only a change of condition, not every tick of a sleep counter.
    if (now && now !== before) out.push(`${name(side)} is ${now}.`);
    if (!now && before && !c.fainted) out.push(`${name(side)} ${before === "asleep" ? "woke up" : before === "frozen" ? "thawed out" : `is no longer ${before}`}.`);
    for (const f of c.fieldOn) if (FIELD_ON[f]) out.push(`${name(side)} ${FIELD_ON[f]}`);
    for (const f of c.fieldOff) if (FIELD_OFF[f] && !c.fainted) out.push(`${name(side)} ${FIELD_OFF[f]}`);
    // Transform copies the target's stages: those aren't rises and falls.
    if (!c.fieldOn.includes("transformed")) {
      c.stages.forEach((d, i) => {
        if (d) out.push(`${name(side)}'s ${STAGES[i]} ${d > 0 ? "rose" : "fell"}${Math.abs(d) > 1 ? " sharply" : ""}.`);
      });
    }
    if (c.fainted) out.push(`${name(side)} fainted!`);
  }
  return out;
}

/** Why a side's part of the turn used no move, from what it was locked into or its condition when the turn began. */
function idle(c: SideChange): string {
  if (c.was.recharging) return "must recharge.";
  if (c.was.thrashing) return "is thrashing about.";
  if (c.was.trapping) return "keeps its hold on the other side.";
  if (c.was.rage) return "is in a rage.";
  if (!c.was.charging && c.fieldOn.includes("charging")) return "is charging up.";
  const status = statusName(c.status[0]);
  if (status === "asleep") return "is fast asleep.";
  if (status === "frozen") return "is frozen solid.";
  return "couldn't move.";
}

const FIELD_ON: Partial<Record<keyof Field, string>> = {
  confused: "became confused.",
  substitute: "made a substitute.",
  seeded: "was seeded.",
  reflect: "is protected by Reflect.",
  lightScreen: "is protected by Light Screen.",
  mist: "is shrouded in mist.",
  focusEnergy: "is getting pumped.",
  transformed: "transformed.",
};
const FIELD_OFF: Partial<Record<keyof Field, string>> = {
  confused: "snapped out of confusion.",
  substitute: "lost its substitute.",
  reflect: "is no longer protected by Reflect.",
  lightScreen: "is no longer protected by Light Screen.",
};

export interface PlayerView {
  phase: ViewPhase;
  turn: number;
  you: {
    team: { species: string; level: number; hp: number; max_hp: number; status: string | null; out: boolean; moves: { name: string; pp: number; max_pp: number }[] }[];
    field: string[];
    stages: Record<string, number>;
  };
  them: {
    species: string;
    level: number;
    hp_percent: number;
    status: string | null;
    field: string[];
    stages: Record<string, number>;
    seen: string[];
    fainted: number;
    moves_seen: Record<string, string[]>;
  };
  legal: { action: Action; label: string }[];
  last_turn: string[];
}

/** Turns a game's Phase into what the agent is asked. */
export function viewPhase(phase: Phase, ended: boolean): ViewPhase {
  if (ended) return "ended";
  if (phase === "menu") return "choose";
  if (phase === "forced") return "replace";
  return "waiting";
}

/** The actions, labelled with the game's names (move list from the side's own Pokémon, switches from its team). */
export function legalLabels(legal: Legal | null, facts: SideFacts, names: Names): { action: Action; label: string }[] {
  if (!legal) return [];
  const sw = legal.switches.map((to) => ({ action: { kind: "switch", to } as Action, label: `switch to ${names.species(facts.team[to]?.species ?? 0)}` }));
  if (legal.kind === "forced") return sw;
  const moves = legal.moves.map((slot) => ({ action: { kind: "move", slot } as Action, label: names.move(facts.mineMoves[slot] ?? 0)?.name ?? `move ${slot + 1}` }));
  return [...(legal.fight ? [{ action: { kind: "fight" } as Action, label: "fight (the game picks the move)" }] : []), ...moves, ...sw];
}

/** One side's view (6.1): its own team in full, the other side's active Pokémon as its screen shows it. */
export function playerView(o: {
  side: 0 | 1;
  phase: ViewPhase;
  turn: number;
  facts: SideFacts;
  legal: Legal | null;
  turns: Turn[];
  opening: [number, number];
  names: Names;
}): PlayerView {
  const { side, facts, names } = o;
  const other = (1 - side) as 0 | 1;
  const seen = revealed(other, o.opening[other], o.turns);
  const last = o.turns[o.turns.length - 1];
  return {
    phase: o.phase,
    turn: o.turn,
    you: {
      team: facts.team.map((m, i) => {
        const active = i === facts.out;
        return {
          species: names.species(m.species),
          level: m.level,
          hp: active ? facts.mine.hp : m.hp,
          max_hp: m.maxHp,
          status: statusName(active ? facts.mine.status : m.status, active ? facts.mine.field : undefined),
          out: active,
          // The one out: its moves and PP in battle (a transformed Pokémon's are the copied ones, 5 PP each).
          moves: (active ? facts.mineMoves : m.moves).flatMap((id, slot) => {
            const move = names.move(id);
            const pp = (active ? facts.mineMovePP : m.pp)[slot] ?? 0;
            return id && move ? [{ name: move.name, pp, max_pp: active && facts.mine.field.transformed ? 5 : move.pp }] : [];
          }),
        };
      }),
      field: fieldList(facts.mine.field),
      stages: stages(facts.mine),
    },
    them: {
      species: names.species(facts.theirs.species),
      level: facts.theirs.level,
      hp_percent: hpBar(facts.theirs.hp, facts.theirs.maxHp),
      status: statusName(facts.theirs.status, facts.theirs.field),
      field: fieldList(facts.theirs.field),
      stages: stages(facts.theirs),
      seen: seen.species.map((s) => names.species(s)),
      fainted: seen.fainted.length,
      moves_seen: movesSeen(other, o.turns, names),
    },
    legal: o.phase === "choose" || o.phase === "replace" ? legalLabels(o.legal, facts, names) : [],
    last_turn: last ? narrate(last, names, (s) => (s === side ? "Your" : "Their")) : [],
  };
}

export interface SpectatorSide {
  species: string;
  level: number;
  hp_percent: number;
  status: string | null;
  field: string[];
  seen: string[];
  fainted: number;
  /** Exact numbers, only once the battle is over (13.3). */
  hp?: number;
  max_hp?: number;
}

export interface SpectatorView {
  live: boolean;
  turn: number;
  sides: [SpectatorSide, SpectatorSide];
  /** Every turn, told in plain sentences. */
  turns: { turn: number; lines: string[] }[];
}

/**
 * The spectators' view (13.2): only what both sides can see. Built from game 0's facts, whose view of side 1 is the
 * enemy as both games agree it. While a match is live it never says who has chosen; once it's over, exact numbers too.
 */
export function spectatorView(o: { live: boolean; turn: number; facts0: SideFacts; turns: Turn[]; opening: [number, number]; names: Names; labels: [string, string] }): SpectatorView {
  const { facts0, names } = o;
  const side = (s: 0 | 1, m: Mon): SpectatorSide => {
    const seen = revealed(s, o.opening[s], o.turns);
    return {
      species: names.species(m.species),
      level: m.level,
      hp_percent: hpBar(m.hp, m.maxHp),
      status: statusName(m.status, m.field),
      field: fieldList(m.field),
      seen: seen.species.map((x) => names.species(x)),
      fainted: seen.fainted.length,
      ...(o.live ? {} : { hp: m.hp, max_hp: m.maxHp }),
    };
  };
  return {
    live: o.live,
    turn: o.turn,
    sides: [side(0, facts0.mine), side(1, facts0.theirs)],
    turns: o.turns.map((t) => ({ turn: t.turn, lines: narrate(t, names, (s) => o.labels[s]) })),
  };
}

