"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// The stage's sound (docs/link-battles.md 14.12): off until someone turns it on, then a few short synthesized tones of
// Highwire's own for what the director plays (a hit, a critical hit, a miss, a switch, a knockout, the end). Nothing is
// loaded and nothing is the game's: each is an oscillator or a burst of noise through the Web Audio API, made on the
// spot. The choice is kept in this browser. A hidden tab stays quiet.

export type Cue = "hit" | "crit" | "soft" | "miss" | "switch" | "ko" | "win" | "turn";

const KEY = "link-sound";
const LEVEL = 0.07;

type Note = { f: number; to?: number; at: number; ms: number; type?: OscillatorType; gain?: number };

const CUES: Record<Cue, { notes: Note[]; noise?: { at: number; ms: number; gain: number } }> = {
  turn: { notes: [{ f: 660, at: 0, ms: 60, type: "sine", gain: 0.5 }] },
  hit: { notes: [{ f: 220, to: 110, at: 0, ms: 90, type: "square" }], noise: { at: 0, ms: 70, gain: 0.5 } },
  crit: { notes: [{ f: 330, to: 110, at: 0, ms: 120, type: "square" }, { f: 880, to: 440, at: 0, ms: 140, type: "triangle", gain: 0.8 }], noise: { at: 0, ms: 120, gain: 0.9 } },
  soft: { notes: [{ f: 180, to: 120, at: 0, ms: 70, type: "triangle", gain: 0.6 }] },
  miss: { notes: [{ f: 320, to: 640, at: 0, ms: 140, type: "sine", gain: 0.5 }] },
  switch: { notes: [{ f: 440, at: 0, ms: 70, type: "triangle" }, { f: 660, at: 80, ms: 90, type: "triangle" }] },
  ko: { notes: [{ f: 392, at: 0, ms: 130, type: "square" }, { f: 294, at: 140, ms: 130, type: "square" }, { f: 196, to: 98, at: 280, ms: 320, type: "square" }], noise: { at: 0, ms: 160, gain: 0.8 } },
  win: { notes: [{ f: 523, at: 0, ms: 110, type: "triangle" }, { f: 659, at: 120, ms: 110, type: "triangle" }, { f: 784, at: 240, ms: 110, type: "triangle" }, { f: 1047, at: 360, ms: 360, type: "triangle" }] },
};

export function useSound(): { on: boolean; toggle: () => void; play: (cue: Cue) => void } {
  const [on, setOn] = useState(false);
  const ctx = useRef<AudioContext | null>(null);
  const onRef = useRef(false);
  onRef.current = on;

  // The saved choice only shows the button as on; the browser allows sound once someone has clicked, so the first cue
  // after a reload plays from the first click or key on the page.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(KEY) === "1") setOn(true);
    } catch {
      // No storage: off until asked.
    }
  }, []);

  useEffect(() => () => void ctx.current?.close().catch(() => undefined), []);

  const play = useCallback((cue: Cue) => {
    if (!onRef.current || document.hidden) return;
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const c = (ctx.current ??= new Ctor());
      if (c.state === "suspended") void c.resume().catch(() => undefined);
      if (c.state !== "running") return;
      const t0 = c.currentTime + 0.01;
      const spec = CUES[cue];
      for (const n of spec.notes) {
        const osc = c.createOscillator();
        const g = c.createGain();
        const start = t0 + n.at / 1000, end = start + n.ms / 1000;
        osc.type = n.type ?? "square";
        osc.frequency.setValueAtTime(n.f, start);
        if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, end);
        const peak = LEVEL * (n.gain ?? 1);
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(peak, start + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, end);
        osc.connect(g).connect(c.destination);
        osc.start(start);
        osc.stop(end + 0.02);
      }
      if (spec.noise) {
        const len = Math.ceil((c.sampleRate * spec.noise.ms) / 1000);
        const buf = c.createBuffer(1, len, c.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
        const src = c.createBufferSource();
        const g = c.createGain();
        src.buffer = buf;
        g.gain.value = LEVEL * spec.noise.gain;
        src.connect(g).connect(c.destination);
        src.start(t0 + spec.noise.at / 1000);
      }
    } catch {
      // No sound here: the stage plays on without it.
    }
  }, []);

  const toggle = useCallback(() => {
    const next = !onRef.current;
    onRef.current = next;
    setOn(next);
    try {
      window.localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      // As above.
    }
    // Turning it on is the click that lets the browser play: a short tone says it worked.
    if (next) play("turn");
  }, [play]);

  return { on, toggle, play };
}
