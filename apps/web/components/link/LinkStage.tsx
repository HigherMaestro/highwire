"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fromAnswer, type LinkBattle } from "../../lib/link/battle.ts";
import { deepestDeficit, highlights, momentum, scoreOf, storyOf, teamsAt } from "../../lib/link/story.ts";
import { LinkScreens, type Shown } from "./LinkScreens.tsx";
import { Arena, clockText, Final, PlayByPlay, Reel, Scorebar, Share, Transport, Tug } from "./StageParts.tsx";
import { useDirector, useReducedMotion } from "./useDirector.ts";

// A link battle on the stage (docs/link-battles.md 13.2, 14.11), built to be watched: a scorebar with both teams and the
// score in Pokémon left; the two Pokémon out in their corners with the link cable between them, each turn played beat by
// beat (each move's pulse along the cable and its hit, a switch, a knockout); one "choosing" timer for both sides alike
// (never which side has decided); both Game Boys' screens when they may be shown; who's ahead turn by turn; the
// highlights; and every turn in the play-by-play.
//
// Live, it asks the referee every 2 seconds (one cached spectator view for everyone). With the screens, the stage follows
// them: each turn lands as its footage plays to the end, and the stage only echoes it. `at` pins it after one turn (a
// turn's link); `fromStart` plays it from the opening with the result held back (?from=start). Reduced motion: every
// change is a plain change of state.

const POLL_MS = 2000;
/** A replay without screens holds each turn this long once it has played (half at 2×). */
const HOLD_MS = 900;
/** The title card that opens a replay from the start. */
const TITLE_MS = 1800;
/** Turns shown before "Show earlier turns". */
const LOG_TURNS = 8;
/** Choosing longer than this says so. */
const STILL_CHOOSING_S = 45;

/** How a finished battle ended, under the band that already names the winner: the turns, and the way it ended. */
function howItEnded(w: LinkBattle): string {
  const e = w.ended;
  if (!e) return "";
  const how = e.reason === "knockout" ? "by knockout" : e.reason === "forfeit" ? (e.message ? `: ${e.message.replace(/\.$/, "")}` : "by forfeit") : e.reason === "draw" ? "at the turn cap" : e.message ? `: ${e.message.replace(/\.$/, "")}` : "";
  return `${w.turn} turns${how.startsWith(":") ? how : ` ${how}`}`.trim() + ".";
}

/** The stage, with both Game Boys' screens when they may be shown (never on the sample, which has no films). */
export function LinkStage({ initial, poll = true, screens = true, at, fromStart = false, compact = false }: { initial: LinkBattle; poll?: boolean; screens?: boolean; at?: number; fromStart?: boolean; compact?: boolean }) {
  const [w, setW] = useState(initial);
  // Pinned (a turn's link, from the start): the stage stays where the page put it until the screens move it.
  const pinned = at !== undefined || fromStart;
  const [shown, setShown] = useState<Shown>(at !== undefined ? { turn: at, done: true } : fromStart ? { turn: 0, done: false } : null);
  const [seek, setSeek] = useState<number | undefined>(undefined);
  const [allTurns, setAllTurns] = useState(false);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const follow = (x: Shown) => (x ? setShown(x) : pinned ? undefined : setShown(null));
  const drivenByScreens = screens && w.screens;
  const still = useReducedMotion();
  const [title, setTitle] = useState(fromStart && !(screens && initial.screens));
  const [onscreen, setOnscreen] = useState(true);
  const [docked, setDocked] = useState(false);
  const visible = useRef(true);
  const ref = useRef<HTMLDivElement>(null);
  const arenaRef = useRef<HTMLDivElement>(null);
  const live = w.live;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      visible.current = Boolean(e?.isIntersecting);
      setOnscreen(visible.current);
    }, { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The scorebar docks each side's HP once the arena has scrolled away above it.
  useEffect(() => {
    const el = arenaRef.current;
    if (!el || compact) return;
    const io = new IntersectionObserver(([e]) => setDocked(Boolean(e && !e.isIntersecting && e.boundingClientRect.top < 0)), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [compact]);

  useEffect(() => {
    if (!title) return;
    if (still) return setTitle(false);
    const t = setTimeout(() => setTitle(false), TITLE_MS);
    return () => clearTimeout(t);
  }, [title, still]);

  // Polling: every 2 seconds while live and on screen, backing off on errors; an older answer never moves it back.
  useEffect(() => {
    if (!live || !poll) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wait = POLL_MS;
    const run = async () => {
      if (stop) return;
      if (visible.current && !document.hidden) {
        try {
          const res = await fetch(initial.poll);
          if (res.status === 404) return;
          if (res.ok) {
            const next = fromAnswer(await res.json());
            setW((cur) => (next.turn < cur.turn || (cur.live === false && next.live) ? cur : next));
            wait = POLL_MS;
            if (!next.live) return;
          } else wait = Math.min(30_000, wait * 2);
        } catch {
          wait = Math.min(30_000, wait * 2);
        }
      }
      if (!stop) timer = setTimeout(run, wait);
    };
    timer = setTimeout(run, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [live, poll, initial.poll]);

  const s = w.spectator;
  const left = w.left;
  const right = (1 - left) as 0 | 1;
  const names: [string, string] = [w.sides[0].house ? "The house" : w.sides[0].name, w.sides[1].house ? "The house" : w.sides[1].name];
  const labels = useMemo(() => [`${w.sides[0].name}'s`, `${w.sides[1].name}'s`] as [string, string], [w.sides]);
  const newest = s?.turns.at(-1)?.turn ?? 0;
  const upTo = shown ? Math.max(0, Math.min(newest, shown.done ? shown.turn : shown.turn - 1)) : newest;
  const behind = upTo < newest;
  // The battle as the screens (or the replay) have shown it: up to the turn on screen, that turn too once it's played.
  const stageSides = useMemo(() => {
    if (!s) return null;
    return (upTo >= newest ? s.sides : upTo <= 0 ? s.start : s.turns.find((t) => t.turn === upTo)?.after) ?? s.sides;
  }, [s, upTo, newest]);
  const director = useDirector({ s, upTo, sides: stageSides, labels, echo: drivenByScreens || speed === 2, still });
  // What the feed, the chart and the score take in: the turn playing only once it has played.
  const settledTo = director.busy ? Math.max(0, upTo - 1) : upTo;
  const koLanded = director.landed.some((b) => b.kind === "faint");
  const teams = useMemo(() => teamsAt(s, director.playing && !koLanded ? Math.max(0, upTo - 1) : behind ? upTo : null), [s, director.playing, koLanded, upTo, behind]);
  const score = scoreOf(teams);
  const points = useMemo(() => momentum(s), [s]);
  const stories = useMemo(() => new Map((s?.turns ?? []).map((t) => [t.turn, storyOf(t.lines, labels)])), [s, labels]);
  // The result is held back while a replay hasn't reached it (a turn's link, from the start).
  const holdResult = !live && behind;
  const over = !live && !holdResult && !director.busy;

  // From the start without screens to follow: each turn plays, holds, and the next comes; paused, it waits.
  useEffect(() => {
    if (!fromStart || drivenByScreens || paused || title || director.busy) return;
    if (!shown || shown.turn >= newest) {
      if (shown && w.live) setShown(null);
      return;
    }
    const t = setTimeout(() => setShown({ turn: shown.turn + 1, done: true }), speed === 2 ? HOLD_MS / 2 : HOLD_MS);
    return () => clearTimeout(t);
  }, [fromStart, drivenByScreens, paused, title, director.busy, shown, newest, w.live, speed]);

  // One timer for both sides while they choose: counted from when this page first saw the turn open, never per side.
  const openedAt = useRef<{ turn: number; at: number }>({ turn: w.turn, at: Date.now() });
  if (openedAt.current.turn !== w.turn) openedAt.current = { turn: w.turn, at: Date.now() };
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  const choosingFor = Math.max(0, Math.floor((Date.now() - openedAt.current.at) / 1000));
  const choosing = live && !behind && !director.busy;

  // What happened while this page watched: the newest row, the end, the screens coming on.
  const lastSettled = useRef(settledTo);
  const [fresh, setFresh] = useState<number | null>(null);
  useEffect(() => {
    if (settledTo === lastSettled.current + 1) setFresh(settledTo);
    lastSettled.current = settledTo;
  }, [settledTo]);
  const sawPlay = useRef(live || fromStart);
  const freshEnd = over && sawPlay.current;
  const hadScreens = useRef(w.screens);
  const screensFresh = w.screens && !hadScreens.current;

  const winner = over && w.ended && w.ended.reason !== "void" && w.ended.winner !== null ? w.ended.winner : null;
  const result = (side: 0 | 1) => (winner === null ? null : winner === side ? "winner" : "loser");
  const shownTurn = director.busy && director.now ? director.now.turn : upTo;
  const turnLabel = live && !behind && !director.busy ? `Turn ${w.turn + 1}` : shownTurn <= 0 ? "Opening" : `Turn ${shownTurn}`;
  const talk = new Map<string, string>(w.lines.map((l) => [`${l.turn}:${l.side}`, l.line]));
  const rated = w.kind !== "practice";
  const turnLink = rated && !compact ? (t: number) => `/link/match/${w.match}/turn/${t}` : null;
  const settledTurns = (s?.turns ?? []).filter((t) => t.turn <= settledTo).reverse();
  const listed = compact ? settledTurns.slice(0, 1) : allTurns ? settledTurns : settledTurns.slice(0, LOG_TURNS);
  const marks = useMemo(() => highlights(s, labels, left), [s, labels, left]);
  const shownMarks = marks.filter((m) => m.turn <= settledTo);
  const domain = over ? Math.max(1, newest) : Math.max(12, settledTo + 2);
  const display = director.display;
  const pill = live ? "Live" : holdResult || director.busy ? "Replay" : "Final";
  const brink = display && !over && display[0].hp_percent > 0 && display[1].hp_percent > 0 && display[0].hp_percent <= 20 && display[1].hp_percent <= 20;
  const deficit = winner === null ? 0 : deepestDeficit(s, winner);

  const call = director.now
    ? director.now.step.beat.text
    : choosing
      ? brink
        ? "Both on the brink. Both sides are choosing."
        : choosingFor >= STILL_CHOOSING_S
          ? "Still choosing."
          : "Both sides are choosing."
      : behind
        ? `${upTo <= 0 ? "The opening." : `After turn ${upTo}.`}${live ? " Catching up to the battle." : ""}`
        : "";

  const node = title ? (
    <span className="link-node-v">v</span>
  ) : (
    <>
      <span className="link-node-n">{choosing ? w.turn + 1 : Math.max(0, shownTurn) || "–"}</span>
      {choosing ? <span className="link-node-t">{clockText(choosingFor)}</span> : <span className="link-node-t">{over ? "end" : shownTurn > 0 ? "turn" : "start"}</span>}
    </>
  );

  return (
    <div ref={ref} className={`link-show${compact ? " link-show-compact" : ""}`} data-onscreen={onscreen ? "" : undefined}>
      <Scorebar
        w={w}
        names={names}
        teams={teams}
        score={score}
        turnLabel={turnLabel}
        pill={pill}
        clocks={[clockText(w.clocks?.[0]), clockText(w.clocks?.[1])]}
        hp={display ? [display[0].hp_percent, display[1].hp_percent] : null}
        docked={docked}
      />

      {over && w.ended ? (
        <Final
          head={winner === null ? { text: w.ended.reason === "void" ? "No result" : "A draw" } : { name: names[winner], won: true }}
          tone={winner === null ? null : winner === left ? "a" : "b"}
          sub={howItEnded(w)}
          ratings={([0, 1] as const).flatMap((x) => (w.ratingChanges?.[x] === null || w.ratingChanges?.[x] === undefined ? [] : [{ name: names[x], change: w.ratingChanges[x]! }]))}
          comeback={deficit >= 30 ? `Came back from ${deficit} down.` : null}
          fresh={freshEnd && !still}
        >
          {!compact ? (
            <>
              {rated ? (
                <a className="link-btn link-btn-primary" href={`/link/match/${w.match}?from=start`}>
                  Watch from the start
                </a>
              ) : null}
              <Share w={w} names={names} />
            </>
          ) : null}
        </Final>
      ) : null}

      {/* Screens that came on as the battle ended wait for the end to play out, then power on under the result. */}
      {drivenByScreens && !(screensFresh && !over) ? (
        <LinkScreens match={w.match} turns={w.turn} live={live} left={left} names={names} onShow={follow} startTurn={at ?? (fromStart ? 0 : undefined)} autoplay={fromStart} seek={seek} fresh={screensFresh} />
      ) : null}

      {s && display ? (
        <Arena
          arenaRef={arenaRef}
          sides={display}
          left={left}
          names={names}
          exact={!s.live}
          result={result}
          now={director.now}
          choosing={choosing}
          node={node}
          over={over}
          compact={compact}
          title={title ? [names[left], names[right]] : null}
        />
      ) : null}

      {call || live ? (
        <p className={`link-call${director.now ? " link-call-beat" : ""}`} aria-live="polite">
          {choosing ? <span className="link-live-dot" aria-hidden="true" /> : null}
          <span key={call} className="link-call-text">
            {call}
          </span>
        </p>
      ) : null}

      {fromStart && !drivenByScreens && !compact ? (
        <Transport
          label={upTo <= 0 ? "The opening" : holdResult || live ? `Turn ${upTo}` : `Turn ${upTo} of ${newest}`}
          playing={!paused && (behind || title)}
          onToggle={() => {
            if (!behind && !live) {
              setShown({ turn: 0, done: true });
              setPaused(false);
            } else setPaused(!paused);
          }}
          onPrev={() => (setPaused(true), setShown({ turn: Math.max(0, upTo - 1), done: true }))}
          onNext={() => (setPaused(true), setShown({ turn: Math.min(newest, upTo + 1), done: true }))}
          canPrev={upTo > 0}
          canNext={upTo < newest}
          speed={speed}
          onSpeed={() => setSpeed(speed === 1 ? 2 : 1)}
        />
      ) : null}

      {screens && !w.screens && !compact ? <p className="link-screens-later">Both Game Boys&apos; screens appear here when the battle ends: each shows its own side&apos;s exact HP and PP.</p> : null}

      {!compact && points.length > 1 ? (
        <Tug points={points} upTo={settledTo} domain={domain} names={[names[left], names[right]]} left={left} marks={over ? marks : shownMarks} onSeek={!live && drivenByScreens ? setSeek : undefined} />
      ) : null}

      {!compact ? <Reel items={over ? marks : shownMarks} names={names} left={left} link={turnLink} onSeek={!turnLink && !live && drivenByScreens ? setSeek : undefined} /> : null}

      {!compact && listed.length ? <h2 className="link-label">Play by play</h2> : null}
      <PlayByPlay turns={listed} stories={stories} talk={talk} names={names} left={left} link={turnLink} highlight={at} fresh={fresh} />
      {!allTurns && !compact && settledTurns.length > LOG_TURNS ? (
        <button type="button" className="link-btn link-more" onClick={() => setAllTurns(true)}>
          Show the {settledTurns.length - LOG_TURNS} earlier turns
        </button>
      ) : null}
    </div>
  );
}
