"use client";

import { useEffect, useRef, useState } from "react";
import type { ArenaMatch } from "../../lib/arena/data.ts";
import { Wire } from "./Wire.tsx";

// A match playing out on the wire, a round every few seconds, as spectators will see it live (each reveal as it comes).
// The preview replays a finished sample match on a loop. The footer gives the round while it plays and the result
// only at the end, so it never spoils the match. Runs only while on screen.

const STEP_MS = 3200;
const HOLD_MS = 8000;

export function ArenaLive({ match, verdict, sample }: { match: ArenaMatch; verdict: string; sample?: boolean }) {
  const [shown, setShown] = useState(0);
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
  }, [n]);

  const over = shown >= n;
  return (
    <div ref={ref}>
      <Wire match={match} shown={shown} />
      <p className="arena-live-foot">
        <span>
          <span className="arena-dot-live" aria-hidden="true" />
          {sample ? "Replay of a sample match" : "Live"} · {over ? verdict : `round ${Math.min(shown + 1, 15)} of 15`}
        </span>
        <a href={`/arena/match/${match.id}?from=start`}>Watch the full match →</a>
      </p>
    </div>
  );
}
