"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fromAnswer, type LinkBattle } from "../../lib/link/battle.ts";
import { colour, deepestDeficit, edgeOf, highlights, momentum, scoreOf, situation, storyOf, teamHp, teamsAt, turnCall } from "../../lib/link/story.ts";
import { LinkScreens, type Shown } from "./LinkScreens.tsx";
import { Arena, Bench, clockText, Final, Icon, Pick, PlayByPlay, Reel, Scorebar, Share, Transport, Tug, usePick } from "./StageParts.tsx";
import { useDirector, useReducedMotion } from "./useDirector.ts";
import { useSound } from "./useSound.ts";

// A link battle on the stage (docs/link-battles.md 13.2, 14.11, 14.12), built to be watched: a scorebar with both
// fighters, their teams and the score in Pokémon left; the two Pokémon out in their corners with the link cable between
// them, each turn played beat by beat (each move's pulse along the cable and its hit, a switch, a knockout); the agents'
// own words under their corners; one "choosing" timer for both sides alike (never which side has decided), with
// something new said every few seconds; both Game Boys' screens when they may be shown; the bench; who's ahead turn by
// turn; the highlights; and every turn in the play-by-play.
//
// Every page opens in motion: a live battle and a finished one play their last turn as they arrive (a finished one then
// its ending), a turn's link plays that turn. Live, it asks the referee every 2 seconds (one cached spectator view for
// everyone). With the screens playing, the stage follows them: each turn lands as its footage plays to the end, and the
// stage only echoes it. `at` pins it after one turn (a turn's link); `fromStart` plays it from the opening with the
// result held back (?from=start). Reduced motion: every change is a plain change of state.

const POLL_MS = 2000;
/** A replay without screens holds a turn this long once it has played: longer after a knockout or a change of lead (half at 2×). */
const HOLD_MS = 300;
const HOLD_BIG_MS = 1200;
/** The title card that opens a replay from the start. */
const TITLE_MS = 1200;
/** A page shows where things stood this long, then plays the last turn. */
const ARRIVE_MS = 600;
/** Turns shown before "Show earlier turns". */
const LOG_TURNS = 8;
/** While both choose, the call says something new this often. */
const SAY_S = 5;

/** How a finished battle ended, under the band that already names the winner: the turns, and the way it ended. */
function howItEnded(w: LinkBattle): string {
  const e = w.ended;
  if (!e) return "";
  const how = e.reason === "knockout" ? "by knockout" : e.reason === "forfeit" ? (e.message ? `: ${e.message.replace(/\.$/, "")}` : "by forfeit") : e.reason === "draw" ? "at the turn cap" : e.message ? `: ${e.message.replace(/\.$/, "")}` : "";
  return `${w.turn} turns${how.startsWith(":") ? how : ` ${how}`}`.trim() + ".";
}

export interface LinkStageProps {
  initial: LinkBattle;
  poll?: boolean;
  screens?: boolean;
  at?: number;
  fromStart?: boolean;
  /** The lobby's featured stage and the embed: the scorebar, the arena, the call and a few turns. */
  compact?: boolean;
  /** Turns shown under a compact stage. */
  feed?: number;
  /** Another battle to watch once this one's over. */
  next?: { href: string; label: string } | null;
  /** Each game side's record, in a few words ("3–1 rated"). */
  records?: [string | null, string | null] | null;
  /** More for the call to say while both choose (a rematch, say): public facts, written by the page. */
  context?: string[];
}

/** The stage, with both Game Boys' screens when they may be shown (never on the sample, which has no films). */
export function LinkStage({ initial, poll = true, screens = true, at, fromStart = false, compact = false, feed = 1, next, records = null, context }: LinkStageProps) {
  const [w, setW] = useState(initial);
  // Pinned (a turn's link, from the start): the stage stays where the page put it until the screens move it.
  const pinned = at !== undefined || fromStart;
  const firstNewest = initial.spectator?.turns.at(-1)?.turn ?? 0;
  // Every page opens a turn back and plays it: a turn's link the turn before its own, a battle the turn before its latest.
  const [shown, setShown] = useState<Shown>(
    at !== undefined ? { turn: Math.max(0, at - 1), done: true } : fromStart ? { turn: 0, done: false } : firstNewest >= 1 ? { turn: firstNewest - 1, done: true } : null,
  );
  const [seek, setSeek] = useState<number | undefined>(undefined);
  const [allTurns, setAllTurns] = useState(false);
  const [paused, setPaused] = useState(false);
  // Catching up on a live battle from its start runs fast, to reach it.
  const [speed, setSpeed] = useState(fromStart && initial.live ? 2 : 1);
  // The screens lead once they're playing (a live practice, or someone pressed play): the stage then only echoes them.
  const [screensLead, setScreensLead] = useState(false);
  const leading = useRef(false);
  const follow = (x: Shown) => {
    leading.current = Boolean(x);
    setScreensLead(Boolean(x));
    if (x) setShown(x);
    else if (!pinned) setShown(null);
  };
  const drivenByScreens = screens && w.screens;
  const still = useReducedMotion();
  const [title, setTitle] = useState(fromStart && !(screens && initial.screens));
  const [onscreen, setOnscreen] = useState(true);
  const [docked, setDocked] = useState(false);
  const visible = useRef(true);
  const ref = useRef<HTMLDivElement>(null);
  const arenaRef = useRef<HTMLDivElement>(null);
  const live = w.live;
  const sound = useSound();

  // Arriving: after a moment where things stood, the last turn plays (unless the screens have taken the lead).
  const arrive = () => {
    if (!leading.current) setShown(at !== undefined ? { turn: at, done: true } : null);
  };
  useEffect(() => {
    if (fromStart) return;
    const t = setTimeout(arrive, ARRIVE_MS);
    return () => clearTimeout(t);
  }, []);
  /** A turn's link: play its turn again. */
  const again = () => {
    if (at === undefined) return;
    setShown({ turn: Math.max(0, at - 1), done: true });
    setTimeout(arrive, ARRIVE_MS);
  };

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
  const director = useDirector({ s, upTo, sides: stageSides, labels, echo: screensLead || speed === 2, still });
  // What the feed, the chart and the score take in: the turn playing only once it has played.
  const settledTo = director.busy ? Math.max(0, upTo - 1) : upTo;
  const koLanded = director.landed.some((b) => b.kind === "faint");
  const teams = useMemo(() => teamsAt(s, director.playing && !koLanded ? Math.max(0, upTo - 1) : behind ? upTo : null), [s, director.playing, koLanded, upTo, behind]);
  const score = scoreOf(teams);
  const points = useMemo(() => momentum(s), [s]);
  const stories = useMemo(() => new Map((s?.turns ?? []).map((t) => [t.turn, storyOf(t.lines, labels)])), [s, labels]);
  const marks = useMemo(() => highlights(s, labels, left), [s, labels, left]);
  // The result is held back while a replay hasn't reached it (a turn's link, from the start, a page still arriving).
  const holdResult = !live && behind;
  const over = !live && !holdResult && !director.busy;

  // From the start without screens to follow: each turn plays, holds (longer after a knockout or a change of lead), and
  // the next comes; paused, it waits.
  useEffect(() => {
    if (!fromStart || drivenByScreens || paused || title || director.busy) return;
    if (!shown || shown.turn >= newest) {
      if (shown && w.live) setShown(null);
      return;
    }
    const big = marks.some((m) => m.turn === shown.turn && m.kind !== "double");
    const hold = shown.turn <= 0 ? HOLD_MS : big ? HOLD_BIG_MS : HOLD_MS;
    const t = setTimeout(() => setShown({ turn: shown.turn + 1, done: true }), speed === 2 ? hold / 2 : hold);
    return () => clearTimeout(t);
  }, [fromStart, drivenByScreens, paused, title, director.busy, shown, newest, w.live, speed, marks]);

  // One timer for both sides while they choose: counted from when this page saw the turn open, never per side. A turn
  // already open when the page arrived shows no time (the page doesn't know how long it's been).
  const firstTurn = useRef(w.turn);
  const openedAt = useRef<{ turn: number; at: number }>({ turn: w.turn, at: Date.now() });
  if (openedAt.current.turn !== w.turn) openedAt.current = { turn: w.turn, at: Date.now() };
  const sawOpen = w.turn !== firstTurn.current;
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
  const hadScreens = useRef(w.screens);
  const screensFresh = w.screens && !hadScreens.current;

  const winner = over && w.ended && w.ended.reason !== "void" && w.ended.winner !== null ? w.ended.winner : null;
  const result = (side: 0 | 1) => (winner === null ? null : winner === side ? "winner" : "loser");
  const shownTurn = director.busy && director.now ? director.now.turn : upTo;
  const talk = new Map<string, string>(w.lines.map((l) => [`${l.turn}:${l.side}`, l.line]));
  const rated = w.kind !== "practice";
  const turnLink = rated && !compact ? (t: number) => `/link/match/${w.match}/turn/${t}` : null;
  const settledTurns = (s?.turns ?? []).filter((t) => t.turn <= settledTo).reverse();
  const listed = compact ? settledTurns.slice(0, feed) : allTurns ? settledTurns : settledTurns.slice(0, LOG_TURNS);
  const shownMarks = marks.filter((m) => m.turn <= settledTo);
  const domain = over ? Math.max(1, newest) : Math.max(12, settledTo + 2);
  const display = director.display;
  const pill = live ? "live" : holdResult || director.busy ? "replay" : "final";
  const pillText = live && !behind && !director.busy ? `Live · turn ${w.turn + 1}` : pill === "final" ? `Final · ${w.turn} turns` : `${live ? "Live" : "Replay"} · ${shownTurn <= 0 ? "the opening" : `turn ${shownTurn}`}`;
  const deficit = winner === null ? 0 : deepestDeficit(s, winner);
  // All the HP left, as the stage shows it now: the rope across the scorebar.
  const hpNow: [number, number] | null = display ? [teamHp(teams[left], display[left]), teamHp(teams[right], display[right])] : null;
  const edge = hpNow ? edgeOf(hpNow[0], hpNow[1]) : null;
  const [pick, choose] = usePick(w.match);

  // What the call says while both choose: where it stands, then the run of play, then the page's own context, and one
  // line about the viewer's call. The same for both sides, from what's public; never anything about a decision.
  const says = useMemo(() => {
    if (!display || !hpNow) return [];
    const pool = [...situation([names[left], names[right]], [score[left], score[right]], [display[left], display[right]], hpNow), ...colour(s, names, labels, teams, w.clocks), ...(context ?? [])];
    if (pick && hpNow[0] !== hpNow[1]) {
      const ahead = hpNow[0] > hpNow[1] ? left : right;
      pool.splice(Math.min(2, pool.length), 0, `Your call, ${names[pick.side]}, is ${ahead === pick.side ? "ahead" : "behind"} on HP.`);
    }
    return pool;
  }, [display, hpNow?.[0], hpNow?.[1], s, teams, pick, context, w.clocks]);

  // A live battle keeps its score in the tab's title; a tab in the background says when a turn has played.
  const [cue, setCue] = useState("");
  // Set on every render while live (the page re-renders each second): the site's own title can be put back after this
  // page first sets its own, so it's checked again rather than set once.
  const titleWas = useRef<string | null>(null);
  useEffect(() => {
    if (compact) return;
    if (!live) {
      if (titleWas.current !== null) document.title = titleWas.current;
      titleWas.current = null;
      return;
    }
    const want = `${cue}${score[left]}–${score[right]} · ${names[left]} v ${names[right]} · LIVE`;
    if (document.title === want) return;
    if (titleWas.current === null) titleWas.current = document.title;
    document.title = want;
  });
  useEffect(
    () => () => {
      if (titleWas.current !== null) document.title = titleWas.current;
    },
    [],
  );
  useEffect(() => {
    const clear = () => (document.hidden ? undefined : setCue(""));
    document.addEventListener("visibilitychange", clear);
    return () => document.removeEventListener("visibilitychange", clear);
  }, []);
  const cued = useRef(settledTo);
  useEffect(() => {
    if (settledTo > cued.current && live && document.hidden) setCue((stories.get(settledTo) ?? []).some((l) => l.kind === "faint") ? "KO · " : `● Turn ${settledTo} · `);
    cued.current = settledTo;
  }, [settledTo, live, stories]);

  // Sound, for whoever turned it on: each beat as it lands; with the screens leading, a turn as it settles; the end.
  const beatKey = director.now ? `${director.now.key}:${director.now.phase}` : null;
  useEffect(() => {
    const n = director.now;
    if (!n || n.phase !== "impact") return;
    const b = n.step.beat;
    if (b.kind === "move") sound.play(b.chips.includes("missed") || b.chips.includes("immune") ? "miss" : b.chips.includes("crit") ? "crit" : b.chips.includes("resisted") ? "soft" : "hit");
    else if (b.kind === "switch") sound.play("switch");
    else if (b.kind === "faint") sound.play("ko");
  }, [beatKey]);
  const sounded = useRef(settledTo);
  useEffect(() => {
    // With the screens leading, the game's own sound plays (in each turn's film): no tones over it.
    if (settledTo > sounded.current && speed === 2 && !screensLead) sound.play((stories.get(settledTo) ?? []).some((l) => l.kind === "faint") ? "ko" : "turn");
    sounded.current = settledTo;
  }, [settledTo]);
  useEffect(() => {
    if (over && winner !== null && !screensLead) sound.play("win");
  }, [over]);

  // The turn on the stage in a sentence, for when nothing's playing: its knockout, its biggest hit, its last move.
  const played = upTo >= 1 ? turnCall(stories.get(upTo) ?? []) : null;
  const pool = ["Both sides are choosing.", ...says];
  const call = director.now
    ? director.now.step.beat.text
    : choosing
      ? // The turn the screens just played, then something new every few seconds while they think.
        screensLead && sawOpen && played && choosingFor < SAY_S
        ? played
        : (pool[Math.floor(choosingFor / SAY_S) % pool.length] ?? pool[0]!)
      : over
        ? ""
        : upTo <= 0
          ? "The opening."
          : (played ?? `After turn ${upTo}.`);

  const said = (side: 0 | 1) => {
    const text = upTo >= 1 ? talk.get(`${upTo}:${side}`) : undefined;
    return text ? { key: `${upTo}:${side}`, text } : null;
  };

  const node = title ? (
    <span className="link-node-v">v</span>
  ) : (
    <>
      <span className="link-node-n">{choosing ? w.turn + 1 : Math.max(0, shownTurn) || "–"}</span>
      {choosing ? <span className="link-node-t">{sawOpen ? clockText(choosingFor) : "now"}</span> : <span className="link-node-t">{over ? "end" : shownTurn > 0 ? "turn" : "start"}</span>}
    </>
  );

  return (
    <div ref={ref} className={`link-show${compact ? " link-show-compact" : ""}`} data-onscreen={onscreen ? "" : undefined}>
      <Scorebar
        w={w}
        names={names}
        teams={teams}
        score={score}
        pill={pill}
        pillText={pillText}
        clocks={[clockText(w.clocks?.[0]), clockText(w.clocks?.[1])]}
        records={records}
        hp={display ? [display[0].hp_percent, display[1].hp_percent] : null}
        docked={docked}
        edge={edge}
        fighterLinks={rated && !compact}
        pick={pick && !compact ? pick.side : null}
      />

      {over && w.ended ? (
        <Final
          head={winner === null ? { text: w.ended.reason === "void" ? "No result" : "A draw" } : { name: names[winner], won: true }}
          tone={winner === null ? null : winner === left ? "a" : "b"}
          sub={howItEnded(w)}
          ratings={([0, 1] as const).flatMap((x) => (w.ratingChanges?.[x] === null || w.ratingChanges?.[x] === undefined ? [] : [{ name: names[x], change: w.ratingChanges[x]! }]))}
          comeback={deficit >= 30 ? `Came back from ${deficit} down.` : null}
          called={!pick || winner === null ? null : `You called ${names[pick.side]} ${pick.turn <= 0 ? "before the first turn" : `on turn ${pick.turn}`}. ${pick.side === winner ? "Right." : "Not this time."}`}
          fresh={!still}
        >
          {!compact ? (
            <>
              {rated ? (
                <a className="link-btn link-btn-primary" href={`/link/match/${w.match}?from=start`}>
                  Watch from the start
                </a>
              ) : null}
              <Share w={w} names={names} />
              {next ? (
                <a className="link-btn link-final-next" href={next.href}>
                  {next.label}
                </a>
              ) : null}
            </>
          ) : null}
        </Final>
      ) : null}

      {/* Screens that came on as the battle ended wait for the end to play out, then power on under the result. */}
      {drivenByScreens && !(screensFresh && !over) ? (
        <LinkScreens
          match={w.match}
          turns={w.turn}
          live={live}
          left={left}
          names={names}
          onShow={follow}
          startTurn={at ?? (fromStart ? 0 : undefined)}
          autoplay={fromStart}
          seek={seek}
          fresh={screensFresh}
          call={screensLead ? call : ""}
          quiet={compact}
          sound={sound}
        />
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
          said={[said(0), said(1)]}
        />
      ) : null}

      {call || live ? (
        <p className={`link-call${director.now ? " link-call-beat" : ""}`} aria-live={choosing ? "off" : "polite"}>
          {choosing ? <span className="link-live-dot" aria-hidden="true" /> : null}
          <span key={call} className="link-call-text">
            {call}
          </span>
        </p>
      ) : null}

      {!compact && s ? (
        <div className="link-tools">
          {/* A call is for a battle whose end this page hasn't shown: live, or watched from the start. */}
          {!over && (live || fromStart) && at === undefined ? <Pick names={names} left={left} pick={pick} onPick={(side) => choose(side, w.live ? w.turn + 1 : upTo)} /> : null}
          {at !== undefined && !director.busy ? (
            <button type="button" className="link-btn link-btn-small" onClick={again}>
              Play it again
            </button>
          ) : null}
          {live && !fromStart && rated && w.turn >= 3 ? (
            <a className="link-btn link-btn-small" href={`/link/match/${w.match}?from=start`}>
              Catch up from turn 1
            </a>
          ) : null}
          <button type="button" className="link-btn link-btn-small link-sound" aria-pressed={sound.on} onClick={sound.toggle} title="A few short tones as each turn lands. Off until you turn it on.">
            <Icon d={sound.on ? "sound" : "mute"} />
            {sound.on ? "Sound on" : "Sound off"}
          </button>
        </div>
      ) : null}

      {fromStart && !drivenByScreens && !compact ? (
        <Transport
          label={upTo <= 0 ? "The opening" : holdResult || live ? `Turn ${upTo}${live ? ` of ${newest}, catching up` : ""}` : `Turn ${upTo} of ${newest}`}
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

      {!compact && s ? <Bench teams={teams} left={left} names={names} /> : null}

      {screens && !w.screens && !compact ? <p className="link-screens-later">The Game Boy screens unlock when it ends.</p> : null}

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
