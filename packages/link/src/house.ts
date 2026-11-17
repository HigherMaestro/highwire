import type { Action, Legal } from "./battle.ts";
import type { GameData } from "./data.ts";
import type { SideFacts } from "./view.ts";

// The house (docs/link-battles.md 9): Highwire's own fighter, for practice and for anyone left unpaired. A floor, not a
// solution: it picks the legal move with the best expected value (power, the same-type bonus, the type chart and
// accuracy, read from the game, with a few effects valued by what they do) and switches when its Pokémon is badly
// matched and a reserve isn't. It decides from its own side's facts and the other side's species, whose types any
// player knows.

/** Move effects (the game's effect numbers) the house values by what they do rather than by power. */
const EFFECT = { explode: 0x07, dreamEater: 0x08, sleep: 0x20, ohko: 0x26, charge: 0x27, fixed: 0x29, fly: 0x2b, leechSeed: 0x54, hyperBeam: 0x50, rage: 0x51 } as const;
const GRASS = 0x16;
const SLEEP = 0b111;

/** What the house expects from one move against a Pokémon of `defend` types (and status, for sleep and Dream Eater). */
export function expected(data: GameData, move: number, own: [number, number], defend: [number, number], o: { level?: number; targetStatus?: number; targetSeeded?: boolean } = {}): number {
  const m = data.move(move);
  if (!m) return 0;
  const chart = data.effectiveness(m.type, defend[0]) * (defend[1] !== defend[0] ? data.effectiveness(m.type, defend[1]) : 1);
  const hit = m.accuracy / 100;
  switch (m.effect) {
    case EFFECT.fixed:
      // Seismic Toss and Night Shade do the user's level in damage (Psywave is banned); immunities still apply.
      return chart === 0 ? 0 : (o.level ?? 50) * hit;
    case EFFECT.sleep:
      return (o.targetStatus ?? 0) === 0 ? 70 * hit : 0;
    case EFFECT.leechSeed:
      return o.targetSeeded || defend.includes(GRASS) ? 0 : 35 * hit;
    case EFFECT.dreamEater:
      if (((o.targetStatus ?? 0) & SLEEP) === 0) return 0;
      break;
    case EFFECT.ohko:
    case EFFECT.rage:
    case EFFECT.explode:
      return 0;
  }
  if (m.power <= 1) return 0;
  const stab = own.includes(m.type) ? 1.5 : 1;
  const lag = m.effect === EFFECT.charge || m.effect === EFFECT.fly ? 0.5 : m.effect === EFFECT.hyperBeam ? 0.6 : 1;
  return m.power * stab * chart * hit * lag;
}

export function houseChoice(legal: Legal, facts: SideFacts, data: GameData): Action {
  const defend = facts.theirs.types;
  const target = { level: facts.mine.level, targetStatus: facts.theirs.status, targetSeeded: facts.theirs.field.seeded };
  const best = (moves: number[], pp: number[], own: [number, number], level: number) =>
    Math.max(0, ...moves.map((id, slot) => (id && (pp[slot] ?? 0) > 0 ? expected(data, id, own, defend, { ...target, level }) : 0)));
  // A reserve worth sending: standing, and not asleep or frozen (two sleepers swapped turn after turn never wake).
  const fit = legal.switches.filter((to) => (facts.team[to]!.status & (SLEEP | (1 << 5))) === 0);
  const reserve = (to: number) => {
    const m = facts.team[to]!;
    return best(m.moves, m.pp, m.types, m.level);
  };
  const bestSwitch = (from: number[]) => [...from].sort((a, b) => reserve(b) - reserve(a))[0];
  if (legal.kind === "forced") return { kind: "switch", to: bestSwitch(fit.length ? fit : legal.switches)! };
  const own = facts.mine.types;
  // How good the Pokémon out is, by its own moves, even on a turn FIGHT goes straight on (trapped, asleep, locked in).
  const activeBest = best(facts.mineMoves, facts.mineMovePP, own, facts.mine.level);
  const to = bestSwitch(fit);
  // Badly matched: its best is under 40 and a reserve would more than double it.
  if (to !== undefined && activeBest < 40 && reserve(to) > 2 * Math.max(activeBest, 20)) return { kind: "switch", to };
  if (legal.fight) return { kind: "fight" };
  const scored = legal.moves.map((slot) => ({ slot, value: expected(data, facts.mineMoves[slot] ?? 0, own, defend, target) })).sort((a, b) => b.value - a.value);
  if (scored[0]) return { kind: "move", slot: scored[0].slot };
  return { kind: "switch", to: (to ?? legal.switches[0])! };
}
