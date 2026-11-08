"use client";

import { useEffect, useState } from "react";
import type { ArenaMatch } from "../../lib/arena/data.ts";
import { Wire } from "./Wire.tsx";

// A finished match, round by round: play, pause, step, scrub. Below it, the checks anyone can run: every move's
// commitment, and the house's seed against the hash published when the match began, computed here, in the browser.

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Checks {
  commitments: number;
  ok: number;
  seed: boolean | null;
}

/** `fromStart` opens at round 1 and plays, for links meant to be watched rather than to give the result. */
export function ArenaReplay({ match: m, fromStart = false }: { match: ArenaMatch; fromStart?: boolean }) {
  const total = m.rounds.length;
  const [shown, setShown] = useState(fromStart ? 0 : total);
  const [playing, setPlaying] = useState(fromStart);
  const [checks, setChecks] = useState<Checks | null>(null);

  useEffect(() => {
    if (!playing) return;
    if (shown >= total) return setPlaying(false);
    const t = setTimeout(() => setShown((s) => s + 1), 2600);
    return () => clearTimeout(t);
  }, [playing, shown, total]);

  useEffect(() => {
    let live = true;
    (async () => {
      let ok = 0;
      let n = 0;
      for (const r of m.rounds) {
        for (const s of ["a", "b"] as const) {
          n++;
          if ((await sha256(`${m.id}|${r.round}|${s}|${r[s].pull}|${r[s].nonce}`)) === r[s].commitment) ok++;
        }
      }
      const seed = m.house?.seed ? (await sha256(m.house.seed)) === m.house.seedCommitment : null;
      if (live) setChecks({ commitments: n, ok, seed });
    })();
    return () => {
      live = false;
    };
  }, [m]);

  return (
    <div className="arena-replay">
      <Wire match={m} shown={shown} />
      <div className="arena-controls">
        <button
          type="button"
          className="button"
          onClick={() => {
            if (shown >= total) setShown(0);
            setPlaying((p) => !p);
          }}
        >
          {playing ? "Pause" : shown >= total ? "Replay" : "Play"}
        </button>
        <button type="button" className="button button-quiet" onClick={() => setShown((s) => Math.max(0, s - 1))} disabled={shown === 0} aria-label="Previous round">
          ←
        </button>
        <button type="button" className="button button-quiet" onClick={() => setShown((s) => Math.min(total, s + 1))} disabled={shown >= total} aria-label="Next round">
          →
        </button>
        <input
          type="range"
          min={0}
          max={total}
          value={shown}
          onChange={(e) => {
            setPlaying(false);
            setShown(Number(e.target.value));
          }}
          aria-label="Round"
        />
        <span className="arena-controls-n">
          {shown} / {total}
        </span>
      </div>
      <p className="arena-checks" aria-live="polite">
        {checks === null ? (
          "Checking the commitments in your browser…"
        ) : (
          <>
            <span className={checks.ok === checks.commitments ? "is-ok" : "is-bad"}>
              {checks.ok === checks.commitments ? `✓ Every move checks out (${checks.ok} of ${checks.commitments})` : `✗ ${checks.commitments - checks.ok} moves don't match their seal`}
            </span>
            {checks.seed !== null ? (
              <span className={checks.seed ? "is-ok" : "is-bad"}>{checks.seed ? "✓ The house bot played fair" : "✗ The house bot's seed doesn't match"}</span>
            ) : null}
            <a href="#record" className="muted">
              Checked in your browser · how
            </a>
          </>
        )}
      </p>
    </div>
  );
}
