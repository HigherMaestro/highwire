"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { battleRatings, battleVerdict, fromAnswer, type LinkBattle, type LinkSide } from "../../lib/link/battle.ts";
import { LinkScreens, type Shown } from "./LinkScreens.tsx";

// A link battle on the stage (docs/link-battles.md 13.2): both sides' Pokémon out, their HP as the game's bars, status
// and field, what each side has shown, and every turn told in plain sentences. Live, it asks the referee every 2 seconds
// (one cached spectator view for everyone) and never says which side has chosen: both are "choosing" alike. With the
// screens, the stage follows them: each turn's HP, status and lines arrive as its footage plays to the end, not when the
// referee resolves it (a turn's footage runs longer than a fast agent takes to move).

const POLL_MS = 2000;

function Side({ side, who, tone, exact, clock }: { side: LinkSide; who: string; tone: "a" | "b"; exact: boolean; clock: string | null }) {
  const pct = Math.max(0, Math.min(100, side.hp_percent));
  const band = pct > 50 ? "ok" : pct > 20 ? "low" : "red";
  return (
    <div className={`link-side link-side-${tone}`}>
      <p className="link-side-who">
        {who}
        {clock ? <span className="link-side-clock" title="Its clock as this turn opened"> · clock {clock}</span> : null}
      </p>
      <h3 className="link-side-mon">
        {side.species} <span className="muted">Lv {side.level}</span>
      </h3>
      <div className="link-hp" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${who}'s ${side.species}'s HP`}>
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

/** Without screens to follow, a battle watched from the start moves on a turn at a time: this long a turn, half while behind live. */
const REPLAY_MS = 2500;

/**
 * The stage, with both Game Boys' screens above it when they may be shown (never on the sample, which has no films).
 * `at` pins it after that turn, the screens opened there (a turn's link, 13.1); `fromStart` plays it from the opening
 * with the result held back until it's reached (`?from=start`), catching up at double speed to a battle still on.
 */
export function LinkStage({ initial, poll = true, screens = true, at, fromStart = false }: { initial: LinkBattle; poll?: boolean; screens?: boolean; at?: number; fromStart?: boolean }) {
  const [w, setW] = useState(initial);
  // Pinned (a turn's link, from the start): the stage stays where the page put it until the screens move it.
  const pinned = at !== undefined || fromStart;
  const [shown, setShown] = useState<Shown>(at !== undefined ? { turn: at, done: true } : fromStart ? { turn: 0, done: false } : null);
  const follow = (s: Shown) => (s ? setShown(s) : pinned ? undefined : setShown(null));
  const drivenByScreens = screens && w.screens;
  const visible = useRef(true);
  const ref = useRef<HTMLDivElement>(null);
  const live = w.live;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => (visible.current = Boolean(e?.isIntersecting)), { threshold: 0.1 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!live || !poll) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wait = POLL_MS;
    const tick = async () => {
      if (stop) return;
      if (visible.current && !document.hidden) {
        try {
          const res = await fetch(initial.poll);
          // Gone (expired) or never there: stop asking.
          if (res.status === 404) return;
          if (res.ok) {
            const next = fromAnswer(await res.json());
            // An older answer (a cache that's behind) never moves the stage back.
            setW((cur) => (next.turn < cur.turn || (cur.live === false && next.live) ? cur : next));
            wait = POLL_MS;
            if (!next.live) return;
          } else wait = Math.min(30_000, wait * 2);
        } catch {
          // A dropped poll: back off a little, then catch up.
          wait = Math.min(30_000, wait * 2);
        }
      }
      if (!stop) timer = setTimeout(tick, wait);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [live, poll, initial.poll]);

  // From the start without screens to follow (a live rated battle, or the sample): a turn at a time, faster while behind.
  useEffect(() => {
    if (!fromStart || drivenByScreens) return;
    const newest = w.spectator?.turns.at(-1)?.turn ?? 0;
    if (!shown || shown.turn >= newest) {
      if (shown && w.live) setShown(null);
      return;
    }
    const t = setTimeout(() => setShown({ turn: shown.turn + 1, done: true }), w.live ? REPLAY_MS / 2 : REPLAY_MS);
    return () => clearTimeout(t);
  }, [fromStart, drivenByScreens, shown, w]);

  const s = w.spectator;
  const left = w.left;
  const right = (1 - left) as 0 | 1;
  const names: [string, string] = [w.sides[0].name, w.sides[1].name];
  const talk = new Map<string, string>(w.lines.map((l) => [`${l.turn}:${l.side}`, l.line]));
  // The battle as the screens have shown it: up to the turn on screen (that turn too once it has played to its end).
  const stage = useMemo(() => {
    if (!s) return null;
    const newest = s.turns.at(-1)?.turn ?? 0;
    const upTo = shown ? (shown.done ? shown.turn : shown.turn - 1) : newest;
    const sides = upTo >= newest ? s.sides : upTo <= 0 ? s.start : s.turns.find((t) => t.turn === upTo)?.after;
    // Battles saved before each turn's sides were kept: the stage as it stands.
    if (!sides) return { sides: s.sides, turns: s.turns, behind: null };
    return { sides, turns: s.turns.filter((t) => t.turn <= upTo), behind: upTo < newest ? Math.max(0, upTo) : null };
  }, [s, shown]);
  const clock = (side: 0 | 1) => {
    const c = w.clocks?.[side];
    return c === null || c === undefined ? null : `${Math.floor(c / 60)}:${String(c % 60).padStart(2, "0")}`;
  };
  return (
    <div ref={ref}>
      {drivenByScreens ? (
        <LinkScreens match={w.match} turns={w.turn} live={live} left={left} names={names} onShow={follow} startTurn={at ?? (fromStart ? 0 : undefined)} autoplay={fromStart} />
      ) : screens && !w.screens ? (
        <p className="link-screens-later muted">
          Both Game Boys&apos; screens appear here when the battle ends: each shows its own side&apos;s exact HP and PP, which the other side mustn&apos;t see while it&apos;s on.
        </p>
      ) : null}
      {s && stage ? (
        <div className="link-stage">
          <Side side={stage.sides[left]} who={names[left]} tone="a" exact={!s.live} clock={clock(left)} />
          <div className="link-cable" aria-hidden="true">
            <span />
          </div>
          <Side side={stage.sides[right]} who={names[right]} tone="b" exact={!s.live} clock={clock(right)} />
        </div>
      ) : null}
      <p className="arena-live-foot">
        <span>
          <span className={live ? "arena-dot-live" : "arena-dot-replay"} aria-hidden="true" />
          {live
            ? `Live · turn ${w.turn + 1} · both sides choosing…`
            : stage?.behind !== null && stage?.behind !== undefined && (fromStart || at !== undefined)
              ? `Over · the result shows once it's played`
              : `Over · ${battleVerdict(w)}${battleRatings(w) ? ` ${battleRatings(w)}` : ""}`}
          {stage?.behind !== null && stage?.behind !== undefined ? <span className="muted"> · {drivenByScreens ? "the stage follows the screens, at" : "showing"} {stage.behind ? `turn ${stage.behind}` : "the opening"}</span> : null}
        </span>
      </p>
      <ol className="link-turns" reversed aria-label="Every turn, newest first" aria-live="polite" aria-relevant="additions">
        {[...(stage?.turns ?? [])].reverse().map((t) => (
          <li key={t.turn}>
            <p className="link-turn-n">Turn {t.turn}</p>
            {([left, right] as const).map((side) =>
              talk.get(`${t.turn}:${side}`) ? (
                <p key={side} className="link-talk">
                  <span className="muted small">{names[side]} said:</span> “{talk.get(`${t.turn}:${side}`)}”
                </p>
              ) : null,
            )}
            {t.lines.length ? t.lines.map((l, i) => <p key={i}>{l}</p>) : <p className="muted">Nothing happened.</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}
