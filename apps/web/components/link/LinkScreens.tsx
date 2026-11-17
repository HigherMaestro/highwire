"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeFilm, type Film, FilmPlayer, SCREEN_H, SCREEN_W } from "highwire-link/film";
import { Icon, Transport } from "./StageParts.tsx";
import { audioContext } from "./useSound.ts";

// Both Game Boys' screens, side by side (docs/link-battles.md 13.3, 14.11): each turn's film, played in order with the turn
// controls. A film is made after its turn is answered, so a live battle's newest turn may take a few seconds to appear;
// the player waits for it. Each screen is drawn at a whole multiple of the Game Boy's 160 by 144 pixels, in a bezel, the
// link cable between them; a finished battle waits on its last frame under "Watch it back". Reduced motion: nothing
// plays until asked.

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
export function LinkScreens({ match, turns, live, left, names, onShow, startTurn, autoplay = false, seek, fresh = false, call = "", quiet = false, sound }: { match: string; turns: number; live: boolean; left: 0 | 1; names: [string, string]; onShow?: (s: Shown) => void; startTurn?: number; autoplay?: boolean; seek?: number; fresh?: boolean; /** What the stage is saying, shown between the screens on a phone, where the stage itself is below them. */ call?: string; /** Say nothing when the screens aren't kept (the lobby). */ quiet?: boolean; /** The sound switch: on, each turn's film plays its Game Boy's sound (14.14). */ sound?: { on: boolean; toggle: () => void } }) {
  // The turn on screen: 0 is the opening (the first menu), 1..turns the turns played. A live battle opens on its newest
  // turn; a finished one on its last turn's final frame, so the screens agree with the stage and the result; a page can
  // ask for a turn (a turn link, from the start), and `seek` (the momentum strip) moves it.
  const [turn, setTurn] = useState(() => (startTurn !== undefined ? Math.max(0, Math.min(turns, startTurn)) : Math.max(0, turns)));
  const toEnd = useRef(!live && startTurn === undefined);
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
  // A finished battle opened on its last frame waits under "Watch it back" until someone plays or steps.
  const [started, setStarted] = useState(live || startTurn !== undefined || autoplay);
  const pair = useRef<HTMLDivElement>(null);
  // Whole pixels: each screen at the largest multiple of 160 by 144 that fits (2 to 4), never stretched between.
  useEffect(() => {
    const el = pair.current;
    if (!el) return;
    const fit = () => {
      const stacked = window.matchMedia("(max-width: 640px)").matches;
      const w = el.clientWidth;
      // The room for one screen inside its bezel (a phone's is thinner, and the pair runs wider than the text).
      const each = stacked ? w - 14 : (w - 56) / 2 - 30;
      // A phone too narrow for 2× gets the widest it can take, between whole multiples, rather than a tiny 1×.
      const px = each >= SCREEN_W * 2 ? Math.min(4, Math.floor(each / SCREEN_W)) : stacked ? Math.max(1, each / SCREEN_W) : 2;
      el.style.setProperty("--px", String(px));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const tell = useRef(onShow);
  tell.current = onShow;
  const report = useCallback((t: number, done: boolean) => tell.current?.(engaged.current ? { turn: t, done } : null), []);
  const who = [`${names[shown[0]]}'s screen`, `${names[shown[1]]}'s screen`] as const;

  // Reduced motion: never start on its own. Otherwise a live battle plays as it comes, and so does one watched from the start.
  useEffect(() => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if ((live && startTurn === undefined) || autoplay) {
      engaged.current = true;
      if (!still) setPlaying(true);
      report(turn, false);
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

  // The turn's sound, when its film has it and sound is on: one Game Boy's, kept in step with the frame on screen. It
  // starts where the frames are, is started again if the two drift apart (a tab that was hidden, a slow frame), and is
  // quiet at double speed.
  const soundOn = useRef(false);
  soundOn.current = Boolean(sound?.on);
  const voice = useRef<{ src: AudioBufferSourceNode; film: Film; startedAt: number; offset: number } | null>(null);
  const buffers = useRef(new WeakMap<Film, AudioBuffer>());
  const hush = useCallback(() => {
    const v = voice.current;
    voice.current = null;
    if (!v) return;
    try {
      v.src.stop();
    } catch {
      // Already ended.
    }
  }, []);
  const voiceSync = useCallback(
    (speedNow: number) => {
      const p = player.current;
      const a = p?.film.audio;
      const ctx = soundOn.current && a && a.samples.length && speedNow === 1 && !document.hidden ? audioContext() : null;
      if (!p || !a || !ctx || ctx.state !== "running" || p.frame < 0) return hush();
      try {
        const length = a.samples.length / a.rate;
        // Sound seconds per second of film: the film's frames are numbered at 60 a second, a Game Boy's run a little slower.
        const rate = length / (p.film.frames / p.film.fps);
        const want = (p.frame / p.film.fps) * rate;
        const v = voice.current;
        if (v && v.film === p.film && Math.abs(v.offset + (ctx.currentTime - v.startedAt) * rate - want) < 0.15) return;
        hush();
        if (want >= length - 0.03) return;
        let buffer = buffers.current.get(p.film);
        if (!buffer) {
          buffer = ctx.createBuffer(1, a.samples.length, a.rate);
          const channel = buffer.getChannelData(0);
          for (let i = 0; i < a.samples.length; i++) channel[i] = (a.samples[i]! - 128) / 128;
          buffers.current.set(p.film, buffer);
        }
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.playbackRate.value = rate;
        const gain = ctx.createGain();
        gain.gain.value = 0.6;
        src.connect(gain).connect(ctx.destination);
        src.start(0, want);
        voice.current = { src, film: p.film, startedAt: ctx.currentTime, offset: want };
      } catch {
        // No sound here: the screens play on without it.
        hush();
      }
    },
    [hush],
  );
  useEffect(() => hush, [hush]);
  useEffect(() => {
    if (!playing) hush();
  }, [playing, hush]);

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
      // A finished battle opens on its last frame: the end, as the stage below shows it.
      if (toEnd.current) {
        toEnd.current = false;
        try {
          while (p.next());
        } catch {
          // A damaged film: it shows as far as it goes.
        }
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
      voiceSync(speed);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // The sound isn't stopped here: this runs again whenever a live battle gains a turn, and stopping it each time made a
    // gap in the turn being played. It stops when the playing does (below), and follows the film by itself.
    return () => cancelAnimationFrame(raf);
  }, [playing, load, speed, turn, turns, live, draw, report]);

  // Following a live battle: a new turn arrives after the one on screen has played to its end. Only that turn's own film
  // counts (while the next one loads, the player still holds the last one's).
  useEffect(() => {
    const p = player.current;
    if (live && following.current && playing && load.state === "ready" && p && p.film.turn === turn && p.frame >= p.film.frames - 1 && turn < turns) setTurn(turn + 1);
  }, [turns, live, playing, turn, load]);

  // The momentum strip asked for a turn: open it and play it, the stage following.
  useEffect(() => {
    if (seek === undefined) return;
    setStarted(true);
    engaged.current = true;
    following.current = false;
    setTurn(Math.max(0, Math.min(latest.current, seek)));
    setPlaying(true);
    // The strip is below the screens, a screen or two down on a phone: bring them back into view to be watched. A moment
    // later, once the stage has taken the result's banner away above them, or the scroll would aim at where they were.
    const id = setTimeout(() => {
      const el = pair.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }, 120);
    return () => clearTimeout(id);
  }, [seek]);

  const go = (t: number) => {
    setStarted(true);
    following.current = t >= turns;
    engaged.current = true;
    setTurn(Math.max(0, Math.min(turns, t)));
  };
  const toggle = () => {
    setStarted(true);
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
    if (quiet) return null;
    return <p className="link-screens-later">This battle&apos;s screens are no longer kept. Every turn is still told below.</p>;
  }
  // Watch it back: from the first turn.
  const watch = () => {
    setStarted(true);
    engaged.current = true;
    following.current = false;
    if (turn === (turns > 0 ? 1 : 0)) {
      const p = player.current;
      p?.rewind();
      p?.next();
      draw();
      report(turn, false);
    } else setTurn(turns > 0 ? 1 : 0);
    setPlaying(true);
  };
  return (
    <figure className={`link-screens${fresh ? " link-screens-fresh" : ""}`} aria-label="Both Game Boys' screens">
      <div ref={pair} className="link-screens-pair">
        {([0, 1] as const).map((side) => (
          <div key={side} className={`link-screen link-screen-${side === 0 ? "a" : "b"}`} style={{ gridColumn: side === 0 ? 1 : 3 }}>
            <p className="link-screen-who">{who[side]}</p>
            <canvas ref={canvases[side]} width={SCREEN_W} height={SCREEN_H} role="img" aria-label={`${who[side]}, ${label.toLowerCase()}`} />
          </div>
        ))}
        <span className="link-screens-cable" aria-hidden="true">
          <span key={turn} className="link-screens-cable-pulse" />
        </span>
        {call ? (
          <span key={call} className="link-screens-call" aria-hidden="true">
            {call}
          </span>
        ) : null}
        {!started && !playing ? (
          <button type="button" className="link-screens-poster" onClick={watch} disabled={load.state !== "ready"}>
            <span className="link-screens-poster-btn">
              <Icon d="play" />
            </span>
            <span className="link-screens-poster-label">Watch it back</span>
          </button>
        ) : null}
      </div>
      <figcaption className="link-screens-bar">
        <Transport
          label={label}
          playing={playing}
          onToggle={toggle}
          onPrev={() => go(turn - 1)}
          onNext={() => go(turn + 1)}
          canPrev={turn > 0}
          canNext={turn < turns}
          speed={speed}
          onSpeed={() => setSpeed(speed === 1 ? 2 : 1)}
          disabled={load.state !== "ready"}
          sound={sound}
          status={
            <>
              {load.state === "missing" ? <span className="link-transport-note"> · {live && turn >= turns ? "filming…" : live ? "no screens yet" : "no screens for this turn"}</span> : null}
              {load.state === "loading" ? (
                <span className="link-transport-note" role="status">
                  {" "}
                  · loading the screens…
                </span>
              ) : null}
            </>
          }
        />
      </figcaption>
    </figure>
  );
}
