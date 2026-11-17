"use client";

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { FRAGMENT, type SceneName, VERTEX } from "./shaders.ts";

// The site's moving pictures (shaders.ts), each a fragment shader on one canvas: plain WebGL, nothing downloaded. A
// canvas starts when it's near the screen and stops when it leaves; it follows the pointer over its host (the nearest
// [data-stage-host], or itself), the site's theme, and the colour behind it. It draws at most 60 times a second and
// draws smaller when the machine can't keep up. Reduced motion, or the page's pause switch (MotionSwitch), holds one
// still frame; a browser without WebGL (or with only software WebGL) gets the CSS picture instead. All decoration:
// hidden from assistive technology.

/** The most pixels a canvas draws at full quality. */
const BUDGET: Record<SceneName, number> = { clash: 1_300_000, wire: 1_300_000, line: 480_000, link: 480_000, next: 300_000, split: 1_000_000, keys: 620_000, build: 700_000, snap: 1_300_000 };
/** The frame a still picture shows (reduced motion). */
const STILL = 14;
/** No more than 60 frames a second, whatever the screen refreshes at. */
const FRAME_MS = 1000 / 62;
/** The attribute on <html> while the page's motion is paused, and the event that says it changed. */
const PAUSED = "data-stage-paused";
const MOTION_EVENT = "stage-motion";

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  console.warn(`A stage's shader didn't compile: ${gl.getShaderInfoLog(shader) ?? ""}`);
  gl.deleteShader(shader);
  return null;
}

/** "rgb(10, 12, 16)" as three numbers from 0 to 1. */
function rgb(css: string): [number, number, number] | null {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css);
  return m ? [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255] : null;
}

export function ShaderCanvas({ scene, className, values }: { scene: SceneName; className?: string; values?: readonly number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Up to eight figures a scene may draw from (uValues): the page's own, kept current and read on every frame.
  const figures = useRef(new Float32Array(8));
  useEffect(() => {
    figures.current.fill(0);
    figures.current.set((values ?? []).slice(0, 8).map((v) => (Number.isFinite(v) ? v : 0)));
  });
  // No WebGL, or a shader this GPU won't take: the CSS picture, on a plain element (a canvas that once had a context
  // paints over its own background).
  const [flat, setFlat] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const host = (canvas.closest("[data-stage-host]") as HTMLElement | null) ?? canvas;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let gl: WebGLRenderingContext | null = null;
    let uniforms: Record<string, WebGLUniformLocation | null> = {};
    let frame = 0;
    let visible = false;
    let disposed = false;
    let last = performance.now();
    let clock = 0;
    let dpr = window.devicePixelRatio || 1;
    // How much of the budget it draws: it drops when frames run long, and stays down.
    let quality = 1;
    let slow = 0;
    const target = { x: 0.5, y: 0.5, hover: 0 };
    const eased = { x: 0.5, y: 0.5, hover: 0 };
    let pulse: [number, number, number] = [0.5, 0.5, -100];
    let bg: [number, number, number] = [0.04, 0.047, 0.063];
    let light = 0;
    // The last eight events it was told of (a "stage-trade" on the canvas): when, how big, which colour.
    const trades = new Float32Array(32).fill(0);
    for (let i = 0; i < 8; i++) trades[i * 4] = -100;
    let nextTrade = 0;

    const still = () => reduced.matches || document.documentElement.hasAttribute(PAUSED);
    const readTheme = () => {
      light = document.documentElement.dataset.theme === "light" ? 1 : 0;
      bg = rgb(getComputedStyle(canvas).backgroundColor) ?? bg;
    };

    const start = (): boolean => {
      // Software WebGL would run these on the processor: better the still picture.
      gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false, stencil: false, failIfMajorPerformanceCaveat: true });
      if (!gl) return false;
      const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
      const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT[scene]);
      const program = gl.createProgram();
      if (!vs || !fs || !program) return false;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
      gl.useProgram(program);
      // One triangle that covers the canvas.
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const at = gl.getAttribLocation(program, "aPos");
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
      uniforms = {};
      for (const name of ["uRes", "uTime", "uPointer", "uHover", "uLight", "uBg", "uPulse", "uTrade", "uValues"]) uniforms[name] = gl.getUniformLocation(program, name);
      return true;
    };

    /** Sets the canvas to its box (its own, whatever its parents' transforms) times the screen's density, inside the budget. */
    const size = (): boolean => {
      if (!gl) return false;
      dpr = window.devicePixelRatio || 1;
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      const scale = Math.min(dpr, 2, Math.sqrt((BUDGET[scene] * quality) / Math.max(1, cw * ch)));
      const w = Math.max(2, Math.round(cw * scale)), h = Math.max(2, Math.round(ch * scale));
      if (canvas.width === w && canvas.height === h) return false;
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      return true;
    };

    const draw = (now: number) => {
      if (!gl) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const held = still();
      if (!held) clock += dt;
      // The pointer is followed with a little weight, so the picture never snaps.
      const k = 1 - Math.exp(-dt * 6);
      eased.x += (target.x - eased.x) * k;
      eased.y += (target.y - eased.y) * k;
      eased.hover += (target.hover - eased.hover) * (1 - Math.exp(-dt * 4));
      const frozen = reduced.matches;
      gl.uniform2f(uniforms.uRes!, canvas.width, canvas.height);
      gl.uniform1f(uniforms.uTime!, frozen ? STILL : clock);
      gl.uniform2f(uniforms.uPointer!, frozen ? 0.5 : eased.x, frozen ? 0.5 : eased.y);
      gl.uniform1f(uniforms.uHover!, frozen ? 0 : eased.hover);
      gl.uniform1f(uniforms.uLight!, light);
      gl.uniform3f(uniforms.uBg!, bg[0], bg[1], bg[2]);
      gl.uniform3f(uniforms.uPulse!, pulse[0], pulse[1], frozen ? -100 : pulse[2]);
      if (uniforms.uTrade) gl.uniform4fv(uniforms.uTrade, trades);
      if (uniforms.uValues) gl.uniform1fv(uniforms.uValues, figures.current);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const loop = (now: number) => {
      frame = 0;
      if (disposed || !gl) return;
      const since = now - last;
      if (since >= FRAME_MS - 1) {
        // Frames that keep running long: draw fewer pixels from here on.
        if (since > 30 && since < 250) slow++;
        else slow = Math.max(0, slow - 0.25);
        if (slow > 24 && quality > 0.4) {
          quality *= 0.75;
          slow = 0;
          size();
        }
        if ((window.devicePixelRatio || 1) !== dpr) size();
        draw(now);
      }
      if (visible && !document.hidden && !still()) frame = requestAnimationFrame(loop);
    };
    /** Draws now, and keeps drawing if it should be moving. */
    const wake = () => {
      if (!gl || disposed) return;
      if (frame) return;
      last = performance.now() - FRAME_MS;
      frame = requestAnimationFrame(loop);
    };

    const where = (x: number, y: number) => {
      const box = canvas.getBoundingClientRect();
      return [Math.min(1, Math.max(0, (x - box.left) / box.width)), 1 - Math.min(1, Math.max(0, (y - box.top) / box.height))] as const;
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      [target.x, target.y] = where(e.clientX, e.clientY);
      target.hover = 1;
    };
    const leave = () => {
      target.hover = 0;
    };
    // A click, not a touch going down: a finger that scrolls the page past isn't a press.
    const press = (e: MouseEvent) => {
      const [x, y] = where(e.clientX, e.clientY);
      pulse = [x, y, clock];
    };
    // An event to show: size from 0 to 1, hue along the wire's gradient.
    const trade = (e: Event) => {
      const d = (e as CustomEvent<{ size?: number; hue?: number }>).detail ?? {};
      trades.set([clock, Math.min(1, Math.max(0.05, d.size ?? 0.3)), Math.min(1, Math.max(0, d.hue ?? 0.5)), 0], nextTrade * 4);
      nextTrade = (nextTrade + 1) % 8;
    };
    canvas.addEventListener("stage-trade", trade);
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    host.addEventListener("click", press);

    const begin = (): boolean => {
      if (!start()) {
        gl = null;
        return false;
      }
      readTheme();
      size();
      return true;
    };
    const seen = new IntersectionObserver(
      (entries) => {
        visible = entries[entries.length - 1]?.isIntersecting ?? false;
        if (!visible || disposed) return;
        if (!gl && !begin()) {
          seen.disconnect();
          setFlat(true);
          return;
        }
        wake();
      },
      { rootMargin: "120px" },
    );
    seen.observe(canvas);
    // Sizing a canvas clears it: draw again at once, or every step of a resize flashes empty.
    const resized = new ResizeObserver(() => {
      if (size()) draw(performance.now());
      wake();
    });
    resized.observe(canvas);
    // The theme switch changes the page's colours a moment after the attribute: read them on the next frame.
    const themed = new MutationObserver(() =>
      requestAnimationFrame(() => {
        readTheme();
        draw(performance.now());
        wake();
      }),
    );
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const shown = () => wake();
    document.addEventListener("visibilitychange", shown);
    document.addEventListener(MOTION_EVENT, shown);
    reduced.addEventListener("change", shown);
    // A lost context (the GPU reset, or too many on the page) comes back: wait for it, then start over.
    const lost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(frame);
      frame = 0;
      gl = null;
    };
    const restored = () => {
      if (disposed) return;
      if (begin()) wake();
      else setFlat(true);
    };
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      seen.disconnect();
      resized.disconnect();
      themed.disconnect();
      document.removeEventListener("visibilitychange", shown);
      document.removeEventListener(MOTION_EVENT, shown);
      reduced.removeEventListener("change", shown);
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      canvas.removeEventListener("stage-trade", trade);
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
      host.removeEventListener("click", press);
      // Give the context back now: a browser allows only so many, and a page left behind would hold its own.
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [scene, flat]);

  const cls = `${className ?? ""}${flat ? " is-flat" : ""}`.trim();
  // Keyed by scene: a canvas whose context was given back can't start another.
  return flat ? <div className={cls} data-scene={scene} aria-hidden="true" /> : <canvas key={scene} ref={ref} className={cls} data-scene={scene} aria-hidden="true" />;
}

/**
 * A page header's picture: the scene behind the words, the scrim that keeps the words readable, and the pause switch.
 * The header itself is what the picture follows the pointer over: give it data-stage-host. A scene made for a card
 * (a game's) keeps to the header's right side with "side"; one made for a header fills it and finds its own place.
 */
export function PageStage({ scene, values, side }: { scene: SceneName; values?: readonly number[]; side?: boolean }) {
  return (
    <>
      <ShaderCanvas scene={scene} values={values} className={side ? "page-stage is-side" : "page-stage"} />
      <div className="page-stage-scrim" aria-hidden="true" />
      <MotionSwitch className="arena-motion" />
    </>
  );
}

/**
 * The page's pause switch: holds every picture still, and lets them go again. Anything that moves on its own for more
 * than a few seconds needs one; reduced motion already holds them without it, so it isn't shown then (CSS).
 */
export function MotionSwitch({ className }: { className?: string }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) document.documentElement.setAttribute(PAUSED, "");
    else document.documentElement.removeAttribute(PAUSED);
    document.dispatchEvent(new Event(MOTION_EVENT));
    return () => document.documentElement.removeAttribute(PAUSED);
  }, [paused]);
  return (
    <button type="button" className={className} aria-pressed={paused} onClick={() => setPaused(!paused)}>
      <span aria-hidden="true">{paused ? "▶" : "❚❚"}</span> {paused ? "Play motion" : "Pause motion"}
    </button>
  );
}

/**
 * A card that leans toward the pointer, and the host its picture follows. Only where there's a pointer to lean toward
 * (a mouse), and never under reduced motion: the CSS reads --tilt-x and --tilt-y while the card is hovered.
 */
export function Tilt({ className, children, labelledBy }: { className?: string; children: ReactNode; labelledBy?: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !window.matchMedia("(hover: hover) and (pointer: fine)").matches || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const move = (e: PointerEvent) => {
      const box = el.getBoundingClientRect();
      const x = (e.clientX - box.left) / box.width, y = (e.clientY - box.top) / box.height;
      el.style.setProperty("--tilt-x", (x - 0.5).toFixed(3));
      el.style.setProperty("--tilt-y", (y - 0.5).toFixed(3));
      el.style.setProperty("--glare-x", `${(x * 100).toFixed(1)}%`);
      el.style.setProperty("--glare-y", `${(y * 100).toFixed(1)}%`);
    };
    const leave = () => {
      el.style.setProperty("--tilt-x", "0");
      el.style.setProperty("--tilt-y", "0");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, []);
  return (
    <article ref={ref} className={className} data-stage-host="" aria-labelledby={labelledBy} style={{ "--tilt-x": 0, "--tilt-y": 0 } as CSSProperties}>
      {children}
    </article>
  );
}
