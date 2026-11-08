"use client";

import { useEffect, useRef, useState } from "react";
import type { ArenaMatch } from "../../lib/arena/data.ts";
import { caption, Wire } from "./Wire.tsx";

// The match on the wire at the top of /line.
// - "live": a match under way. It asks the referee for the match every few seconds (a cached spectator view) and
//   shows each round as it's revealed.
// - "replay" (the latest finished match) and "example" (a sample, before any real match): played back a round every
//   few seconds, on a loop.
// The footer gives the round while it plays and the result only at the end, so it never spoils the match.

const STEP_MS = 3200;
const HOLD_MS = 8000;
const POLL_MS = 2500;

type Mode = "live" | "replay" | "example";
const LABEL: Record<Mode, string> = { live: "Live", replay: "Replay of the latest match", example: "Example match, played by sample fighters" };

export function ArenaLive({ match: initial, mode }: { match: ArenaMatch; mode: Mode }) {
  const [match, setMatch] = useState(initial);
  const [shown, setShown] = useState(mode === "live" ? initial.rounds.length : 0);
  const ref = useRef<HTMLDivElement>(null);
  const visible = useRef(true);
  const n = match.rounds.length;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => (visible.current = Boolean(e?.isIntersecting)), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (mode !== "live") return;
    let stop = false;
    const t = setInterval(async () => {
      if (stop || !visible.current || document.hidden) return;
      try {
        const res = await fetch(`/api/arena/match/${initial.id}`);
        if (!res.ok) return;
        const next = (await res.json()) as ArenaMatch;
        setMatch(next);
        setShown(next.rounds.length);
        if (next.ending) clearInterval(t);
      } catch {
        // A dropped poll: the next one catches up.
      }
    }, POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [mode, initial.id]);

  useEffect(() => {
    if (mode === "live") return;
    // A reveal every few seconds; at the end, hold the result a while, then start again. Skips ticks while hidden.
    let at = 0;
    let held = 0;
    const t = setInterval(() => {
      if (!visible.current || document.hidden) return;
      if (at >= n) {
        held += STEP_MS;
        if (held < HOLD_MS) return;
        held = 0;
        at = 0;
      } else at++;
      setShown(at);
    }, STEP_MS);
    return () => clearInterval(t);
  }, [mode, n]);

  const over = Boolean(match.ending) && shown >= n;
  return (
    <div ref={ref}>
      <Wire match={match} shown={shown} />
      <p className="arena-live-foot">
        <span>
          <span className={mode === "live" && !over ? "arena-dot-live" : "arena-dot-replay"} aria-hidden="true" />
          {LABEL[mode]} · {over ? caption(match, n) : `round ${Math.min(shown + 1, 15)} of 15`}
        </span>
        {mode === "example" ? null : <a href={`/line/match/${match.id}${mode === "replay" ? "?from=start" : ""}`}>{mode === "live" ? "Open the match →" : "Watch the full match →"}</a>}
      </p>
    </div>
  );
}
