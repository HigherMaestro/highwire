"use client";

import { useEffect, useRef, useState } from "react";
import type { TapeItem } from "../../lib/tape.ts";
import { startScene, type Scene } from "./LiveWire.tsx";

// The homepage's wire as a page header's backdrop, framed as a band. Its pulses are decoration, not trades, so nothing
// here is labelled live. Follows the theme like the homepage; reduced motion gets a still frame, no WebGL a plain wire.

export function AmbientWire() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [flat, setFlat] = useState(false);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let scene: Scene | null = null;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let n = 0;
    const pulse = () => {
      if (disposed || !scene) return;
      const item: TapeItem = { id: `ambient-${n++}`, kind: Math.random() < 0.6 ? "buy" : "sell", ticker: "", sol: 0.02 + Math.random() * Math.random() * 2, at: new Date().toISOString() };
      scene.play(item);
      if (!reduced) timer = setTimeout(pulse, 900 + Math.random() * 1800);
    };
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || scene || disposed) return;
        io.disconnect();
        import("three")
          .then((THREE) => {
            if (disposed) return;
            scene = startScene(THREE, stage, "band");
            if (!scene) return setFlat(true);
            // A few to start, so the wire is never empty.
            for (let i = 0; i < (reduced ? 6 : 3); i++) pulse();
          })
          .catch(() => setFlat(true));
      },
      { rootMargin: "200px" },
    );
    io.observe(stage);
    return () => {
      disposed = true;
      io.disconnect();
      clearTimeout(timer);
      scene?.dispose();
    };
  }, []);

  return (
    <div className="livewire" ref={stageRef} aria-hidden="true">
      {flat ? (
        <svg className="livewire-flat" viewBox="0 0 1000 300" preserveAspectRatio="none">
          <defs>
            <linearGradient id="aw-flat" x1="0" x2="1">
              <stop offset="0" stopColor="#F7C84C" />
              <stop offset=".35" stopColor="#F6A9C4" />
              <stop offset=".7" stopColor="#93E2FB" />
              <stop offset="1" stopColor="#A6EFCB" />
            </linearGradient>
          </defs>
          <path d="M0 230 Q500 300 1000 40" fill="none" stroke="url(#aw-flat)" strokeWidth="3" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : null}
      <div className="livewire-vignette" />
    </div>
  );
}
