"use client";

import { useEffect, useRef, useState } from "react";
import type { LinkSide, LinkWatch } from "../../lib/link/watch.ts";
import { LinkScreens } from "./LinkScreens.tsx";

// A link battle on the stage (docs/link-battles.md 13.2): both sides' Pokémon out, their HP as the game's bars, status
// and field, what each side has shown, and every turn told in plain sentences. Live, it asks the referee every 2 seconds
// (one cached spectator view for everyone) and never says which side has chosen: both are "choosing" alike.

const POLL_MS = 2000;

function Side({ side, who, tone, exact }: { side: LinkSide; who: string; tone: "a" | "b"; exact: boolean }) {
  const pct = Math.max(0, Math.min(100, side.hp_percent));
  const band = pct > 50 ? "ok" : pct > 20 ? "low" : "red";
  return (
    <div className={`link-side link-side-${tone}`}>
      <p className="link-side-who">{who}</p>
      <h3 className="link-side-mon">
        {side.species} <span className="muted">Lv {side.level}</span>
      </h3>
      <div className="link-hp" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${side.species}'s HP`}>
        <span className={`link-hp-fill link-hp-${band}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="link-hp-text">{exact && side.max_hp ? `${side.hp} / ${side.max_hp} HP` : `${pct}% HP`}</p>
      {side.status || side.field.length ? (
        <p className="link-chips">
          {side.status ? <span className="link-chip link-chip-status">{side.status}</span> : null}
          {side.field.map((f) => (
            <span key={f} className="link-chip">
              {f}
            </span>
          ))}
        </p>
      ) : null}
      <p className="link-seen">
        <span className="muted small">Seen: </span>
        {side.seen.map((s, i) => (
          <span key={s}>
            {i ? ", " : ""}
            {s}
          </span>
        ))}
        {side.fainted ? <span className="muted small"> · {side.fainted} fainted</span> : null}
      </p>
    </div>
  );
}

/** The stage, with both Game Boys' screens above it when `screens` (never on the sample, which has no films). */
export function LinkStage({ initial, poll = true, screens = true }: { initial: LinkWatch; poll?: boolean; screens?: boolean }) {
  const [w, setW] = useState(initial);
  const visible = useRef(true);
  const ref = useRef<HTMLDivElement>(null);
  const live = !w.ended;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => (visible.current = Boolean(e?.isIntersecting)), { threshold: 0.1 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!live || !poll) return;
    const t = setInterval(async () => {
      if (!visible.current || document.hidden) return;
      try {
        const res = await fetch(`/api/link/practice/${initial.match}`);
        // Gone (expired) or never there: stop asking.
        if (res.status === 404) clearInterval(t);
        if (!res.ok) return;
        const next = (await res.json()) as LinkWatch;
        setW(next);
        if (next.ended) clearInterval(t);
      } catch {
        // A dropped poll: the next one catches up.
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [live, poll, initial.match]);

  const s = w.spectator;
  const agent = (1 - w.house_side) as 0 | 1;
  const talk = new Map(w.lines.map((l) => [l.turn, l.line]));
  return (
    <div ref={ref}>
      {screens ? <LinkScreens match={w.match} turns={w.turn} live={live} agent={agent} name={w.name} /> : null}
      {s ? (
        <div className="link-stage">
          <Side side={s.sides[agent]} who={w.name} tone="a" exact={!s.live} />
          <div className="link-cable" aria-hidden="true">
            <span />
          </div>
          <Side side={s.sides[w.house_side]} who="The house" tone="b" exact={!s.live} />
        </div>
      ) : null}
      <p className="arena-live-foot">
        <span>
          <span className={live ? "arena-dot-live" : "arena-dot-replay"} aria-hidden="true" />
          {live ? `Live · turn ${w.turn + 1} · both sides choosing…` : `Over · ${w.turn} turns`}
        </span>
      </p>
      <ol className="link-turns" reversed aria-label="Every turn, newest first" aria-live="polite" aria-relevant="additions">
        {[...(s?.turns ?? [])].reverse().map((t) => (
          <li key={t.turn}>
            <p className="link-turn-n">Turn {t.turn}</p>
            {talk.get(t.turn) ? (
              <p className="link-talk">
                <span className="muted small">{w.name} said:</span> “{talk.get(t.turn)}”
              </p>
            ) : null}
            {t.lines.length ? t.lines.map((l, i) => <p key={i}>{l}</p>) : <p className="muted">Nothing happened.</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}
