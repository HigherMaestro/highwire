"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { battleRatings, fromAnswer, type LinkBattle, type LinkSide } from "../../lib/link/battle.ts";
import { momentum, monogram, scoreOf, storyOf, teamsAt, turnMoment, type Pip, type StoryLine } from "../../lib/link/story.ts";
import { LinkScreens, type Shown } from "./LinkScreens.tsx";

// A link battle on the stage (docs/link-battles.md 13.2), built to be watched: a scorebar with both teams and the score
// in Pokémon left; the two Pokémon out, their HP as the game's bars, with each turn's hit, critical hit and faint played
// as a moment; one "choosing" timer for both sides alike (never which side has decided); both Game Boys' screens when
// they may be shown; the momentum of the fight turn by turn; and every turn as a card, each side's doings in its colour.
//
// Live, it asks the referee every 2 seconds (one cached spectator view for everyone). With the screens, the stage follows
// them: each turn's HP and lines arrive as its footage plays to the end. `at` pins it after one turn (a turn's link);
// `fromStart` plays it from the opening with the result held back (?from=start). Reduced motion: every moment is a plain
// change of state.

const POLL_MS = 2000;
/** Without screens to follow, a battle watched from the start moves on a turn at a time: this long a turn, half while behind live. */
const REPLAY_MS = 2500;
/** Turns shown before "Show earlier turns". */
const LOG_TURNS = 8;

/** How a finished battle ended, under the banner that already names the winner: the turns, and the way it ended. */
function howItEnded(w: LinkBattle): string {
  const e = w.ended;
  if (!e) return "";
  const how = e.reason === "knockout" ? "by knockout" : e.reason === "forfeit" ? (e.message ? `: ${e.message.replace(/\.$/, "")}` : "by forfeit") : e.reason === "draw" ? "at the turn cap" : e.message ? `: ${e.message.replace(/\.$/, "")}` : "";
  return `${w.turn} turns${how.startsWith(":") ? how : ` ${how}`}`.trim() + ".";
}

const clockText = (c: number | null | undefined) => (c === null || c === undefined ? null : `${Math.floor(c / 60)}:${String(c % 60).padStart(2, "0")}`);

function Pips({ pips, tone }: { pips: Pip[]; tone: "a" | "b" }) {
  return (
    <span className={`link-pips link-pips-${tone}`} aria-hidden="true">
      {pips.map((p, i) => (
        <span key={i} className={`link-pip${p.species ? "" : " link-pip-unseen"}${p.fainted ? " link-pip-fainted" : ""}${p.active ? " link-pip-active" : ""}`} title={p.species ?? "Not seen yet"}>
          {monogram(p.species)}
          {p.species && !p.fainted ? <span className="link-pip-hp" style={{ width: `${p.hp}%` }} /> : null}
        </span>
      ))}
    </span>
  );
}

/** The bar across the top: both names, their teams, the score, the turn, and whether it's live. */
function Scorebar({ w, names, teams, score, turnLabel, holdResult }: { w: LinkBattle; names: [string, string]; teams: [Pip[], Pip[]]; score: [number, number]; turnLabel: string; holdResult: boolean }) {
  const l = w.left, r = (1 - w.left) as 0 | 1;
  return (
    <div className="link-scorebar" role="group" aria-label={`${names[l]} ${score[l]}, ${names[r]} ${score[r]} Pokémon left, ${turnLabel}${w.live ? ", live" : ""}`}>
      <div className="link-sb-side link-sb-a">
        <span className="link-sb-name" title="A coin's name, chosen by its creator">
          {names[l]}
        </span>
        <Pips pips={teams[l]} tone="a" />
      </div>
      <div className="link-sb-mid" aria-hidden="true">
        <span className="link-sb-score">
          {score[l]}
          <span className="link-sb-dash">–</span>
          {score[r]}
        </span>
        <span className="link-sb-turn">{turnLabel}</span>
      </div>
      <div className="link-sb-side link-sb-b">
        <span className="link-sb-name" title={w.sides[r].house ? "Highwire's house fighter" : "A coin's name, chosen by its creator"}>
          {names[r]}
        </span>
        <Pips pips={teams[r]} tone="b" />
      </div>
      <span className={`link-sb-pill ${w.live ? "link-sb-live" : "link-sb-final"}`}>{w.live ? "Live" : holdResult ? "Replay" : "Final"}</span>
    </div>
  );
}

type Moment = { crit: boolean; super: boolean; fainted: boolean };

/** One side's Pokémon out: species, its HP bar with the turn's damage as a moment, status, clock, and how it ended. */
function Card({ side, who, tone, exact, clock, moment, delta, result }: { side: LinkSide; who: string; tone: "a" | "b"; exact: boolean; clock: string | null; moment: Moment | null; delta: number | null; result: "winner" | "loser" | null }) {
  const pct = Math.max(0, Math.min(100, side.hp_percent));
  const band = pct > 50 ? "ok" : pct > 20 ? "low" : "red";
  const out = pct <= 0;
  const hit = delta !== null && delta < 0;
  const cls = ["link-fighter", `link-fighter-${tone}`, out ? "link-fighter-out" : "", result ? `link-fighter-${result}` : "", moment?.crit ? "link-fighter-crit" : ""].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <div className="link-fighter-top">
        <span className="link-fighter-who">{who}</span>
        {result === "winner" ? <span className="link-fighter-tag">Winner</span> : null}
        {clock ? (
          <span className="link-fighter-clock" title="Its clock for the whole battle, as this turn opened">
            {clock}
          </span>
        ) : null}
      </div>
      <h3 className="link-fighter-mon">{side.species}</h3>
      <div className="link-bar-row">
        <div className="link-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${who}'s ${side.species}'s HP`}>
          {hit ? <span key={`g${pct}`} className="link-bar-ghost" style={{ width: `${Math.min(100, pct - delta!)}%` }} /> : null}
          <span className={`link-bar-fill link-bar-${band}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="link-bar-pct">{exact && side.max_hp ? `${side.hp}/${side.max_hp}` : `${pct}%`}</span>
        {hit ? (
          <span key={`d${pct}`} className={`link-delta${moment?.super ? " link-delta-super" : ""}`} aria-hidden="true">
            {delta}%
          </span>
        ) : null}
      </div>
      {side.status || side.field.length || out ? (
        <p className="link-chips">
          {out ? <span className="link-chip link-chip-out">fainted</span> : null}
          {side.status ? <span className="link-chip link-chip-status">{side.status}</span> : null}
          {side.field.map((f) => (
            <span key={f} className="link-chip">
              {f}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

/** Both teams' HP turn by turn: the shape of the fight. Over, with the screens, a click opens that turn. */
function Momentum({ points, upTo, names, left, onSeek }: { points: { turn: number; hp: [number, number] }[]; upTo: number; names: [string, string]; left: 0 | 1; onSeek?: (turn: number) => void }) {
  if (points.length < 2) return null;
  const shown = points.filter((p) => p.turn <= upTo);
  const W = 600, H = 64, n = points.length - 1;
  const x = (i: number) => (i / n) * W;
  const y = (hp: number) => 6 + (1 - hp / 100) * (H - 12);
  const path = (s: 0 | 1) => shown.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.hp[s]).toFixed(1)}`).join(" ");
  const last = shown.at(-1) ?? points[0]!;
  const right = (1 - left) as 0 | 1;
  return (
    <figure className="link-momentum">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Both teams' HP over ${n} turns: ${names[0]} ${last.hp[left]}%, ${names[1]} ${last.hp[right]}%`}>
        <line x1="0" x2={W} y1={y(50)} y2={y(50)} className="link-mo-mid" />
        <path d={path(left)} className="link-mo-a" />
        <path d={path(right)} className="link-mo-b" />
        {onSeek
          ? points.map((p, i) => (
              <rect key={p.turn} x={x(i) - W / n / 2} y={0} width={W / n} height={H} className="link-mo-hit" onClick={() => onSeek(p.turn)}>
                <title>{p.turn ? `Turn ${p.turn}` : "The opening"}</title>
              </rect>
            ))
          : null}
      </svg>
      <figcaption className="muted small">
        <span className="link-mo-key link-mo-key-a">{names[0]}</span> <span className="link-mo-key link-mo-key-b">{names[1]}</span> · each team&apos;s HP, turn by turn
        {onSeek ? ". Click a turn to watch it." : "."}
      </figcaption>
    </figure>
  );
}

/** Share: the link, the spoiler-free link, X, and (rated) the embed. */
function Share({ w, names }: { w: LinkBattle; names: [string, string] }) {
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const rated = w.kind !== "practice";
  const page = () => `${window.location.origin}${rated ? `/link/match/${w.match}` : `/link/practice/${w.match}`}`;
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setSaid(`${what} copied`);
    } catch {
      setSaid("Couldn't copy: use the address bar");
    }
    setTimeout(() => setSaid(null), 2500);
  };
  const title = `${names[w.left]} v ${w.sides[1 - w.left]!.house ? "the house" : names[1 - w.left]}`;
  const post = () => `https://x.com/intent/post?text=${encodeURIComponent(`${title}: AI agents in a real Game Boy link battle`)}&url=${encodeURIComponent(rated ? `${page()}?from=start` : page())}`;
  return (
    <span className="link-share">
      <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        Share
      </button>
      {open ? (
        <span className="link-share-menu">
          <button type="button" onClick={() => copy(page(), "Link")}>
            Copy link
          </button>
          {rated ? (
            <button type="button" onClick={() => copy(`${page()}?from=start`, "Spoiler-free link")}>
              Copy link without the result
            </button>
          ) : null}
          <a href="#" onClick={(e) => (e.preventDefault(), window.open(post(), "_blank", "noopener,noreferrer"))}>
            Post on X ↗
          </a>
          {rated ? (
            <button type="button" onClick={() => copy(`<iframe src="${page()}/embed" width="720" height="560" style="border:0" title="${title.replace(/["<>&]/g, "")}"></iframe>`, "Embed code")}>
              Copy embed code
            </button>
          ) : null}
        </span>
      ) : null}
      <span className="link-share-said" role="status">
        {said ?? ""}
      </span>
    </span>
  );
}

const CHIP = { crit: "Critical hit", super: "Super effective", resisted: "Not very effective", immune: "No effect", missed: "Missed" } as const;

/** One turn as a card: table talk as bubbles, then each side's doings in its colour, with what came of each move. */
function TurnCard({ turn, lines, talk, names, left, after, link, highlight }: { turn: number; lines: StoryLine[]; talk: [string | null, string | null]; names: [string, string]; left: 0 | 1; after?: [LinkSide, LinkSide]; link: string | null; highlight: boolean }) {
  const tone = (s: 0 | 1) => (s === left ? "a" : "b");
  const order = [left, (1 - left) as 0 | 1] as const;
  return (
    <li className={`link-turn${highlight ? " link-turn-this" : ""}`} id={`turn-${turn}`}>
      <div className="link-turn-head">
        <span className="link-turn-n">Turn {turn}</span>
        {after ? (
          <span className="link-turn-bars" aria-hidden="true">
            {order.map((s) => (
              <span key={s} className={`link-mini link-mini-${tone(s)}`}>
                <span style={{ width: `${after[s].hp_percent}%` }} />
              </span>
            ))}
          </span>
        ) : null}
        {link ? (
          <a className="link-turn-link" href={link} aria-label={`A link to turn ${turn}`} title="A link to this turn">
            #
          </a>
        ) : null}
      </div>
      {order.map((s) =>
        talk[s] ? (
          <p key={`t${s}`} className={`link-bubble link-bubble-${tone(s)}`}>
            <span className="link-bubble-who">{names[s]}&apos;s agent said</span>
            {talk[s]}
          </p>
        ) : null,
      )}
      {lines.length ? (
        <ul className="link-lines">
          {lines.map((l, i) => (
            <li key={i} className={`link-line link-line-${l.kind}${l.side === null ? "" : ` link-line-${tone(l.side)}`}`}>
              <span>{l.text}</span>
              {l.chips.map((c) => (
                <span key={c} className={`link-tag link-tag-${c}`}>
                  {CHIP[c]}
                </span>
              ))}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Nothing happened.</p>
      )}
    </li>
  );
}

/** The stage, with both Game Boys' screens when they may be shown (never on the sample, which has no films). */
export function LinkStage({ initial, poll = true, screens = true, at, fromStart = false, compact = false }: { initial: LinkBattle; poll?: boolean; screens?: boolean; at?: number; fromStart?: boolean; compact?: boolean }) {
  const [w, setW] = useState(initial);
  // Pinned (a turn's link, from the start): the stage stays where the page put it until the screens move it.
  const pinned = at !== undefined || fromStart;
  const [shown, setShown] = useState<Shown>(at !== undefined ? { turn: at, done: true } : fromStart ? { turn: 0, done: false } : null);
  const [seek, setSeek] = useState<number | undefined>(undefined);
  const [allTurns, setAllTurns] = useState(false);
  const follow = (x: Shown) => (x ? setShown(x) : pinned ? undefined : setShown(null));
  const drivenByScreens = screens && w.screens;
  const visible = useRef(true);
  const ref = useRef<HTMLDivElement>(null);
  const live = w.live;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => (visible.current = Boolean(e?.isIntersecting)), { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

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

  // From the start without screens to follow: a turn at a time, faster while behind.
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
  const names: [string, string] = [w.sides[0].house ? "The house" : w.sides[0].name, w.sides[1].house ? "The house" : w.sides[1].name];
  const labels = useMemo(() => [`${w.sides[0].name}'s`, `${w.sides[1].name}'s`] as [string, string], [w.sides]);
  const newest = s?.turns.at(-1)?.turn ?? 0;
  const upTo = shown ? Math.min(newest, shown.done ? shown.turn : shown.turn - 1) : newest;
  const behind = upTo < newest;
  // The battle as the screens (or the replay) have shown it: up to the turn on screen, that turn too once it's played.
  const stage = useMemo(() => {
    if (!s) return null;
    const sides = upTo >= newest ? s.sides : upTo <= 0 ? s.start : s.turns.find((t) => t.turn === upTo)?.after;
    if (!sides) return { sides: s.sides, turns: s.turns };
    return { sides, turns: s.turns.filter((t) => t.turn <= upTo) };
  }, [s, upTo, newest]);
  const teams = useMemo(() => teamsAt(s, behind ? upTo : null), [s, behind, upTo]);
  const score = scoreOf(teams);
  const points = useMemo(() => momentum(s), [s]);
  const stories = useMemo(() => new Map((s?.turns ?? []).map((t) => [t.turn, storyOf(t.lines, labels)])), [s, labels]);
  // The result is held back while a replay hasn't reached it (a turn's link, from the start).
  const holdResult = !live && behind;
  const over = !live && !holdResult;

  // The turn just shown, as a moment on the cards: the damage, a critical hit, a faint. Only when it moves forward.
  const lastShown = useRef<{ upTo: number; sides: [LinkSide, LinkSide] | null }>({ upTo, sides: stage?.sides ?? null });
  const [moment, setMoment] = useState<{ delta: [number | null, number | null]; m: [Moment, Moment] } | null>(null);
  useEffect(() => {
    const prev = lastShown.current;
    const cur = stage?.sides ?? null;
    lastShown.current = { upTo, sides: cur };
    if (!cur || !prev.sides || upTo <= prev.upTo) return;
    const delta = ([0, 1] as const).map((x) => (cur[x].species === prev.sides![x].species ? cur[x].hp_percent - prev.sides![x].hp_percent : null)) as [number | null, number | null];
    setMoment({ delta, m: turnMoment(stories.get(upTo) ?? []) });
    const t = setTimeout(() => setMoment(null), 1600);
    return () => clearTimeout(t);
  }, [upTo, stage, stories]);

  // One timer for both sides while they choose: counted from when this page first saw the turn open, never per side.
  const openedAt = useRef<{ turn: number; at: number }>({ turn: w.turn, at: Date.now() });
  if (openedAt.current.turn !== w.turn) openedAt.current = { turn: w.turn, at: Date.now() };
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  const choosing = Math.max(0, Math.floor((Date.now() - openedAt.current.at) / 1000));

  const winner = over && w.ended && w.ended.reason !== "void" && w.ended.winner !== null ? w.ended.winner : null;
  const result = (side: 0 | 1) => (winner === null ? null : winner === side ? "winner" : "loser");
  const turnLabel = live && !behind ? `Turn ${w.turn + 1}` : upTo <= 0 ? "Opening" : `Turn ${upTo}`;
  const talk = new Map<string, string>(w.lines.map((l) => [`${l.turn}:${l.side}`, l.line]));
  const rated = w.kind !== "practice";
  const turnsShown = [...(stage?.turns ?? [])].reverse();
  const listed = compact ? turnsShown.slice(0, 2) : allTurns ? turnsShown : turnsShown.slice(0, LOG_TURNS);

  return (
    <div ref={ref} className={`link-show${compact ? " link-show-compact" : ""}`}>
      <Scorebar w={w} names={names} teams={teams} score={score} turnLabel={turnLabel} holdResult={holdResult} />

      {over && w.ended ? (
        <section className={`link-result${winner === null ? "" : winner === left ? " link-result-a" : " link-result-b"}`} aria-label="How it ended">
          <p className="link-result-head">{winner === null ? (w.ended.reason === "void" ? "No result" : "A draw") : `${names[winner]} wins`}</p>
          <p className="link-result-sub">
            {howItEnded(w)}
            {battleRatings(w) ? <span className="link-result-ratings"> {battleRatings(w)}</span> : null}
          </p>
          {!compact ? (
            <p className="link-result-actions">
              {rated ? (
                <a className="link-btn link-btn-primary" href={`/link/match/${w.match}?from=start`}>
                  Watch from the start
                </a>
              ) : null}
              <Share w={w} names={names} />
            </p>
          ) : null}
        </section>
      ) : null}

      {drivenByScreens ? (
        <LinkScreens match={w.match} turns={w.turn} live={live} left={left} names={names} onShow={follow} startTurn={at ?? (fromStart ? 0 : undefined)} autoplay={fromStart} seek={seek} />
      ) : null}

      {s && stage ? (
        <div className={`link-arena${moment ? " link-arena-turn" : ""}`}>
          <Card side={stage.sides[left]} who={names[left]} tone="a" exact={!s.live} clock={clockText(w.clocks?.[left])} moment={moment?.m[left] ?? null} delta={moment?.delta[left] ?? null} result={result(left)} />
          <div className="link-cable" aria-hidden="true">
            <span key={upTo} className="link-cable-pulse" />
          </div>
          <Card side={stage.sides[right]} who={names[right]} tone="b" exact={!s.live} clock={clockText(w.clocks?.[right])} moment={moment?.m[right] ?? null} delta={moment?.delta[right] ?? null} result={result(right)} />
        </div>
      ) : null}

      <p className="link-status" aria-live="polite">
        {live && !behind ? (
          <>
            <span className="arena-dot-live" aria-hidden="true" /> Turn {w.turn + 1} · both sides choosing
            <span className="link-dots" aria-hidden="true" />
            <span className="link-status-time">{clockText(choosing)}</span>
          </>
        ) : behind ? (
          <>
            {upTo <= 0 ? "The opening" : `After turn ${upTo}`}
            {live ? ", catching up to the battle" : " · the result shows when it's reached"}
          </>
        ) : null}
      </p>

      {screens && !w.screens && !compact ? <p className="link-screens-later muted small">Both Game Boys&apos; screens appear here when the battle ends: each shows its own side&apos;s exact HP and PP.</p> : null}

      {!compact && points.length > 1 ? <Momentum points={points} upTo={upTo} names={[names[left], names[right]]} left={left} onSeek={!live && drivenByScreens ? setSeek : undefined} /> : null}

      <ol className="link-turns" aria-label="Every turn, newest first" aria-live="polite" aria-relevant="additions">
        {listed.map((t) => (
          <TurnCard
            key={t.turn}
            turn={t.turn}
            lines={stories.get(t.turn) ?? []}
            talk={[talk.get(`${t.turn}:0`) ?? null, talk.get(`${t.turn}:1`) ?? null]}
            names={names}
            left={left}
            after={t.after}
            link={rated && !compact ? `/link/match/${w.match}/turn/${t.turn}` : null}
            highlight={at === t.turn}
          />
        ))}
      </ol>
      {!allTurns && !compact && turnsShown.length > LOG_TURNS ? (
        <button type="button" className="link-btn link-more" onClick={() => setAllTurns(true)}>
          Show the {turnsShown.length - LOG_TURNS} earlier turns
        </button>
      ) : null}
    </div>
  );
}
