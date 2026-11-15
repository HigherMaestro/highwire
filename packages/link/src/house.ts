import type { Action, Legal } from "./battle.ts";
import type { GameData } from "./data.ts";
import type { SideFacts } from "./view.ts";

// The house (docs/link-battles.md 9): Highwire's own fighter, for practice and for anyone left unpaired. A floor, not a
// solution: it picks the legal move with the best expected damage (power, the same-type bonus, the type chart and
// accuracy, all read from the game) and switches when its Pokémon is badly matched and a reserve isn't. It decides from
// its own side's facts only, the ones its own view is built from, when the turn opens.

/** A move's expected damage factor against a Pokémon of `defend` types, from a user of `own` types. */
export function expected(data: GameData, move: number, own: [number, number], defend: [number, number]): number {
  const m = data.move(move);
  if (!m || m.power <= 1) return 0;
  const stab = own.includes(m.type) ? 1.5 : 1;
  const chart = data.effectiveness(m.type, defend[0]) * (defend[1] !== defend[0] ? data.effectiveness(m.type, defend[1]) : 1);
  return m.power * stab * chart * (m.accuracy / 100);
}

/** The best a team member could do against the other side's active Pokémon. */
function bestOf(data: GameData, moves: number[], pp: number[], own: [number, number], defend: [number, number]): number {
  return Math.max(0, ...moves.map((id, slot) => (id && (pp[slot] ?? 0) > 0 ? expected(data, id, own, defend) : 0)));
}

export function houseChoice(legal: Legal, facts: SideFacts, data: GameData): Action {
  const defend = facts.theirs.types;
  const reserve = (to: number) => {
    const m = facts.team[to]!;
    return bestOf(data, m.moves, m.pp, m.types, defend);
  };
  const bestSwitch = () => [...legal.switches].sort((a, b) => reserve(b) - reserve(a))[0];
  if (legal.kind === "forced") return { kind: "switch", to: bestSwitch()! };
  if (legal.fight && legal.switches.length === 0) return { kind: "fight" };
  const own = facts.mine.types;
  const scored = legal.moves.map((slot) => ({ slot, value: expected(data, facts.mineMoves[slot] ?? 0, own, defend) })).sort((a, b) => b.value - a.value);
  const best = scored[0];
  const to = bestSwitch();
  const active = best?.value ?? 0;
  // Badly matched: its best does under 40 and a reserve would more than double it.
  if (to !== undefined && active < 40 && reserve(to) > 2 * Math.max(active, 20)) return { kind: "switch", to };
  if (legal.fight) return { kind: "fight" };
  return best ? { kind: "move", slot: best.slot } : { kind: "switch", to: to! };
}
