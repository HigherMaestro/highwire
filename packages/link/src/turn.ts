import { dealDice, snapshot, type Snapshot } from "./yellow.ts";
import type { Rig, Side } from "./rig.ts";

// Phase 0's turn (docs/link-battles.md 14): both sides choose FIGHT and the first move, and the pair runs until both
// games are back at the battle menu they started from, or the battle ends. Its "back at the menu" test is phase 0's
// stand-in for the real decision-point detector (phase 1). The phase 0 script and the site's preview-only timing route
// both run it, so the numbers they report are for the same work.

/** The battle menu's cursor geometry as a game shows it when the turn starts: the decision point's sign, for now. */
type MenuSign = { top: [number, number]; max: number };

const signOf = (s: Snapshot): MenuSign => ({ top: s.menu.top, max: s.menu.max });

function atMenu(rig: Rig, side: Side, sign: MenuSign): boolean {
  const s = snapshot(rig, side);
  return s.menu.top[0] === sign.top[0] && s.menu.top[1] === sign.top[1] && s.menu.max === sign.max;
}

export type TestTurn = {
  start: readonly [Snapshot, Snapshot];
  end: readonly [Snapshot, Snapshot];
  frames: number;
  ms: number;
  /** The frame budget ran out before both games were back at the menu. */
  stuck: boolean;
};

export type TestTurnOptions = {
  /** Ten fresh bytes dealt into both games first; none leaves the dice as the state has them. */
  dice?: Uint8Array;
  /** Press B on both sides every this many frames, to page through the battle's text (default 15). */
  bEvery?: number;
  /** Frames to give up after (default 6,000). */
  budget?: number;
};

/** Plays one turn from a paired battle menu: FIGHT, then the first move, on both sides. */
export function playTestTurn(rig: Rig, options: TestTurnOptions = {}): TestTurn {
  const start = [snapshot(rig, 0), snapshot(rig, 1)] as const;
  const signs = [signOf(start[0]), signOf(start[1])] as const;
  const bEvery = options.bEvery ?? 15;
  if (options.dice) dealDice(rig, options.dice);
  const t0 = performance.now();
  const f0 = rig.frameCount;
  // FIGHT is the main menu's first item; the move list opens on the first move.
  for (const side of [0, 1] as const) rig.press(side, "A");
  rig.run(20);
  for (const side of [0, 1] as const) rig.press(side, "A");
  let left = false;
  const ran = rig.runUntil(() => {
    if (rig.frameCount % bEvery === 0) for (const side of [0, 1] as const) rig.press(side, "B", 2, 2);
    const here = [atMenu(rig, 0, signs[0]), atMenu(rig, 1, signs[1])];
    if (!here[0] && !here[1]) left = true;
    const ended = snapshot(rig, 0).isInBattle === 0 || snapshot(rig, 1).isInBattle === 0;
    return (left && here[0] && here[1]) || ended;
  }, options.budget ?? 6000);
  const ms = performance.now() - t0;
  return { start, end: [snapshot(rig, 0), snapshot(rig, 1)], frames: rig.frameCount - f0, ms, stuck: ran === null };
}
