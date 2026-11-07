"use client";

import { useEffect, useRef, useState } from "react";
import type * as Three from "three";
import type { TapeItem } from "../../lib/tape.ts";

// The homepage's live wire: higher.fun's real trades riding the Highwire wire. Buys run left to right, sells right to
// left, each pulse sized by its SOL; a launch ripples out from the wire and a graduation lights the whole of it. The
// tape comes from /api/tape every few seconds, and each event plays at its real spacing. Behind it, two wires out of
// focus and drifting bokeh give the depth. three.js loads only when the hero is on screen; reduced motion gets a still
// frame, and no WebGL gets a plain wire.

const POLL_MS = 5_000;
/** The feed counts as live while its newest event is this recent. */
const FRESH_MS = 120_000;
const MAX_PULSES = 48;
const TRAIL = 7;

type Status = "connecting" | "live" | "quiet" | "replay";

const fmtSol = (n: number) => (n > 0 && n < 0.001 ? "<0.001" : n.toLocaleString("en-US", { maximumFractionDigits: n >= 10 ? 1 : n >= 1 ? 2 : 3 }));

// The wire's own gradient, sampled along it.
const STOPS: [number, [number, number, number]][] = [
  [0, [0.969, 0.784, 0.298]],
  [0.35, [0.965, 0.663, 0.769]],
  [0.7, [0.576, 0.886, 0.984]],
  [1, [0.651, 0.937, 0.796]],
];
function wireColor(t: number): [number, number, number] {
  for (let i = 1; i < STOPS.length; i++) {
    const [b, cb] = STOPS[i]!;
    const [a, ca] = STOPS[i - 1]!;
    if (t <= b) {
      const k = (t - a) / (b - a);
      return [ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k];
    }
  }
  return STOPS[STOPS.length - 1]![1];
}

const GRADIENT_GLSL = /* glsl */ `
  vec3 wireGradient(float t) {
    vec3 a = vec3(0.969, 0.784, 0.298);
    vec3 b = vec3(0.965, 0.663, 0.769);
    vec3 c = vec3(0.576, 0.886, 0.984);
    vec3 d = vec3(0.651, 0.937, 0.796);
    if (t < 0.35) return mix(a, b, t / 0.35);
    if (t < 0.7) return mix(b, c, (t - 0.35) / 0.35);
    return mix(c, d, (t - 0.7) / 0.3);
  }
`;

const WIRE_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

// The wire: its gradient, lit up near each pulse. uGlow is the soft outer tube; uDim and uDesat push it out of focus.
const WIRE_FRAG = /* glsl */ `
  ${GRADIENT_GLSL}
  uniform float uTime;
  uniform float uFlash;
  uniform float uGlow;
  uniform float uDim;
  uniform float uDesat;
  uniform float uPulses[${MAX_PULSES}];
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float t = vUv.x;
    vec3 col = wireGradient(t);
    col = mix(col, vec3(dot(col, vec3(0.333))), uDesat);
    float lit = 0.0;
    for (int i = 0; i < ${MAX_PULSES}; i++) {
      float p = uPulses[i];
      if (p < 0.0) continue;
      lit += exp(-abs(t - p) * 60.0);
    }
    float facing = abs(dot(normalize(vNormal), normalize(vView)));
    float shimmer = 0.92 + 0.08 * sin(t * 40.0 - uTime * 1.6);
    if (uGlow > 0.5) {
      float a = pow(facing, 2.4) * (0.1 + 0.22 * min(lit, 1.0) + 0.35 * uFlash) * uDim;
      gl_FragColor = vec4(col, a);
    } else {
      vec3 c = col * (0.8 + 0.3 * facing) * shimmer + col * min(lit, 1.0) * 0.45 + vec3(uFlash * 0.4);
      gl_FragColor = vec4(c * uDim, uDim);
    }
  }
`;

const POINT_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uPixel;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixel / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

// A pulse: a hot core and a soft halo.
const PULSE_FRAG = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float core = smoothstep(0.32, 0.0, d);
    float halo = pow(1.0 - d, 2.2) * 0.55;
    vec3 c = mix(vColor, vec3(1.0), core * 0.85);
    gl_FragColor = vec4(c, (core + halo) * vAlpha);
  }
`;

// Bokeh: soft discs with a brighter rim, as an out-of-focus lens draws them.
const BOKEH_FRAG = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float disc = smoothstep(1.0, 0.82, d);
    float rim = smoothstep(0.7, 0.95, d) * disc;
    gl_FragColor = vec4(vColor, (disc * 0.55 + rim * 0.5) * vAlpha);
  }
`;

// A launch: a ring expanding out of the wire.
const RING_FRAG = /* glsl */ `
  uniform float uProgress;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float r = uProgress;
    float ring = smoothstep(0.08, 0.0, abs(d - r)) * (1.0 - uProgress);
    gl_FragColor = vec4(vColor, ring * vAlpha);
  }
`;

interface Pulse {
  t: number;
  dir: 1 | -1;
  speed: number;
  size: number;
  life: number;
}

interface Scene {
  play(item: TapeItem): void;
  dispose(): void;
}

function startScene(THREE: typeof Three, stage: HTMLDivElement): Scene | null {
  let renderer: Three.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    return null;
  }
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.className = "livewire-canvas";
  stage.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
  const time = { value: 0 };
  const pixel = { value: 300 };

  // A wire hung between two heights, sagging between them, from z0 at its left end to z1 at its right. The main one
  // sweeps up across the frame from near the camera to deep behind it; two more hang far behind, out of focus.
  const wireCurve = (y0: number, y1: number, sag: number, z0: number, z1: number, width: number) => {
    const pts: Three.Vector3[] = [];
    for (let i = 0; i <= 48; i++) {
      const u = i / 48;
      const x = -width / 2 + u * width;
      const y = y0 + (y1 - y0) * u - sag * (1 - Math.pow(2 * u - 1, 2));
      pts.push(new THREE.Vector3(x, y, z0 + (z1 - z0) * u));
    }
    return new THREE.CatmullRomCurve3(pts);
  };
  const main = wireCurve(-7.6, 3.2, 2.4, 5, -9, 34);
  const pulseSlots = new Float32Array(MAX_PULSES).fill(-1);
  const flash = { value: 0 };
  const wireMat = (glow: boolean, dim: number, desat: number) =>
    keep(
      new THREE.ShaderMaterial({
        vertexShader: WIRE_VERT,
        fragmentShader: WIRE_FRAG,
        uniforms: { uTime: time, uFlash: flash, uGlow: { value: glow ? 1 : 0 }, uDim: { value: dim }, uDesat: { value: desat }, uPulses: { value: pulseSlots } },
        transparent: true,
        depthWrite: false,
        blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending,
      }),
    );
  const tube = (curve: Three.Curve<Three.Vector3>, r: number, mat: Three.Material) => {
    const m = new THREE.Mesh(keep(new THREE.TubeGeometry(curve, 400, r, 12, false)), mat);
    scene.add(m);
    return m;
  };
  tube(main, 0.06, wireMat(false, 1, 0));
  tube(main, 0.3, wireMat(true, 1.6, 0));
  for (const [y0, y1, sag, z, dim] of [
    [4.2, 2.6, 1.2, -12, 0.45],
    [-2.2, 0.4, 1.6, -18, 0.3],
  ] as const) {
    const back = wireCurve(y0, y1, sag, z, z, 56);
    tube(back, 0.06, wireMat(false, dim * 0.35, 0.35));
    tube(back, 0.55, wireMat(true, dim, 0.35));
  }

  // Bokeh: specks at many depths; the farther from the focal plane, the bigger and dimmer.
  const BOKEH = reduced ? 90 : 170;
  const bPos = new Float32Array(BOKEH * 3);
  const bSize = new Float32Array(BOKEH);
  const bAlpha = new Float32Array(BOKEH);
  const bColor = new Float32Array(BOKEH * 3);
  const bSeed = new Float32Array(BOKEH);
  for (let i = 0; i < BOKEH; i++) {
    const z = -16 + Math.random() * 20;
    bPos.set([(Math.random() - 0.5) * 40, (Math.random() - 0.5) * 18, z], i * 3);
    const blur = Math.abs(z) / 16;
    // World units: a lens blurs what's far from the focal plane into bigger, fainter discs.
    bSize[i] = 0.05 + blur * blur * 1.1 + Math.random() * 0.06;
    bAlpha[i] = (0.035 + Math.random() * 0.08) * (1.1 - blur * 0.7);
    const warm = Math.random() < 0.5;
    bColor.set(warm ? [1, 0.82, 0.62] : [0.62, 0.86, 1], i * 3);
    bSeed[i] = Math.random() * 100;
  }
  const bGeo = keep(new THREE.BufferGeometry());
  bGeo.setAttribute("position", new THREE.BufferAttribute(bPos, 3));
  bGeo.setAttribute("aSize", new THREE.BufferAttribute(bSize, 1));
  bGeo.setAttribute("aAlpha", new THREE.BufferAttribute(bAlpha, 1));
  bGeo.setAttribute("aColor", new THREE.BufferAttribute(bColor, 3));
  const bokeh = new THREE.Points(bGeo, keep(new THREE.ShaderMaterial({ vertexShader: POINT_VERT, fragmentShader: BOKEH_FRAG, uniforms: { uPixel: pixel }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
  scene.add(bokeh);

  // Pulses and their trails: one point per trail step, positions written each frame.
  const N = MAX_PULSES * TRAIL;
  const pPos = new Float32Array(N * 3);
  const pSize = new Float32Array(N);
  const pAlpha = new Float32Array(N);
  const pColor = new Float32Array(N * 3);
  const pGeo = keep(new THREE.BufferGeometry());
  pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute("aSize", new THREE.BufferAttribute(pSize, 1));
  pGeo.setAttribute("aAlpha", new THREE.BufferAttribute(pAlpha, 1));
  pGeo.setAttribute("aColor", new THREE.BufferAttribute(pColor, 3));
  const points = new THREE.Points(pGeo, keep(new THREE.ShaderMaterial({ vertexShader: POINT_VERT, fragmentShader: PULSE_FRAG, uniforms: { uPixel: pixel }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
  points.frustumCulled = false;
  scene.add(points);
  const pulses: (Pulse | null)[] = new Array(MAX_PULSES).fill(null);

  // Launch rings, a few at a time.
  const rings: { mesh: Three.Points; progress: { value: number } }[] = [];
  function ring(t: number) {
    const p = main.getPointAt(t);
    const geo = keep(new THREE.BufferGeometry());
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([p.x, p.y, p.z]), 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array([2.6]), 1));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array([0.9]), 1));
    geo.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(wireColor(t)), 3));
    const progress = { value: 0 };
    const mesh = new THREE.Points(geo, keep(new THREE.ShaderMaterial({ vertexShader: POINT_VERT, fragmentShader: RING_FRAG, uniforms: { uPixel: pixel, uProgress: progress }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
    scene.add(mesh);
    rings.push({ mesh, progress });
  }

  function writePulses() {
    const tmp = new THREE.Vector3();
    for (let i = 0; i < MAX_PULSES; i++) {
      const p = pulses[i];
      pulseSlots[i] = p ? p.t : -1;
      for (let k = 0; k < TRAIL; k++) {
        const j = i * TRAIL + k;
        if (!p) {
          pAlpha[j] = 0;
          continue;
        }
        const t = Math.min(1, Math.max(0, p.t - p.dir * k * 0.006));
        main.getPointAt(t, tmp);
        pPos.set([tmp.x, tmp.y, tmp.z], j * 3);
        const fade = 1 - k / TRAIL;
        // Fades in as it starts, and out at either end of the wire.
        const life = Math.min(1, p.life * 2, p.t * 14, (1 - p.t) * 14);
        pSize[j] = p.size * (k === 0 ? 1 : 0.55 * fade);
        pAlpha[j] = life * (k === 0 ? 1 : 0.5 * fade * fade);
        pColor.set(wireColor(t), j * 3);
      }
    }
    for (const name of ["position", "aSize", "aAlpha", "aColor"]) (pGeo.getAttribute(name) as Three.BufferAttribute).needsUpdate = true;
  }

  let frames = 0;
  let nextStill = 0;
  function play(item: TapeItem) {
    if (item.kind === "graduation") {
      flash.value = 1;
      frames = 200;
      return;
    }
    if (item.kind === "launch") {
      ring(0.15 + Math.random() * 0.7);
      frames = 200;
      return;
    }
    // A still frame never clears its pulses, so it reuses slots, oldest first.
    let slot = pulses.findIndex((p) => p === null);
    if (slot < 0) {
      if (!reduced) return;
      slot = nextStill++ % MAX_PULSES;
    }
    const dir = item.kind === "buy" ? 1 : -1;
    const sol = item.sol ?? 0.05;
    pulses[slot] = {
      t: reduced ? 0.12 + Math.random() * 0.76 : dir > 0 ? 0 : 1,
      dir,
      speed: 0.11 + Math.random() * 0.05,
      size: 0.3 + Math.min(0.7, Math.log10(1 + sol * 40) * 0.24),
      life: reduced ? 1 : 0,
    };
    frames = 200;
  }

  // Size, pointer parallax, visibility.
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  const onPointer = (e: PointerEvent) => {
    const r = stage.getBoundingClientRect();
    pointer.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    pointer.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
  };
  window.addEventListener("pointermove", onPointer, { passive: true });
  const resize = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Narrow screens pull back, so the wire still spans the frame.
    camera.position.set(0, -0.6, w / h < 1 ? 26 : 17);
    camera.updateProjectionMatrix();
    pixel.value = (h * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360));
    frames = Math.max(frames, 2);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();
  let visible = true;
  const vis = new IntersectionObserver((es) => (visible = es.some((e) => e.isIntersecting)));
  vis.observe(stage);

  const clock = new THREE.Clock();
  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    if (!visible) return;
    if (reduced && frames <= 0) return;
    frames--;
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!reduced) {
      time.value += dt;
      for (let i = 0; i < MAX_PULSES; i++) {
        const p = pulses[i];
        if (!p) continue;
        p.life += dt;
        p.t += p.dir * p.speed * dt;
        if (p.t > 1.02 || p.t < -0.02) pulses[i] = null;
      }
      for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i]!;
        r.progress.value += dt * 0.45;
        if (r.progress.value >= 1) {
          scene.remove(r.mesh);
          rings.splice(i, 1);
        }
      }
      flash.value = Math.max(0, flash.value - dt * 0.6);
      for (let i = 0; i < BOKEH; i++) {
        const s = bSeed[i]!;
        bPos[i * 3] = bPos[i * 3]! + Math.sin(time.value * 0.05 + s) * dt * 0.08;
        bPos[i * 3 + 1] = bPos[i * 3 + 1]! + Math.cos(time.value * 0.04 + s) * dt * 0.05;
      }
      (bGeo.getAttribute("position") as Three.BufferAttribute).needsUpdate = true;
      pointer.x += (pointer.tx - pointer.x) * 0.04;
      pointer.y += (pointer.ty - pointer.y) * 0.04;
      frames = 2;
    }
    writePulses();
    camera.position.x = pointer.x * 0.9 + Math.sin(time.value * 0.07) * 0.4;
    camera.position.y = -0.6 - pointer.y * 0.5;
    camera.lookAt(1.5, -0.4, -2);
    renderer.render(scene, camera);
  };
  loop();

  return {
    play,
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      vis.disconnect();
      window.removeEventListener("pointermove", onPointer);
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

interface Shown extends TapeItem {
  key: string;
}

export function LiveWire({ initial }: { initial: TapeItem[] }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  // Trades that arrive before three.js has loaded; the latest few play once the scene is up.
  const pending = useRef<TapeItem[]>([]);
  const [mode, setMode] = useState<"idle" | "running" | "flat">("idle");
  const [status, setStatus] = useState<Status>("connecting");
  const [shown, setShown] = useState<Shown[]>([]);
  const [count, setCount] = useState({ trades: 0, sol: 0 });

  // three.js only once the hero is near the screen.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let disposed = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || sceneRef.current || disposed) return;
        io.disconnect();
        import("three")
          .then((THREE) => {
            if (disposed) return;
            sceneRef.current = startScene(THREE, stage);
            setMode(sceneRef.current ? "running" : "flat");
            pending.current.slice(-6).forEach((item, i) => setTimeout(() => sceneRef.current?.play(item), i * 450));
            pending.current = [];
          })
          .catch(() => setMode("flat"));
      },
      { rootMargin: "200px" },
    );
    io.observe(stage);
    return () => {
      disposed = true;
      io.disconnect();
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  // The tape: replay what the page was built with, then poll and play each new event at its real spacing.
  useEffect(() => {
    const seen = new Set<string>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let stopped = false;
    let newest = 0;
    const emit = (item: TapeItem) => {
      if (stopped) return;
      if (sceneRef.current) sceneRef.current.play(item);
      else pending.current.push(item);
      setShown((s) => [{ ...item, key: `${item.id}-${Date.now()}` }, ...s].slice(0, 4));
      if (item.kind === "buy" || item.kind === "sell") setCount((c) => ({ trades: c.trades + 1, sol: c.sol + (item.sol ?? 0) }));
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
    // What the page was built with plays first, quickly: it's the recent past.
    schedule(initial.slice(0, 14), 6_000);
    const poll = async () => {
      try {
        const res = await fetch("/api/tape", { cache: "no-store" });
        const body = (await res.json()) as { items?: TapeItem[] };
        if (!res.ok || !body.items) throw new Error("tape");
        schedule(body.items, POLL_MS);
        setStatus(Date.now() - newest < FRESH_MS ? "live" : "quiet");
      } catch {
        setStatus("replay");
      }
    };
    void poll();
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(iv);
      for (const t of timers) clearTimeout(t);
    };
  }, [initial]);

  const label = { connecting: "Connecting", live: "Live", quiet: "Live · quiet", replay: "Replay" }[status];
  return (
    <div className="livewire" ref={stageRef} data-mode={mode} aria-hidden="true">
      {mode === "flat" ? (
        <svg className="livewire-flat" viewBox="0 0 1000 300" preserveAspectRatio="none">
          <defs>
            <linearGradient id="lw-flat" x1="0" x2="1">
              <stop offset="0" stopColor="#F7C84C" />
              <stop offset=".35" stopColor="#F6A9C4" />
              <stop offset=".7" stopColor="#93E2FB" />
              <stop offset="1" stopColor="#A6EFCB" />
            </linearGradient>
          </defs>
          <path d="M0 120 Q500 290 1000 120" fill="none" stroke="url(#lw-flat)" strokeWidth="3" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : null}
      <div className="livewire-vignette" />
      <div className="livewire-corner livewire-tr">
        <span className="livewire-dot" data-status={status} />
        {label} · higher.fun tape
      </div>
      <ol className="livewire-corner livewire-bl">
        {shown.map((e) => (
          <li key={e.key} data-kind={e.kind}>
            <span className="livewire-kind">{e.kind}</span>
            {e.ticker ? <span>${e.ticker}</span> : null}
            {e.sol != null && (e.kind === "buy" || e.kind === "sell") ? <span>{fmtSol(e.sol)} SOL</span> : null}
          </li>
        ))}
      </ol>
      <div className="livewire-corner livewire-br">
        {count.trades ? `${count.trades} trades · ${fmtSol(count.sol)} SOL on the wire so far` : "Every pulse is a real trade"}
      </div>
    </div>
  );
}
