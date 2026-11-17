"use client";

import { useEffect, useRef, useState } from "react";
import type { TapeItem } from "../../lib/tape.ts";

// The homepage's tape: higher.fun's latest launches, buys, sells and graduations, as a short list beside the wire. Each
// one is also sent to the wire's canvas (a "stage-trade" event, components/arena/ArenaStage.tsx), which runs it along
// the wire as a head of light, sized by its SOL. What the page was built with replays first, labelled "Recent"; after
// that /api/tape is read every few seconds and each new event plays at its real spacing, labelled "Live" only while
// the newest is fresh. The list is real text, not decoration: it's the page's proof, and it reads without the canvas.

const POLL_MS = 5_000;
/** The feed counts as live while its newest event is this recent. */
const FRESH_MS = 120_000;
const SHOWN = 4;

type Status = "recent" | "live" | "quiet";

const fmtSol = (n: number) => (n > 0 && n < 0.001 ? "<0.001" : n.toLocaleString("en-US", { maximumFractionDigits: n >= 10 ? 1 : n >= 1 ? 2 : 3 }));

/** Where an event's colour sits on the wire's gradient: launches gold, sells pink, graduations blue, buys mint. */
const HUE: Record<TapeItem["kind"], number> = { launch: 0.02, sell: 0.34, graduation: 0.66, buy: 0.95 };
/** How big its light is: by SOL for a trade, on a curve so a small buy still shows and a large one doesn't swamp. */
const sizeOf = (e: TapeItem) => (e.kind === "graduation" ? 1 : e.kind === "launch" ? 0.6 : Math.min(1, Math.log10(1 + (e.sol ?? 0) * 40) / 2.2));

interface Shown extends TapeItem {
  key: string;
}

export function HomeTape({ initial }: { initial: TapeItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("recent");
  // Before anything plays, the page's own latest few: the list is never empty, with or without scripts.
  const [shown, setShown] = useState<Shown[]>(() => [...initial].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, SHOWN).map((e) => ({ ...e, key: e.id })));

  useEffect(() => {
    const canvas = ref.current?.closest("[data-stage-host]")?.querySelector('canvas[data-scene="wire"]') ?? null;
    const seen = new Set<string>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let stopped = false;
    let newest = 0;
    const emit = (item: TapeItem) => {
      if (stopped) return;
      canvas?.dispatchEvent(new CustomEvent("stage-trade", { detail: { size: sizeOf(item), hue: HUE[item.kind] } }));
      setShown((s) => [{ ...item, key: `${item.id}-${Date.now()}` }, ...s.filter((x) => x.id !== item.id)].slice(0, SHOWN));
    };
    const schedule = (items: TapeItem[], spreadMs: number) => {
      const fresh = items.filter((i) => !seen.has(i.id)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      if (!fresh.length) return;
      for (const i of fresh) seen.add(i.id);
      const first = Date.parse(fresh[0]!.at);
      const span = Math.max(1, Date.parse(fresh[fresh.length - 1]!.at) - first);
      fresh.forEach((item) => {
        const delay = ((Date.parse(item.at) - first) / span) * spreadMs + Math.random() * 300;
        const t = setTimeout(() => {
          timers.delete(t);
          emit(item);
        }, delay);
        timers.add(t);
      });
      newest = Math.max(newest, ...fresh.map((i) => Date.parse(i.at)));
    };
    // What the page was built with plays first, quickly: it's the recent past, and says so.
    schedule(initial.slice(0, 12), 7_000);
    const poll = async () => {
      try {
        const res = await fetch("/api/tape", { cache: "no-store" });
        const body = (await res.json()) as { items?: TapeItem[] };
        if (!res.ok || !body.items) throw new Error("tape");
        schedule(body.items, POLL_MS);
        setStatus(Date.now() - newest < FRESH_MS ? "live" : "quiet");
      } catch {
        setStatus("recent");
      }
    };
    const first = setTimeout(() => void poll(), 7_500);
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(iv);
      for (const t of timers) clearTimeout(t);
    };
  }, [initial]);

  const label = { recent: "Recent", live: "Live", quiet: "Quiet just now" }[status];
  return (
    <div ref={ref} className="home-tape">
      <p className="home-tape-head">
        <span className="home-tape-dot" data-status={status} aria-hidden="true" />
        {label} on higher.fun
      </p>
      {shown.length ? (
        <ol className="home-tape-list" aria-label="The latest events on higher.fun">
          {shown.map((e) => (
            <li key={e.key} data-kind={e.kind}>
              <span className="home-tape-kind">{e.kind}</span>
              {e.ticker ? <span className="home-tape-ticker">${e.ticker}</span> : null}
              {e.sol != null && (e.kind === "buy" || e.kind === "sell") ? <span className="home-tape-sol">{fmtSol(e.sol)} SOL</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      <p className="home-tape-note">Each light on the wire is one of these.</p>
    </div>
  );
}
