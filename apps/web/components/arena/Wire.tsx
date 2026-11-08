"use client";

import { useEffect, useState } from "react";
import type { ArenaMatch, Side } from "../../lib/arena/data.ts";

// The arena's stage, built to be read at a glance by someone who has never seen it: a scoreboard (each side's rounds
// won and energy), the wire with each end named as that side's goal, the last round's two pulls (which stay up until
// the next reveal), one plain sentence saying what just happened, and each side's latest words. Side a pulls left,
// side b right. Only arrivals animate; nothing a spectator needs ever fades away. Reduced motion gets no animation.

const X0 = 120;
const X1 = 880;
const PLACE = (X1 - X0) / 6;
const x = (place: number) => 500 + place * PLACE;
const Y = 120;

/** True on narrow screens, where the stage draws a tighter crop with heavier lines. */
function useCompact(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(max-width: 760px)");
    const on = () => setCompact(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return compact;
}

const ENDING: Record<string, string> = {
  reached_end: "pulled the node to its end",
  rounds_up: "was ahead after 15 rounds",
  forfeit: "won: the other side retired",
  tie_break: "won on the tie-break",
};

/** What just happened, in one sentence. */
export function caption(m: ArenaMatch, shown: number): string {
  const name = (s: Side) => m.sides[s].name;
  if (shown >= m.rounds.length && m.ending) {
    if (m.ending.reason === "void") return "No result: neither side showed up.";
    if (m.ending.winner === null) return "A draw: the node finished in the middle after 15 rounds.";
    return `${name(m.ending.winner)} wins: it ${ENDING[m.ending.reason] ?? "won"}.`;
  }
  const r = m.rounds[shown - 1];
  if (!r) return "Round 1: both sides are choosing a pull in secret.";
  const missed = (["a", "b"] as const).filter((s) => r[s].fallback).map((s) => `${name(s)} ran out of time, so its fallback pulled ${r[s].pull}. `).join("");
  if (r.winner === null) return `${missed}Round ${r.round}: both pull ${r.a.pull}. A tie, so the node holds.`;
  const w = r.winner;
  const l = w === "a" ? "b" : "a";
  return `${missed}Round ${r.round}: ${name(w)} pulls ${r[w].pull} to ${name(l)}'s ${r[l].pull}, and drags the node one place toward its end.`;
}

export function Wire({ match: m, shown, label }: { match: ArenaMatch; shown: number; label?: string }) {
  const compact = useCompact();
  const k = compact ? 1.7 : 1;
  const rounds = m.rounds.slice(0, shown);
  const last = rounds.at(-1);
  const node = last?.node ?? 0;
  const from = rounds.at(-2)?.node ?? 0;
  const energy = last?.energy ?? { a: 30, b: 30 };
  const done = shown >= m.rounds.length && Boolean(m.ending);
  const won = (s: Side) => rounds.filter((r) => r.winner === s).length;
  const said = (s: Side) => [...rounds].reverse().find((r) => r[s].line);
  const anyTalk = m.rounds.some((r) => r.a.line || r.b.line);

  return (
    <figure className={`arena-stage${compact ? " is-compact" : ""}`} aria-label={label ?? `${m.sides.a.name} against ${m.sides.b.name}`}>
      <div className="arena-board">
        {(["a", "b"] as const).map((s) => (
          <div key={s} className={`arena-side arena-side-${s}${done && m.ending?.winner === s ? " is-winner" : ""}`}>
            <span className="arena-kind">{m.sides[s].kind === "house" ? "Highwire's house bot" : "Agent"}</span>
            <strong className="arena-name">{m.sides[s].name}</strong>
            <span className="arena-energy" role="meter" aria-label={`${m.sides[s].name}'s energy`} aria-valuemin={0} aria-valuemax={30} aria-valuenow={energy[s]}>
              <i style={{ width: `${(energy[s] / 30) * 100}%` }} />
              <b>{energy[s]} energy</b>
            </span>
            <span className="arena-won">
              <b key={won(s)}>{won(s)}</b> round{won(s) === 1 ? "" : "s"} won
            </span>
          </div>
        ))}
        <div className="arena-round">
          {done ? "Final" : `Round ${Math.min(shown + 1, 15)}`}
          <small>of 15</small>
        </div>
      </div>

      <svg className="arena-svg" viewBox={compact ? "90 50 820 120" : "0 40 1000 120"} role="img" aria-label={node === 0 ? "The node is in the middle." : `The node is ${Math.abs(node)} place${Math.abs(node) > 1 ? "s" : ""} from the middle, toward ${node < 0 ? m.sides.a.name : m.sides.b.name}'s end.`}>
        <defs>
          <linearGradient id="arena-wire" x1={X0} x2={X1} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="var(--side-a)" />
            <stop offset="0.5" stopColor="var(--muted)" stopOpacity="0.6" />
            <stop offset="1" stopColor="var(--side-b)" />
          </linearGradient>
          <radialGradient id="arena-glow">
            <stop offset="0" stopColor="var(--fg)" stopOpacity="0.55" />
            <stop offset="1" stopColor="var(--fg)" stopOpacity="0" />
          </radialGradient>
        </defs>

        <line x1={X0} x2={X1} y1={Y} y2={Y} stroke="url(#arena-wire)" strokeWidth={3 * k} strokeLinecap="round" />
        {[-3, -2, -1, 0, 1, 2, 3].map((p) => (
          <g key={p} className={`arena-place${p === -3 ? " is-end-a" : p === 3 ? " is-end-b" : ""}`}>
            {Math.abs(p) === 3 ? <circle cx={x(p)} cy={Y} r={13 * k} /> : <line x1={x(p)} x2={x(p)} y1={Y - (p === 0 ? 11 : 7) * k} y2={Y + (p === 0 ? 11 : 7) * k} />}
          </g>
        ))}

        {/* The last reveal's pulls: they arrive with a flourish and stay until the next round is revealed. */}
        {last ? (
          <g key={`pull-${last.round}`} className="arena-pulls">
            {(["a", "b"] as const).map((s) => {
              const len = Math.max(6, (last[s].pull / 30) * 330);
              return (
                <g key={s} className={`arena-pull arena-pull-${s}${last.winner === s ? " is-winner" : ""}`}>
                  <line className="arena-pull-bar" x1={x(from)} x2={s === "a" ? x(from) - len : x(from) + len} y1={Y} y2={Y} style={{ transformOrigin: `${x(from)}px ${Y}px` }} />
                  <text className="arena-pull-n" x={s === "a" ? x(from) - 36 * k : x(from) + 36 * k} y={Y - 26 * k} textAnchor="middle">
                    {last[s].pull}
                  </text>
                </g>
              );
            })}
          </g>
        ) : null}

        <g className="arena-node" style={{ transform: `translateX(${x(node) - 500}px)` }}>
          <circle cx={500} cy={Y} r={34 * k} fill="url(#arena-glow)" />
          <circle cx={500} cy={Y} r={11 * k} className="arena-node-core" />
        </g>
      </svg>

      <div className="arena-goals" aria-hidden="true">
        <span className="arena-goal-a">← {m.sides.a.name} wins here</span>
        <span className="arena-goal-b">{m.sides.b.name} wins here →</span>
      </div>

      <p className="arena-caption" aria-live="polite" key={`cap-${shown}`}>
        {caption(m, shown)}
      </p>

      {anyTalk ? (
        <div className="arena-talk">
          {(["a", "b"] as const).map((s) => {
            const r = said(s);
            return (
              <p key={s} className={`arena-said arena-said-${s}${r ? "" : " is-empty"}${r && r.round === last?.round ? " is-new" : ""}`}>
                {r ? (
                  <>
                    <span className="arena-said-who">
                      {m.sides[s].name}, round {r.round}
                    </span>
                    {r[s].line}
                  </>
                ) : (
                  <span className="arena-said-who">{m.sides[s].name} hasn&apos;t said anything</span>
                )}
              </p>
            );
          })}
        </div>
      ) : null}
    </figure>
  );
}
