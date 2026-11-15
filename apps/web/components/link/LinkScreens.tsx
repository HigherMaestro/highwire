"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeFilm, type Film, FilmPlayer, SCREEN_H, SCREEN_W } from "highwire-link/film";

// Both Game Boys' screens, side by side (docs/link-battles.md 13.3): each turn's film, played in order with the turn
// controls. A film is made after its turn is answered, so a live battle's newest turn may take a few seconds to appear;
// the player waits for it. Reduced motion: nothing plays until asked.

const RETRY_MS = 2500;
/** A live turn whose film hasn't come in this long is passed over (a later one has), or the stage stops waiting for it. */
const GIVE_UP_MS = 30_000;

/** What the screens show, for the stage to follow: the turn on screen, and whether it has played to its end. */
export type Shown = { turn: number; done: boolean } | null;
type Load = { state: "loading" } | { state: "ready"; film: Film } | { state: "missing" };
/** A finished battle's film asked for this many times and still missing isn't coming (its screens weren't kept). */
const TRIES_WHEN_OVER = 3;

async function fetchFilm(match: string, turn: number): Promise<Film | null> {
  const res = await fetch(`/api/link/film/${match}/${turn}`);
  // 204: not filmed (yet).
  if (res.status !== 200) return null;
  return decodeFilm(new Uint8Array(await res.arrayBuffer()));
}

/**
 * The player. `left` is the game whose screen goes on the left (as on the stage), `names` each game's fighter.
 * `onShow` hears which turn is on screen while the screens are being followed (a live battle playing, or once someone
 * has pressed play or stepped), and null otherwise, when the stage shows the battle as it stands.
 */
export function LinkScreens({ match, turns, live, left, names, onShow }: { match: string; turns: number; live: boolean; left: 0 | 1; names: [string, string]; onShow?: (s: Shown) => void }) {
  // The turn on screen: 0 is the opening (the first menu), 1..turns the turns played.
  const [turn, setTurn] = useState(() => (live ? Math.max(0, turns) : 0));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  // A finished battle whose opening film is gone: its screens are no longer kept.
  const [noScreens, setNoScreens] = useState(false);
  const liveRef = useRef(live);
  liveRef.current = live;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const canvases = [useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null)] as const;
  const player = useRef<FilmPlayer | null>(null);
  const films = useRef(new Map<number, Promise<Film | null>>());
  const following = useRef(live);
  const latest = useRef(turns);
  latest.current = turns;
  const shown = [left, (1 - left) as 0 | 1] as const;
  // Followed: playing a live battle on its own, or once someone has pressed play or stepped.
  const engaged = useRef(false);
  const tell = useRef(onShow);
  tell.current = onShow;
  const report = useCallback((t: number, done: boolean) => tell.current?.(engaged.current ? { turn: t, done } : null), []);
  const who = [`${names[shown[0]]}'s screen`, `${names[shown[1]]}'s screen`] as const;

  // Reduced motion: never start on its own. Otherwise a live battle plays as it comes.
  useEffect(() => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (live && !still) {
      engaged.current = true;
      setPlaying(true);
    }
  }, [live]);

  const get = useCallback(
    (t: number) => {
      let p = films.current.get(t);
      if (!p) {
        p = fetchFilm(match, t).catch(() => null);
        films.current.set(t, p);
        // A missing film is asked again later (it may be on its way), never remembered.
        p.then((f) => {
          if (!f) setTimeout(() => films.current.delete(t), RETRY_MS);
        });
      }
      return p;
    },
    [match],
  );

  const draw = useCallback(() => {
    const p = player.current;
    for (const side of [0, 1] as const) {
      const ctx = canvases[side].current?.getContext("2d");
      if (!ctx) continue;
      if (!p || p.frame < 0) {
        ctx.fillStyle = "#0b0f0c";
        ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
        continue;
      }
      ctx.putImageData(new ImageData(new Uint8ClampedArray(p.screens[shown[side]].buffer as ArrayBuffer), SCREEN_W, SCREEN_H), 0, 0);
    }
  }, [left]);

  // Loads the turn on screen (and asks again while it's missing), shows its first frame, and fetches the next.
  useEffect(() => {
    let gone = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const since = Date.now();
    let tries = 0;
    report(turn, false);
    const again = () => {
      // A hidden tab doesn't keep asking; it asks again once it's shown.
      retry = setTimeout(() => (document.hidden ? again() : void attempt()), RETRY_MS * Math.min(4, 1 + tries));
    };
    const attempt = async () => {
      tries++;
      const film = await get(turn);
      if (gone) return;
      if (!film) {
        setLoad({ state: "missing" });
        if (!liveRef.current) {
          // Over: its films are made, or never will be. A missing opening means its screens weren't kept.
          if (tries >= TRIES_WHEN_OVER) {
            if (turn === 0) {
              setNoScreens(true);
              tell.current?.(null);
            } else if (playingRef.current && turn < latest.current) setTurn(turn + 1);
            return;
          }
        } else if (Date.now() - since > GIVE_UP_MS) {
          // Live: a film that never came (its filming failed). Followed, go past it; at the newest turn, stop holding the stage back.
          if (playingRef.current && turn < latest.current) return setTurn(turn + 1);
          if (turn >= latest.current) tell.current?.(null);
        }
        again();
        return;
      }
      const p = new FilmPlayer(film);
      try {
        p.next();
      } catch {
        // A damaged film: no screens for this turn; the stage isn't held back by it.
        setLoad({ state: "missing" });
        report(turn, true);
        if (playingRef.current && turn < latest.current) setTurn(turn + 1);
        return;
      }
      player.current = p;
      draw();
      setLoad({ state: "ready", film });
      if (turn < latest.current) void get(turn + 1);
    };
    setLoad({ state: "loading" });
    void attempt();
    return () => {
      gone = true;
      clearTimeout(retry);
    };
  }, [turn, get, draw, report]);

  // Playback: frames by the clock, then on to the next turn (a live battle waits there for its next turn).
  useEffect(() => {
    if (!playing || load.state !== "ready") return;
    let raf = 0;
    let last = performance.now();
    let owed = 0;
    const tick = (now: number) => {
      const p = player.current;
      if (!p) return;
      // A backgrounded tab picks up where it was, not where the clock says.
      owed = Math.min(owed + ((now - last) / 1000) * p.film.fps * speed, 8);
      last = now;
      let moved = false;
      while (owed >= 1) {
        owed--;
        let more: boolean;
        try {
          more = p.next();
        } catch {
          // A damaged film: this turn shows no more; the stage moves on, and so do the screens if there's a next turn.
          setLoad({ state: "missing" });
          report(turn, true);
          if (turn < turns) setTurn(turn + 1);
          else setPlaying(false);
          return;
        }
        if (!more) {
          report(turn, true);
          if (turn < turns) setTurn(turn + 1);
          else if (!live) setPlaying(false);
          return draw();
        }
        moved = true;
      }
      if (moved) draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, load, speed, turn, turns, live, draw, report]);

  // Following a live battle: a new turn arrives after the one on screen has played to its end. Only that turn's own film
  // counts (while the next one loads, the player still holds the last one's).
  useEffect(() => {
    const p = player.current;
    if (live && following.current && playing && load.state === "ready" && p && p.film.turn === turn && p.frame >= p.film.frames - 1 && turn < turns) setTurn(turn + 1);
  }, [turns, live, playing, turn, load]);

  const go = (t: number) => {
    following.current = t >= turns;
    engaged.current = true;
    setTurn(Math.max(0, Math.min(turns, t)));
  };
  const toggle = () => {
    const p = player.current;
    if (!engaged.current) {
      engaged.current = true;
      report(turn, false);
    }
    // Play again from the start once the last turn has finished.
    if (!playing && p && p.frame >= p.film.frames - 1 && turn >= turns && !live) {
      setTurn(turns > 0 ? 1 : 0);
      if (turn === (turns > 0 ? 1 : 0)) {
        p.rewind();
        p.next();
        draw();
        report(turn, false);
      }
    }
    setPlaying(!playing);
  };

  const label = turn === 0 ? "The opening" : `Turn ${turn} of ${turns}`;
  if (noScreens) {
    return <p className="link-screens-later muted">This battle&apos;s screens are no longer kept. Every turn is still told below.</p>;
  }
  return (
    <figure className="link-screens" aria-label="Both Game Boys' screens">
      <div className="link-screens-pair">
        {([0, 1] as const).map((side) => (
          <div key={side} className={`link-screen link-screen-${side === 0 ? "a" : "b"}`}>
            <p className="link-screen-who">{who[side]}</p>
            <canvas ref={canvases[side]} width={SCREEN_W} height={SCREEN_H} role="img" aria-label={`${who[side]}, ${label.toLowerCase()}`} />
          </div>
        ))}
      </div>
      <figcaption className="link-screens-bar">
        <button type="button" className="link-screens-btn" onClick={() => go(turn - 1)} disabled={turn <= 0} aria-label="Previous turn">
          ⏮
        </button>
        <button type="button" className="link-screens-btn link-screens-play" onClick={toggle} disabled={load.state !== "ready"} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button type="button" className="link-screens-btn" onClick={() => go(turn + 1)} disabled={turn >= turns} aria-label="Next turn">
          ⏭
        </button>
        <span className="link-screens-turn">
          {label}
          {load.state === "missing" ? <span className="muted small"> · {live && turn >= turns ? "filming…" : live ? "no screens yet" : "no screens for this turn"}</span> : null}
          {load.state === "loading" ? <span className="muted small" role="status"> · loading the screens…</span> : null}
        </span>
        <button type="button" className="link-screens-btn link-screens-speed" onClick={() => setSpeed(speed === 1 ? 2 : 1)} aria-label={`Speed: ${speed}×`}>
          {speed}×
        </button>
      </figcaption>
    </figure>
  );
}
