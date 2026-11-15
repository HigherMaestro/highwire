"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { LinkBattle, LinkSide } from "../../lib/link/battle.ts";
import { leadSeries, monogram, type Chip, type Highlight, type Pip, type Step, type StoryLine } from "../../lib/link/story.ts";
import { Sigil } from "./Sigil.tsx";

// The stage's parts (docs/link-battles.md 14.11), drawn from what the director (useDirector.ts) says is on: the scorebar,
// the two corners with the cable between them, the call, the tug of war, the highlights, the play-by-play and the
// result. Motion is CSS keyed to the beat, and the Web Animations API for a corner's recoil; under reduced motion the
// director plays nothing and the CSS turns every animation off, so each change is a plain change of state.

export const clockText = (c: number | null | undefined) => (c === null || c === undefined ? null : `${Math.floor(c / 60)}:${String(c % 60).padStart(2, "0")}`);

export const CHIP: Record<Chip, string> = { crit: "Critical hit", super: "Super effective", resisted: "Not very effective", immune: "No effect", missed: "Missed" };

/** A number that counts to its new value over the bar's drain, instead of jumping. */
function useCount(value: number, ms = 520): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    if (start === value || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      from.current = value;
      return setShown(value);
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      const v = Math.round(start + (value - start) * eased);
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

/** A digit that rolls in when it changes (the score). */
function Roll({ value }: { value: number }) {
  return (
    <span className="link-roll">
      <span key={value} className="link-roll-in">
        {value}
      </span>
    </span>
  );
}

function Pips({ pips, tone }: { pips: Pip[]; tone: "a" | "b" }) {
  return (
    <span className={`link-pips link-pips-${tone}`} aria-hidden="true">
      {pips.map((p, i) => (
        <span key={i} className={`link-pip${p.species ? "" : " link-pip-unseen"}${p.fainted ? " link-pip-fainted" : ""}${p.active ? " link-pip-active" : ""}`} title={p.species ?? "Not seen yet"}>
          <span className="link-pip-m">{monogram(p.species)}</span>
          {p.species && !p.fainted ? <span className="link-pip-hp" style={{ transform: `scaleX(${p.hp / 100})` }} /> : null}
        </span>
      ))}
    </span>
  );
}

/** The bar across the top: both fighters (their sigils, names, teams), the score in Pokémon left, live or final and the turn, and the rope: each side's share of all the HP left. */
export function Scorebar({ w, names, teams, score, pill, pillText, clocks, records, hp, docked, edge, fighterLinks, pick }: { w: LinkBattle; names: [string, string]; teams: [Pip[], Pip[]]; score: [number, number]; pill: "live" | "replay" | "final"; pillText: string; clocks: [string | null, string | null]; records: [string | null, string | null] | null; hp: [number, number] | null; docked: boolean; edge: number | null; fighterLinks: boolean; pick: 0 | 1 | null }) {
  const l = w.left, r = (1 - w.left) as 0 | 1;
  const side = (x: 0 | 1, tone: "a" | "b") => (
    <div className={`link-sb-side link-sb-${tone}`}>
      <span className="link-sb-who">
        <Sigil id={w.sides[x].house ? null : w.sides[x].fighter} />
        {fighterLinks && w.sides[x].fighter ? (
          <a className="link-sb-name" href={`/line/fighter/${w.sides[x].fighter}`} title="A coin's name, chosen by its creator. Its record and battles.">
            {names[x]}
          </a>
        ) : (
          <span className="link-sb-name" title={w.sides[x].house ? "Highwire's house fighter" : "A coin's name, chosen by its creator"}>
            {names[x]}
          </span>
        )}
        {pick === x ? <span className="link-sb-call">Your call</span> : null}
      </span>
      <span className="link-sb-row">
        <Pips pips={teams[x]} tone={tone} />
        {records?.[x] ? <span className="link-sb-record">{records[x]}</span> : null}
        {clocks[x] ? (
          <span className="link-sb-clock" title="Its clock for the whole battle, as this turn opened">
            {clocks[x]}
          </span>
        ) : null}
      </span>
      {hp ? <span className="link-sb-hp" style={{ transform: `scaleX(${Math.max(0, hp[x]) / 100})` }} aria-hidden="true" /> : null}
    </div>
  );
  return (
    <div className="link-scorebar" data-docked={docked ? "" : undefined} role="group" aria-label={`${names[l]} ${score[l]}, ${names[r]} ${score[r]} Pokémon left, ${pillText}`}>
      {side(l, "a")}
      <div className="link-sb-mid" aria-hidden="true">
        <span className={`link-sb-pill link-sb-${pill}`}>{pillText}</span>
        <span className="link-sb-score">
          <Roll value={score[l]} />
          <span className="link-sb-dash">–</span>
          <Roll value={score[r]} />
        </span>
        <span className="link-sb-turn">Pokémon left</span>
      </div>
      {side(r, "b")}
      {edge !== null ? (
        <div className="link-rope" role="img" aria-label={`All the HP left: ${names[l]} ${edge}%, ${names[r]} ${100 - edge}%`}>
          <span className="link-rope-n">{edge}%</span>
          <span className="link-rope-track">
            <span className="link-rope-a" style={{ transform: `scaleX(${edge / 100})` }} />
            <span className="link-rope-b" style={{ transform: `scaleX(${(100 - edge) / 100})` }} />
            <span className="link-rope-knot" style={{ left: `${edge}%` }} />
          </span>
          <span className="link-rope-n">{100 - edge}%</span>
        </div>
      ) : null}
    </div>
  );
}

/** The bench: each side's three Pokémon by name, with its HP as last seen; one not shown yet says so. */
export function Bench({ teams, left, names }: { teams: [Pip[], Pip[]]; left: 0 | 1; names: [string, string] }) {
  const right = (1 - left) as 0 | 1;
  return (
    <div className="link-bench" role="group" aria-label="Both teams">
      {([left, right] as const).map((x, i) => (
        <ul key={x} className={`link-bench-side link-bench-${i ? "b" : "a"}`} aria-label={`${names[x]}'s team`}>
          {teams[x].map((p, k) => (
            <li key={k} className={`link-bench-row${p.fainted ? " link-bench-out" : ""}${p.active ? " link-bench-on" : ""}${p.species ? "" : " link-bench-unseen"}`}>
              <span className="link-bench-name">{p.species ?? "Not shown yet"}</span>
              {p.species ? (
                <>
                  <span className="link-bench-bar" aria-hidden="true">
                    <span style={{ transform: `scaleX(${p.fainted ? 0 : p.hp / 100})` }} />
                  </span>
                  <span className="link-bench-pct">{p.fainted ? "out" : `${p.hp}%`}</span>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- the arena

/** Where a knockout's pixels fly, in pixels from the corner's centre: sixteen, fixed, so every knockout looks alike. */
const BURST = Array.from({ length: 16 }, (_, i) => {
  const a = (i / 16) * Math.PI * 2 + (i % 2 ? 0.2 : -0.1);
  const d = 60 + ((i * 37) % 80);
  return { dx: Math.round(Math.cos(a) * d), dy: Math.round(Math.sin(a) * d * 0.7), white: i % 8 < 3 };
});

/** One side's Pokémon out: its name, its HP bar (draining behind a ghost), the callout of its move, a knockout's fall. */
function Corner({ side, who, tone, exact, result, attack, hit, fainting, compact, said }: { side: LinkSide; who: string; tone: "a" | "b"; exact: boolean; result: "winner" | "loser" | null; attack: { key: string; move: string; chips: Chip[]; impact: boolean } | null; hit: { key: string; amount: number; hp?: number; chips: Chip[] } | null; fainting: string | null; compact: boolean; said: { key: string; text: string } | null }) {
  const pct = Math.max(0, Math.min(100, side.hp_percent));
  const count = useCount(pct);
  const low = pct > 0 && pct <= 20;
  const out = pct <= 0;
  const ref = useRef<HTMLDivElement>(null);
  const sign = tone === "a" ? 1 : -1;
  // The hit lands: the corner recoils away from the cable (further on a critical hit), or sidesteps a miss.
  useEffect(() => {
    if (!hit || !ref.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const far = hit.chips.includes("crit") ? 16 : hit.chips.includes("resisted") ? 4 : 10;
    ref.current.animate([{ transform: "translateX(0)" }, { transform: `translateX(${-sign * far}px)` }, { transform: "translateX(0)" }], { duration: 420, easing: "cubic-bezier(.2,1.6,.4,1)" });
  }, [hit?.key]);
  // Its own move: it leans in toward the cable.
  useEffect(() => {
    if (!attack || attack.impact || !ref.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    ref.current.animate([{ transform: "translateX(0)" }, { transform: `translateX(${sign * 6}px)`, offset: 0.35 }, { transform: "translateX(0)" }], { duration: 340, easing: "cubic-bezier(.16,1,.3,1)" });
  }, [attack?.key]);
  const cls = ["link-corner", `link-corner-${tone}`, out ? "link-corner-out" : "", low ? "link-corner-low" : "", result ? `link-corner-${result}` : ""].filter(Boolean).join(" ");
  const fill = (p: number) => ({ transform: `translateX(${tone === "a" ? -(100 - p) : 100 - p}%)` });
  const big = hit?.chips.includes("crit") || hit?.chips.includes("super");
  return (
    <div ref={ref} className={cls}>
      {result === "winner" ? (
        <svg className="link-ring" aria-hidden="true">
          <rect pathLength={1} rx="22" ry="22" />
        </svg>
      ) : null}
      <div className="link-corner-top">
        <span className="link-corner-who">{who}</span>
        {result === "winner" ? <span className="link-corner-tag">Winner</span> : null}
      </div>
      <div className="link-callout-slot" aria-hidden="true">
        {attack ? (
          <span key={attack.key} className="link-callout">
            <span className="link-callout-move">{attack.move}</span>
            {attack.impact
              ? attack.chips.map((c, i) => (
                  <span key={c} className={`link-stamp link-stamp-${c}`} style={{ animationDelay: `${i * 70}ms` }}>
                    {CHIP[c]}
                  </span>
                ))
              : null}
          </span>
        ) : null}
      </div>
      <h3 className="link-corner-mon">
        {fainting ? (
          <span className="link-fall" aria-label={fainting}>
            {[...fainting].map((ch, i) => (
              <span key={i} style={{ animationDelay: `${i * 40}ms`, ["--rot" as string]: `${(i % 2 ? 1 : -1) * (8 + ((i * 5) % 7))}deg` }}>
                {ch === " " ? " " : ch}
              </span>
            ))}
          </span>
        ) : (
          <span key={side.species} className="link-corner-name">
            {side.species}
          </span>
        )}
      </h3>
      <div className="link-hp">
        <div className="link-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${who}'s ${side.species}'s HP`}>
          <span key={`g${side.species}`} className={`link-bar-ghost${big ? " link-bar-ghost-gold" : ""}`} style={fill(pct)} />
          <span key={`f${side.species}`} className="link-bar-fill" style={fill(pct)} />
        </div>
        <span className="link-bar-pct">
          {exact && side.max_hp !== undefined && side.hp !== undefined ? (
            <>
              {side.hp}
              <small>/{side.max_hp}</small>
            </>
          ) : (
            <>
              {count}
              <small>%</small>
            </>
          )}
        </span>
      </div>
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
      {said ? (
        <p key={said.key} className="link-said">
          <span className="sr-only">{who}&apos;s agent said: </span>
          {said.text}
        </p>
      ) : null}
      {hit ? (
        <span key={hit.key} className={`link-dmg${hit.chips.includes("crit") ? " link-dmg-crit" : hit.chips.includes("super") ? " link-dmg-super" : hit.chips.includes("resisted") ? " link-dmg-soft" : ""}`} aria-hidden="true">
          −{exact && hit.hp !== undefined ? hit.hp : hit.amount}
          {exact && hit.hp !== undefined ? null : <small>%</small>}
        </span>
      ) : null}
      {hit ? <span key={`f${hit.key}`} className="link-flash" aria-hidden="true" /> : null}
      {fainting && !compact ? (
        <span className="link-burst" aria-hidden="true">
          {BURST.map((b, i) => (
            <span key={i} className={b.white ? "link-burst-w" : undefined} style={{ ["--dx" as string]: `${b.dx}px`, ["--dy" as string]: `${b.dy}px` }} />
          ))}
        </span>
      ) : null}
    </div>
  );
}

/** The link cable between the corners: its casing, glow and core; a pulse from whoever moves; while both choose, two dots, one the other's mirror. */
function Cable({ pulse, choosing, brink, dim }: { pulse: { key: string; from: "a" | "b"; chips: Chip[] } | null; choosing: boolean; brink: boolean; dim: [boolean, boolean] }) {
  const id = useId().replace(/:/g, "");
  const sag = "M0,20 Q50,30 100,20";
  const straight = "M0,20 L100,20";
  const p = pulse;
  const kind = !p ? "" : p.chips.includes("missed") ? "miss" : p.chips.includes("immune") ? "immune" : p.chips.includes("resisted") ? "soft" : p.chips.includes("crit") ? "crit" : "hit";
  const dashes = p && p.chips.includes("super") && kind !== "miss" ? [0, 40, 80] : [0];
  return (
    <svg className={`link-cable${brink ? " link-cable-brink" : ""}`} viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`core${id}`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="var(--side-a)" />
          <stop offset="0.5" stopColor="#fff" />
          <stop offset="1" stopColor="var(--side-b)" />
        </linearGradient>
      </defs>
      {[sag, straight].map((d, i) => (
        <g key={i} className={i ? "link-cable-straight" : "link-cable-sag"}>
          <path d={d} className="link-cable-casing" />
          <path d={d} className="link-cable-glow" stroke={`url(#core${id})`} />
          <path d={d} className="link-cable-core" stroke={`url(#core${id})`} />
        </g>
      ))}
      {dim[0] ? <path d="M0,20 Q25,25 50,25" className="link-cable-dead" /> : null}
      {dim[1] ? <path d="M50,25 Q75,25 100,20" className="link-cable-dead" /> : null}
      <path d={sag} className="link-cable-crawl" pathLength={100} />
      {choosing ? (
        <g className="link-cable-wait">
          <path id={`wait${id}`} d={sag} pathLength={100} />
          <use href={`#wait${id}`} transform="translate(100,0) scale(-1,1)" />
        </g>
      ) : null}
      {p
        ? dashes.map((delay) => <path key={`${p.key}-${delay}`} d={sag} pathLength={100} className={`link-pulse link-pulse-${kind} link-pulse-from-${p.from}`} style={{ animationDelay: `${delay}ms` }} />)
        : null}
    </svg>
  );
}

export interface ArenaProps {
  sides: [LinkSide, LinkSide];
  left: 0 | 1;
  names: [string, string];
  exact: boolean;
  result: (side: 0 | 1) => "winner" | "loser" | null;
  now: { step: Step; phase: "windup" | "impact"; key: string } | null;
  choosing: boolean;
  node: ReactNode;
  over: boolean;
  compact: boolean;
  title: [string, string] | null;
  /** Each game side's table talk for the turn on stage: the agent's own words, shown as text. */
  said: [{ key: string; text: string } | null, { key: string; text: string } | null];
  arenaRef?: React.Ref<HTMLDivElement>;
}

/** The arena: both corners, the cable and its node between them, and a knockout's plate over it all. */
export function Arena({ sides, left, names, exact, result, now, choosing, node, over, compact, title, said, arenaRef }: ArenaProps) {
  const right = (1 - left) as 0 | 1;
  const b = now?.step.beat;
  const impact = now?.phase === "impact";
  const tone = (s: 0 | 1): "a" | "b" => (s === left ? "a" : "b");
  const attack = (s: 0 | 1) => (b?.kind === "move" && b.side === s ? { key: now!.key, move: b.move, chips: b.chips, impact: Boolean(impact) } : null);
  const hit = (s: 0 | 1) => {
    if (!impact || !now) return null;
    if (now.step.hit?.side === s) return { key: now.key, amount: now.step.hit.amount, hp: now.step.hit.hp, chips: b?.kind === "move" ? b.chips : [] };
    return null;
  };
  const fainting = (s: 0 | 1) => (impact && b?.kind === "faint" && b.side === s ? b.species : null);
  const ko = impact && b?.kind === "faint";
  const brink = !over && sides[0].hp_percent > 0 && sides[1].hp_percent > 0 && sides[0].hp_percent <= 20 && sides[1].hp_percent <= 20;
  const pulse = b?.kind === "move" ? { key: now!.key, from: tone(b.side), chips: b.chips } : null;
  const cls = ["link-arena", over ? "link-arena-over" : "", ko ? "link-arena-ko" : "", b?.kind === "move" && impact && b.chips.includes("crit") ? "link-arena-crit" : ""].filter(Boolean).join(" ");
  return (
    <div ref={arenaRef} className={cls} data-choosing={choosing ? "" : undefined} data-brink={brink ? "" : undefined}>
      <span className="link-arena-glow" aria-hidden="true" />
      {([left, right] as const).map((s, i) => (
        <Corner key={s} side={sides[s]} who={names[s]} tone={i ? "b" : "a"} exact={exact} result={result(s)} attack={attack(s)} hit={hit(s)} fainting={fainting(s)} compact={compact} said={said[s]} />
      ))}
      <div className="link-mid">
        <Cable pulse={pulse} choosing={choosing} brink={brink} dim={[sides[left].hp_percent <= 0, sides[right].hp_percent <= 0]} />
        <div className="link-node">{node}</div>
      </div>
      {ko && b?.kind === "faint" ? (
        <div key={now!.key} className="link-plate" aria-hidden="true">
          <span>Knockout</span>
        </div>
      ) : null}
      {title ? (
        <div className="link-titlecard" aria-hidden="true">
          <span className="link-titlecard-a">{title[0]}</span>
          <span className="link-titlecard-v">v</span>
          <span className="link-titlecard-b">{title[1]}</span>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- the tug of war

/** Who's ahead, turn by turn: the left side's team HP minus the right's, as an area either side of the line; knockouts and changes of lead marked; a playhead; over, with the screens, a turn to seek. */
export function Tug({ points, upTo, domain, names, left, marks, onSeek }: { points: { turn: number; hp: [number, number] }[]; upTo: number; domain: number; names: [string, string]; left: 0 | 1; marks: Highlight[]; onSeek?: (turn: number) => void }) {
  const id = useId().replace(/:/g, "");
  const [focus, setFocus] = useState<number | null>(null);
  const shown = leadSeries(points.filter((p) => p.turn <= upTo), left);
  if (shown.length < 1) return null;
  const W = 600, H = 96, mid = H / 2;
  const span = Math.max(25, ...shown.map((p) => Math.abs(p.lead)));
  const x = (turn: number) => (turn / Math.max(1, domain)) * W;
  const y = (lead: number) => mid - (lead / span) * (mid - 6);
  let d = `M0,${mid} L0,${y(shown[0]!.lead).toFixed(1)}`;
  for (let i = 1; i < shown.length; i++) d += ` H${x(shown[i]!.turn).toFixed(1)} V${y(shown[i]!.lead).toFixed(1)}`;
  const end = x(shown.at(-1)!.turn);
  const line = d.replace(`M0,${mid} L`, "M");
  const area = `${d} H${end.toFixed(1)} V${mid} Z`;
  const last = shown.at(-1)!;
  const ahead = last.lead > 0 ? names[0] : last.lead < 0 ? names[1] : null;
  return (
    <figure className="link-tug">
      <span className="link-tug-name link-tug-name-a">{names[0]}</span>
      <span className="link-tug-name link-tug-name-b">{names[1]}</span>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role={onSeek ? "slider" : "img"}
        tabIndex={onSeek ? 0 : undefined}
        aria-valuemin={onSeek ? 0 : undefined}
        aria-valuemax={onSeek ? domain : undefined}
        aria-valuenow={onSeek ? (focus ?? upTo) : undefined}
        aria-label={`Who's ahead, turn by turn: ${ahead ? `${ahead} leads by ${Math.abs(last.lead)} points of team HP` : "level"} after ${last.turn ? `turn ${last.turn}` : "the opening"}${onSeek ? ". Arrow keys pick a turn, Enter watches it." : ""}`}
        onKeyDown={
          onSeek
            ? (e) => {
                const f = focus ?? upTo;
                if (e.key === "ArrowLeft") (e.preventDefault(), setFocus(Math.max(0, f - 1)));
                else if (e.key === "ArrowRight") (e.preventDefault(), setFocus(Math.min(domain, f + 1)));
                else if (e.key === "Enter" || e.key === " ") (e.preventDefault(), onSeek(f));
              }
            : undefined
        }
      >
        <defs>
          <clipPath id={`top${id}`}>
            <rect x="0" y="0" width={W} height={mid} />
          </clipPath>
          <clipPath id={`bot${id}`}>
            <rect x="0" y={mid} width={W} height={mid} />
          </clipPath>
          <clipPath id={`rev${id}`}>
            <rect className="link-tug-reveal" x="0" y="0" width={end + 2} height={H} />
          </clipPath>
        </defs>
        <line x1="0" x2={W} y1={mid} y2={mid} className="link-tug-mid" />
        <g clipPath={`url(#rev${id})`}>
          <path d={area} clipPath={`url(#top${id})`} className="link-tug-area-a" />
          <path d={area} clipPath={`url(#bot${id})`} className="link-tug-area-b" />
          <path d={line} clipPath={`url(#top${id})`} className="link-tug-line-a" />
          <path d={line} clipPath={`url(#bot${id})`} className="link-tug-line-b" />
        </g>
        {marks
          .filter((m) => m.turn <= upTo)
          .map((m, i) => (
            <rect key={i} className={`link-tug-mark link-tug-mark-${m.kind}`} x={x(m.turn) - (m.kind === "double" ? 1 : 4)} y={m.kind === "double" ? mid - 5 : mid - 4} width={m.kind === "double" ? 2 : 8} height={m.kind === "double" ? 10 : 8} transform={m.kind === "double" ? undefined : `rotate(45 ${x(m.turn)} ${mid})`} />
          ))}
        <line className="link-tug-head" x1={end} x2={end} y1="2" y2={H - 2} />
        {focus !== null ? <line className="link-tug-focus" x1={x(focus)} x2={x(focus)} y1="0" y2={H} /> : null}
        {onSeek
          ? Array.from({ length: domain + 1 }, (_, t) => (
              <rect key={t} x={x(t) - W / Math.max(1, domain) / 2} y={0} width={W / Math.max(1, domain)} height={H} className="link-tug-hit" onClick={() => onSeek(t)}>
                <title>{t ? `Turn ${t}` : "The opening"}</title>
              </rect>
            ))
          : null}
      </svg>
      <figcaption className="link-tug-cap">{onSeek ? "Who's ahead, turn by turn. Pick a turn to watch it." : "Who's ahead, turn by turn."}</figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------- highlights and the play-by-play

/** The turns worth seeing again, as tiles: knockouts, a critical super effective hit, a change of lead. */
export function Reel({ items, names, left, link, onSeek }: { items: Highlight[]; names: [string, string]; left: 0 | 1; link: ((turn: number) => string) | null; onSeek?: (turn: number) => void }) {
  if (!items.length) return null;
  const head = { ko: "Knockout", double: "Critical, super effective", lead: "Lead change" } as const;
  return (
    <section className="link-reel" aria-label="Highlights">
      <h2 className="link-label">Highlights</h2>
      <ol>
        {[...items].reverse().map((h, i) => {
          const body = (
            <>
              <span className="link-reel-n">Turn {h.turn}</span>
              <span className={`link-reel-head link-reel-${h.kind}`}>{head[h.kind]}</span>
              <span className={`link-reel-sub link-reel-${h.side === left ? "a" : "b"}`}>
                {h.kind === "lead" ? `${names[h.side]} ahead` : h.kind === "ko" ? `${h.text} by ${names[h.side]}` : `${names[h.side]}: ${h.text.split(":")[0]}`}
              </span>
            </>
          );
          return (
            <li key={`${h.turn}-${h.kind}-${i}`}>
              {link ? (
                <a className="link-reel-tile" href={link(h.turn)}>
                  {body}
                </a>
              ) : onSeek ? (
                <button type="button" className="link-reel-tile" onClick={() => onSeek(h.turn)}>
                  {body}
                </button>
              ) : (
                <span className="link-reel-tile">{body}</span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const SHOWN_CHIPS: Chip[] = ["crit", "super", "missed", "immune"];

function Lines({ lines, tone }: { lines: StoryLine[]; tone: (s: 0 | 1) => "a" | "b" }) {
  return (
    <>
      {lines.map((l, i) => (
        <p key={i} className={`link-pbp-line link-pbp-${l.kind}${l.side === null ? "" : ` link-pbp-${tone(l.side)}`}${l.chips.includes("crit") && l.chips.includes("super") ? " link-pbp-double" : ""}`}>
          {l.text}
          {l.chips
            .filter((c) => SHOWN_CHIPS.includes(c))
            .map((c) => (
              <span key={c} className={`link-tag link-tag-${c}`}>
                {CHIP[c]}
              </span>
            ))}
          {l.chips.includes("resisted") ? <span className="link-pbp-soft">· resisted</span> : null}
          {l.kind === "faint" ? <span className="link-tag link-tag-ko">Knocked out</span> : null}
        </p>
      ))}
    </>
  );
}

/** Every turn as a row, newest first: each side's doings in its own column (one column on a phone), knockouts weighed heavier, the table talk as bubbles. */
export function PlayByPlay({ turns, stories, talk, names, left, link, highlight, fresh }: { turns: { turn: number }[]; stories: Map<number, StoryLine[]>; talk: Map<string, string>; names: [string, string]; left: 0 | 1; link: ((turn: number) => string) | null; highlight?: number; fresh: number | null }) {
  const right = (1 - left) as 0 | 1;
  const tone = (s: 0 | 1) => (s === left ? "a" : "b");
  return (
    <ol className="link-pbp" aria-label="Every turn, newest first" aria-live="polite" aria-relevant="additions">
      {turns.map(({ turn }) => {
        const lines = stories.get(turn) ?? [];
        const ko = lines.some((l) => l.kind === "faint");
        const col = (s: 0 | 1) => (
          <div className={`link-pbp-col link-pbp-col-${tone(s)}`}>
            {talk.get(`${turn}:${s}`) ? (
              <p className={`link-bubble link-bubble-${tone(s)}`}>
                <span className="link-bubble-who">{names[s]}&apos;s agent said</span>
                {talk.get(`${turn}:${s}`)}
              </p>
            ) : null}
            <Lines lines={lines.filter((l) => l.side === s)} tone={tone} />
          </div>
        );
        const neither = lines.filter((l) => l.side === null);
        return (
          <li key={turn} id={`turn-${turn}`} className={`link-pbp-row${ko ? " link-pbp-ko" : ""}${highlight === turn ? " link-pbp-this" : ""}${fresh === turn ? " link-pbp-fresh" : ""}`}>
            <div className="link-pbp-inner">
              <span className="link-pbp-n">
                {link ? (
                  <a href={link(turn)} title="A link to this turn">
                    {turn}
                  </a>
                ) : (
                  turn
                )}
              </span>
              {col(left)}
              {col(right)}
              {neither.length ? (
                <div className="link-pbp-col link-pbp-both">
                  <Lines lines={neither} tone={tone} />
                </div>
              ) : null}
              {!lines.length ? <p className="link-pbp-line link-pbp-other link-pbp-both">Nothing happened.</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------- the end

/** Twenty-four streaks of the wire's colours, rising once from the result band. */
const STREAKS = Array.from({ length: 24 }, (_, i) => ({ x: Math.round(((i * 41) % 97) + 1.5), c: i % 4, d: i * 30 }));

/** The result: the winner's name rising, the wire beam drawn from their side, how it ended, the ratings, then the actions. */
export function Final({ head, tone, sub, ratings, comeback, called, fresh, children }: { head: { name: string; won: boolean } | { text: string }; tone: "a" | "b" | null; sub: string; ratings: { name: string; change: number }[]; comeback: string | null; called: string | null; fresh: boolean; children?: ReactNode }) {
  return (
    <section className={`link-final${tone ? ` link-final-${tone}` : " link-final-none"}${fresh ? " link-final-fresh" : ""}`} aria-label="How it ended">
      <span className="link-final-beam" aria-hidden="true" />
      {fresh && tone ? (
        <span className="link-streaks" aria-hidden="true">
          {STREAKS.map((s, i) => (
            <span key={i} className={`link-streak-${s.c}`} style={{ left: `${s.x}%`, animationDelay: `${s.d}ms` }} />
          ))}
        </span>
      ) : null}
      <div className="link-final-text">
        {"name" in head ? (
          <p className="link-final-head">
            <span className="link-final-mask">
              <span className={`link-final-name${head.name.length > 18 ? " link-final-name-longer" : head.name.length > 11 ? " link-final-name-long" : ""}`}>{head.name}</span>
            </span>
            <span className="link-final-wins">wins</span>
          </p>
        ) : (
          <p className="link-final-head">
            <span className="link-final-mask">
              <span className="link-final-name">{head.text}</span>
            </span>
          </p>
        )}
        <p className="link-final-sub">
          {sub}
          {comeback ? <span className="link-final-comeback"> {comeback}</span> : null}
        </p>
        {called ? <p className="link-final-called">{called}</p> : null}
        {ratings.length ? (
          <p className="link-final-ratings">
            {ratings.map((r) => (
              <span key={r.name} className="link-rating">
                {r.name} {r.change >= 0 ? "+" : "−"}
                {Math.abs(r.change)}
              </span>
            ))}
          </p>
        ) : null}
      </div>
      {children ? <div className="link-final-actions">{children}</div> : null}
    </section>
  );
}

/** Share: the link, the spoiler-free link, X, and (rated) the embed. */
export function Share({ w, names }: { w: LinkBattle; names: [string, string] }) {
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

// ---------------------------------------------------------------- calling it

export interface Call {
  side: 0 | 1;
  /** The turn the battle was on when the call was made. */
  turn: number;
}

/** This browser's call for a battle, kept only here (nothing is sent, staked or won). Made once: it can't be changed after. */
export function usePick(match: string): [Call | null, (side: 0 | 1, turn: number) => void] {
  const [pick, setPick] = useState<Call | null>(null);
  useEffect(() => {
    try {
      const v = JSON.parse(window.localStorage.getItem(`link-pick:${match}`) ?? "null") as Partial<Call> | null;
      if (v && (v.side === 0 || v.side === 1) && Number.isInteger(v.turn)) setPick({ side: v.side, turn: v.turn as number });
    } catch {
      // No storage (a private window), or something else there: no call yet.
    }
  }, [match]);
  const choose = (side: 0 | 1, turn: number) => {
    if (pick) return;
    const call = { side, turn };
    setPick(call);
    try {
      window.localStorage.setItem(`link-pick:${match}`, JSON.stringify(call));
    } catch {
      // The call lasts as long as the page.
    }
  };
  return [pick, choose];
}

/** "Who takes it?": a call to follow the battle by, made once and kept in this browser alone. Nothing rides on it. */
export function Pick({ names, left, pick, onPick, children }: { names: [string, string]; left: 0 | 1; pick: Call | null; onPick: (side: 0 | 1) => void; children?: ReactNode }) {
  const right = (1 - left) as 0 | 1;
  return (
    <div className="link-pick" role="group" aria-label="Call it: who takes it? Just for fun, kept in this browser.">
      {pick ? (
        <span className={`link-pick-made link-pick-made-${pick.side === left ? "a" : "b"}`}>
          Your call: <b>{names[pick.side]}</b>, made {pick.turn <= 0 ? "before the first turn" : `on turn ${pick.turn}`}.
        </span>
      ) : (
        <>
          <span className="link-pick-q">Call it. Who takes it?</span>
          {([left, right] as const).map((x, i) => (
            <button key={x} type="button" className={`link-pick-btn link-pick-${i ? "b" : "a"}`} onClick={() => onPick(x)}>
              {names[x]}
            </button>
          ))}
        </>
      )}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- the transport

const ICON = {
  prev: "M7 5h2v14H7zM19 5v14L10 12z",
  next: "M15 5h2v14h-2zM5 5v14l9-7z",
  play: "M7 4v16l13-8z",
  pause: "M6 4h4v16H6zM14 4h4v16h-4z",
  sound: "M4 9v6h4l5 4V5L8 9zM16 8.5a4.5 4.5 0 0 1 0 7v-7zM16 4.6a8.5 8.5 0 0 1 0 14.8v-2.2a6.5 6.5 0 0 0 0-10.4z",
  mute: "M4 9v6h4l5 4V5L8 9zM21 9.4 19.6 8 17.5 10.1 15.4 8 14 9.4l2.1 2.1L14 13.6l1.4 1.4 2.1-2.1 2.1 2.1 1.4-1.4-2.1-2.1z",
} as const;

export function Icon({ d }: { d: keyof typeof ICON }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d={ICON[d]} fill="currentColor" />
    </svg>
  );
}

/** Previous, play or pause, next, where it is, and the speed: for the screens, and for a replay without them. */
export function Transport({ label, playing, onToggle, onPrev, onNext, canPrev, canNext, speed, onSpeed, status, disabled = false }: { label: string; playing: boolean; onToggle: () => void; onPrev: () => void; onNext: () => void; canPrev: boolean; canNext: boolean; speed: number; onSpeed: () => void; status?: ReactNode; disabled?: boolean }) {
  return (
    <div className="link-transport">
      <button type="button" className="link-tbtn" onClick={onPrev} disabled={!canPrev} aria-label="Previous turn">
        <Icon d="prev" />
      </button>
      <button type="button" className="link-tbtn link-tbtn-play" onClick={onToggle} disabled={disabled} aria-label={playing ? "Pause" : "Play"}>
        <Icon d={playing ? "pause" : "play"} />
      </button>
      <button type="button" className="link-tbtn" onClick={onNext} disabled={!canNext} aria-label="Next turn">
        <Icon d="next" />
      </button>
      <span className="link-transport-label">
        {label}
        {status}
      </span>
      <button type="button" className="link-tbtn link-tbtn-speed" onClick={onSpeed} aria-label={`Speed: ${speed}×`}>
        {speed}×
      </button>
    </div>
  );
}
