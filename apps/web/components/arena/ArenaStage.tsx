"use client";

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { FRAGMENT, type SceneName, VERTEX } from "./shaders.ts";

// The arena's moving pictures (shaders.ts), each a fragment shader on one canvas: plain WebGL, nothing downloaded. A
// canvas starts when it's near the screen and stops when it leaves; it follows the pointer over its host (the nearest
// [data-stage-host], or itself), the site's theme, and the colour behind it. Reduced motion gets one still frame, and a
// browser without WebGL the CSS behind the canvas. All decoration: hidden from assistive technology.

/** The most pixels a canvas draws: a phone's GPU runs the raymarched scenes comfortably under this. */
const BUDGET: Record<SceneName, number> = { clash: 1_500_000, line: 520_000, link: 520_000, next: 300_000 };
/** The frame a still picture shows (reduced motion). */
const STILL = 14;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  console.warn(`The arena's shader didn't compile: ${gl.getShaderInfoLog(shader) ?? ""}`);
  gl.deleteShader(shader);
  return null;
}

/** "rgb(10, 12, 16)" as three numbers from 0 to 1. */
function rgb(css: string): [number, number, number] | null {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css);
  return m ? [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255] : null;
}

export function ShaderCanvas({ scene, className }: { scene: SceneName; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
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
    let last = performance.now();
    let clock = 0;
    const target = { x: 0.5, y: 0.5, hover: 0 };
    const eased = { x: 0.5, y: 0.5, hover: 0 };
    let pulse: [number, number, number] = [0.5, 0.5, -100];
    let bg: [number, number, number] = [0.04, 0.047, 0.063];
    let light = 0;

    const readTheme = () => {
      light = document.documentElement.dataset.theme === "light" ? 1 : 0;
      bg = rgb(getComputedStyle(canvas).backgroundColor) ?? bg;
    };

    const start = (): boolean => {
      gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false, stencil: false });
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
      for (const name of ["uRes", "uTime", "uPointer", "uHover", "uLight", "uBg", "uPulse"]) uniforms[name] = gl.getUniformLocation(program, name);
      return true;
    };

    const size = () => {
      if (!gl) return;
      const box = canvas.getBoundingClientRect();
      const scale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(BUDGET[scene] / Math.max(1, box.width * box.height)));
      const w = Math.max(2, Math.round(box.width * scale)), h = Math.max(2, Math.round(box.height * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };

    const draw = (now: number) => {
      if (!gl) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      clock += dt;
      // The pointer is followed with a little weight, so the picture never snaps.
      const k = 1 - Math.exp(-dt * 6);
      eased.x += (target.x - eased.x) * k;
      eased.y += (target.y - eased.y) * k;
      eased.hover += (target.hover - eased.hover) * (1 - Math.exp(-dt * 4));
      const still = reduced.matches;
      gl.uniform2f(uniforms.uRes!, canvas.width, canvas.height);
      gl.uniform1f(uniforms.uTime!, still ? STILL : clock);
      gl.uniform2f(uniforms.uPointer!, still ? 0.5 : eased.x, still ? 0.5 : eased.y);
      gl.uniform1f(uniforms.uHover!, still ? 0 : eased.hover);
      gl.uniform1f(uniforms.uLight!, light);
      gl.uniform3f(uniforms.uBg!, bg[0], bg[1], bg[2]);
      gl.uniform3f(uniforms.uPulse!, pulse[0], pulse[1], still ? -100 : pulse[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const loop = (now: number) => {
      draw(now);
      frame = visible && !document.hidden && !reduced.matches ? requestAnimationFrame(loop) : 0;
    };
    const wake = () => {
      if (!gl || frame) return;
      last = performance.now();
      frame = requestAnimationFrame(loop);
    };

    const where = (e: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      return [Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)), 1 - Math.min(1, Math.max(0, (e.clientY - box.top) / box.height))] as const;
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      [target.x, target.y] = where(e);
      target.hover = 1;
    };
    const leave = () => {
      target.hover = 0;
    };
    const press = (e: PointerEvent) => {
      const [x, y] = where(e);
      pulse = [x, y, clock];
    };
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    host.addEventListener("pointerdown", press);

    const seen = new IntersectionObserver(
      (entries) => {
        visible = entries.some((e) => e.isIntersecting);
        if (!visible) return;
        if (!gl) {
          if (!start()) {
            gl = null;
            seen.disconnect();
            setFlat(true);
            return;
          }
          readTheme();
          size();
        }
        wake();
      },
      { rootMargin: "120px" },
    );
    seen.observe(canvas);
    const resized = new ResizeObserver(() => {
      size();
      wake();
    });
    resized.observe(canvas);
    // The theme switch changes the page's colours a moment after the attribute: read them on the next frame.
    const themed = new MutationObserver(() => requestAnimationFrame(() => (readTheme(), wake())));
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const shown = () => wake();
    document.addEventListener("visibilitychange", shown);
    reduced.addEventListener("change", shown);
    const lost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(frame);
      frame = 0;
      gl = null;
      uniforms = {};
      setFlat(true);
    };
    canvas.addEventListener("webglcontextlost", lost);

    return () => {
      cancelAnimationFrame(frame);
      seen.disconnect();
      resized.disconnect();
      themed.disconnect();
      document.removeEventListener("visibilitychange", shown);
      reduced.removeEventListener("change", shown);
      canvas.removeEventListener("webglcontextlost", lost);
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
      host.removeEventListener("pointerdown", press);
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [scene]);

  return <canvas ref={ref} className={`${className ?? ""}${flat ? " is-flat" : ""}`.trim()} data-scene={scene} aria-hidden="true" />;
}

/**
 * A card that leans toward the pointer, and the host its picture follows. Only where there's a pointer to lean toward
 * (a mouse), and never under reduced motion: the CSS reads --tilt-x and --tilt-y, which stay 0 otherwise.
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
