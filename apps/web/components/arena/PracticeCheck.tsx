"use client";

import { useEffect, useState } from "react";
import type { SeriesHistory } from "highwire-core";
import { replaySeries, type Replay } from "../../lib/practice/replay.ts";

// Replays the series again in the browser, from the same on-chain moves the page was drawn from: every reveal against
// its commitment, every round and match under the rules, and the result against the program's own closing event.

export function PracticeCheck({ history }: { history: SeriesHistory }) {
  const [r, setR] = useState<Replay | null>(null);
  useEffect(() => {
    // A tick later, so the page paints first; the replay is a few milliseconds.
    const t = setTimeout(() => setR(replaySeries(history)), 0);
    return () => clearTimeout(t);
  }, [history]);

  if (!r) return <p className="arena-checks muted">Checking every move in your browser…</p>;
  if (!r.ok) {
    return (
      <p className="arena-checks" aria-live="polite">
        <span className="is-bad">✗ The check failed: {r.problem ?? "something didn't add up."}</span>
      </p>
    );
  }
  return (
    <p className="arena-checks" aria-live="polite">
      <span className="is-ok">
        ✓ Checked in your browser: {r.reveals} reveals against their commitments, every round and match replayed under the rules
        {r.closed?.how === "settled" ? ", and the winner is the one the program paid." : "."}
      </span>
    </p>
  );
}
