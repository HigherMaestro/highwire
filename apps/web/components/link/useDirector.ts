"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LinkSide, LinkSpectator } from "../../lib/link/battle.ts";
import { beatMs, beatsOf, stepsOf, storyOf, teamsAt, type Beat, type Step } from "../../lib/link/story.ts";

// The stage's director (docs/link-battles.md 14.11): when the battle moves on by one turn, it plays that turn's beats one
// after another, in the game's order (each move's hit, a switch, a knockout), holding the bars where they were until
// each beat's impact. Everything it shows comes from the spectators' view; it only decides when. A jump of more than one
// turn, the screens already playing the turn ("echo"), or reduced motion: the turn lands at once.

/** How long into a move's beat it lands: the windup (the callout, the pulse along the cable) before the impact. */
export const IMPACT_MS = 400;
/** The pause after a turn's last beat, before the feed and the chart take it in. */
const SETTLE_MS = 400;

export interface Direction {
  /** The sides to draw: the battle's own, or mid-turn while a turn plays. */
  display: [LinkSide, LinkSide] | null;
  /** The beat playing, its step and its phase, keyed so each one's animations start afresh. */
  now: { turn: number; index: number; step: Step; phase: "windup" | "impact"; key: string } | null;
  /** A turn is playing or settling: the feed and the chart wait for it. */
  busy: boolean;
  /** A turn's beats are playing (not yet settling): the score waits for its knockouts to land. */
  playing: boolean;
  /** The beats that have landed so far in the turn playing (a knockout moves the score when it lands). */
  landed: Beat[];
}

export function useReducedMotion(): boolean {
  const [still, setStill] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    setStill(q.matches);
    const on = () => setStill(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return still;
}

type Play = { turn: number; steps: Step[]; index: number; phase: "windup" | "impact" };

/** A turn's steps, if it can be played: its sides before and after are known and it has something to play. */
function plan(s: LinkSpectator | null, turn: number, labels: [string, string]): { steps: Step[]; before: [LinkSide, LinkSide] } | null {
  if (!s || turn < 1) return null;
  const t = s.turns.find((x) => x.turn === turn);
  const before = turn === 1 ? s.start : s.turns.find((x) => x.turn === turn - 1)?.after;
  if (!t?.after || !before) return null;
  const steps = stepsOf(before, t.after, beatsOf(storyOf(t.lines, labels), labels), teamsAt(s, turn - 1));
  return steps.length ? { steps, before } : null;
}

export function useDirector({ s, upTo, sides, labels, echo, still }: { s: LinkSpectator | null; upTo: number; sides: [LinkSide, LinkSide] | null; labels: [string, string]; echo: boolean; still: boolean }): Direction {
  const [play, setPlay] = useState<Play | null>(null);
  const [settling, setSettling] = useState(false);
  const prev = useRef(upTo);
  // The turn the battle just moved on to, worked out while rendering, so the frame before its first beat never shows its end.
  const next = useMemo(() => (upTo === prev.current + 1 && !still && !echo ? plan(s, upTo, labels) : null), [upTo, s, labels, still, echo]);

  useEffect(() => {
    const from = prev.current;
    // A poll with nothing new (the same turn) leaves a turn that's playing alone.
    if (upTo === from) return;
    prev.current = upTo;
    if (!next || upTo !== from + 1) return setPlay(null);
    setPlay({ turn: upTo, steps: next.steps, index: 0, phase: next.steps[0]!.beat.kind === "move" ? "windup" : "impact" });
  }, [upTo, next]);

  // One beat after another: the windup, the impact, the rest of the beat, then the next; a pause; then it's settled.
  useEffect(() => {
    if (!play) return;
    const step = play.steps[play.index]!;
    if (play.phase === "windup") {
      const t = setTimeout(() => setPlay({ ...play, phase: "impact" }), IMPACT_MS);
      return () => clearTimeout(t);
    }
    const rest = beatMs(step.beat) - (step.beat.kind === "move" ? IMPACT_MS : 0);
    const t = setTimeout(() => {
      const next = play.index + 1;
      if (next < play.steps.length) setPlay({ ...play, index: next, phase: play.steps[next]!.beat.kind === "move" ? "windup" : "impact" });
      else {
        setPlay(null);
        setSettling(true);
      }
    }, rest);
    return () => clearTimeout(t);
  }, [play]);

  useEffect(() => {
    if (!settling) return;
    const t = setTimeout(() => setSettling(false), SETTLE_MS);
    return () => clearTimeout(t);
  }, [settling]);

  if (!play && next && upTo === prev.current + 1) return { display: next.before, now: null, busy: true, playing: true, landed: [] };
  if (!play) return { display: sides, now: null, busy: settling, playing: false, landed: [] };
  const step = play.steps[play.index]!;
  const before = play.index === 0 ? (play.turn === 1 ? s?.start : s?.turns.find((x) => x.turn === play.turn - 1)?.after) : play.steps[play.index - 1]!.sides;
  const display = play.phase === "impact" ? step.sides : (before ?? step.sides);
  const landed = play.steps.slice(0, play.phase === "impact" ? play.index + 1 : play.index).map((x) => x.beat);
  return { display, now: { turn: play.turn, index: play.index, step, phase: play.phase, key: `${play.turn}-${play.index}` }, busy: true, playing: true, landed };
}
