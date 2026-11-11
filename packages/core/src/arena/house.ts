import { sha256 } from "@noble/hashes/sha2";
import { nodeFor, other, playRound, startMatch, type MatchState, type Side } from "./rules.ts";
import { solve } from "./solve.ts";

// The house's two fighters (docs/arena.md 7). Both are open source and play only from the public state and a secret
// per-match seed: the referee publishes the seed's hash when a match starts and the seed when it ends, so anyone can
// replay a house match and check the house never saw a pending move.
//
// Even plays one match's equilibrium: in a match it can't be beaten on average, and only breaks even against weak
// play (over a wager series it can be beaten: series-solve.ts). Reader models the opponent's pulls in this match and
// leans toward the best answer to them, half the time, so knowing its code still doesn't beat it.

export type HouseBot = "even" | "reader";

/** A number in [0, 1) from the match's seed and the round: the same every time, unknowable without the seed. */
export function seededUnit(seed: string, round: number, salt = ""): number {
  const h = sha256(new TextEncoder().encode(`highwire-arena|${seed}|${round}|${salt}`));
  return (((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0) / 2 ** 32;
}

/** The commitment published when a match starts. */
export function seedCommitment(seed: string): string {
  return Array.from(sha256(new TextEncoder().encode(seed)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A pull drawn from a mix over 0..n with a uniform number. */
function draw(mix: ArrayLike<number>, u: number): number {
  let total = 0;
  for (let i = 0; i < mix.length; i++) total += mix[i]!;
  let acc = 0;
  for (let i = 0; i < mix.length; i++) {
    acc += mix[i]! / total;
    if (u < acc) return i;
  }
  return mix.length - 1;
}

/** Each past round's state before it was played, rebuilt from the pulls. */
function history(state: MatchState): MatchState[] {
  const out: MatchState[] = [];
  let s = startMatch(state.rules);
  for (const r of state.rounds) {
    out.push(s);
    s = playRound(s, r.pull.a, r.pull.b);
  }
  return out;
}

/**
 * What the opponent's past pulls say it will pull now, one guess per past round, under whichever of three readings
 * would have predicted its pulls best so far: a fixed amount, a fixed share of its energy, or an answer to our last
 * pull (ours plus its usual margin). Each guess is capped by the energy it has now.
 */
export function readOpponent(state: MatchState, side: Side, oppEnergy: number): number[] {
  const them = other(side);
  const past = history(state);
  const n = state.rounds.length;
  if (!n) return [];
  const theirs = state.rounds.map((x) => x.pull[them]);
  const mine = state.rounds.map((x) => x.pull[side]);
  const energy = past.map((p) => p.energy[them]);
  const cap = (j: number) => Math.max(0, Math.min(oppEnergy, Math.round(j)));
  const readings: { guess: (k: number, energyNow: number, myLast: number) => number }[] = [
    { guess: (k) => theirs[k]! },
    { guess: (k, e) => (energy[k]! > 0 ? (theirs[k]! / energy[k]!) * e : 0) },
    { guess: (k, _e, myLast) => (k > 0 ? myLast + theirs[k]! - mine[k - 1]! : Number.NaN) },
  ];
  // Score each reading by its one-round-ahead error over the rounds after the first.
  let best = 0, bestError = Infinity;
  readings.forEach((reading, i) => {
    let error = 0, counted = 0;
    for (let k = 1; k < n; k++) {
      const g = reading.guess(k - 1, energy[k]!, mine[k - 1]!);
      if (Number.isNaN(g)) continue;
      error += Math.abs(Math.max(0, Math.min(energy[k]!, Math.round(g))) - theirs[k]!);
      counted++;
    }
    const mean = counted ? error / counted : Infinity;
    if (mean < bestError - 1e-9) (bestError = mean), (best = i);
  });
  if (bestError === Infinity) best = 0;
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const g = readings[best]!.guess(k, oppEnergy, mine[n - 1]!);
    if (!Number.isNaN(g)) out.push(cap(g));
  }
  return out;
}

/** The house's pull for `side` in this state. Deterministic in (state, seed). */
export function houseMove(bot: HouseBot, state: MatchState, side: Side, seed: string): number {
  if (state.ending) throw new Error("the match is over");
  const sol = solve(state.rules);
  const r = state.rounds.length, pos = nodeFor(state, side), me = state.energy[side], opp = state.energy[other(side)];
  const eq = sol.mix(r, pos, me, opp);
  const u = seededUnit(seed, r, side);
  if (bot === "even") return draw(eq, u);

  // Reader: a model of the opponent from this match's rounds, blended with what the equilibrium expects of it.
  const predicted = Array.from(sol.mix(r, -pos, opp, me), (p) => p);
  const seen = readOpponent(state, side, opp);
  if (seen.length) {
    const w = seen.length / (seen.length + 4);
    for (let j = 0; j < predicted.length; j++) predicted[j]! *= 1 - w;
    for (const j of seen) predicted[j]! += w / seen.length;
  }
  // The best answer to that prediction, one round ahead, playing on optimally after.
  let bestPull = 0, bestValue = -Infinity;
  for (let i = 0; i <= me; i++) {
    let v = 0;
    for (let j = 0; j <= opp; j++) if (predicted[j]! > 0) v += predicted[j]! * sol.after(r, pos, me, opp, i, j);
    if (v > bestValue + 1e-9) (bestValue = v), (bestPull = i);
  }
  const mix = Array.from(eq, (p) => p / 2);
  mix[bestPull]! += 0.5;
  return draw(mix, u);
}
