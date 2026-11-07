"use client";

import { useEffect, useRef, useState } from "react";
import type * as Three from "three";

// "Where a trade's fee goes", in 3D: a trade's fee comes in on the left, reaches
// the core and splits along a wire to each recipient. A wire's thickness, its
// particles and its node's size follow that recipient's share of the fee, with
// the rates read on-chain. three.js loads only when the scene scrolls into view;
// the list under it says the same thing in text, and stands in when WebGL can't
// run.

export type FlowKey = "creator" | "higher.fun" | "holders" | "Raydium" | "liquidity";
export type Scenario = "curve-rewards" | "curve-classic" | "pool-rewards" | "pool-classic";

export interface Flow {
  key: FlowKey;
  label: string;
  color: string;
  /** Percent of each trade. */
  ratePct: number;
  /** SOL paid to this recipient in this phase and mode so far. */
  soFarSol: number;
  detail: string;
}

export interface FlowScenario {
  totalPct: number;
  flows: Flow[];
  /** New school pools: the creator's third of the locked-LP fees, paid by higher.fun off-chain. */
  hopPct: number | null;
  /** New school pools: the share of the liquidity that's locked, in percent. */
  lockedPct: number | null;
}

const NODES: Record<FlowKey, [number, number, number]> = {
  creator: [2.7, 2.35, -0.7],
  holders: [3.45, 1.2, 0.5],
  "higher.fun": [3.55, 0.05, 0.9],
  Raydium: [3.35, -1.1, -1.0],
  liquidity: [2.55, -2.3, 0.45],
};
const CORE: [number, number, number] = [-2.4, 0, 0];
const SOURCE: [number, number, number] = [-7.5, -0.5, 0.4];
const PARTICLES = 260;

const fmtPct = (n: number) => `${Number(n.toFixed(4))}%`;
const fmtSol = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : n >= 1 ? 1 : n > 0 ? 3 : 0 });

// --- shaders -----------------------------------------------------------------

const NOISE = /* glsl */ `
  vec3 hash3(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
  }
  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(dot(hash3(i), f), dot(hash3(i + vec3(1, 0, 0)), f - vec3(1, 0, 0)), u.x),
                   mix(dot(hash3(i + vec3(0, 1, 0)), f - vec3(0, 1, 0)), dot(hash3(i + vec3(1, 1, 0)), f - vec3(1, 1, 0)), u.x), u.y),
               mix(mix(dot(hash3(i + vec3(0, 0, 1)), f - vec3(0, 0, 1)), dot(hash3(i + vec3(1, 0, 1)), f - vec3(1, 0, 1)), u.x),
                   mix(dot(hash3(i + vec3(0, 1, 1)), f - vec3(0, 1, 1)), dot(hash3(i + vec3(1, 1, 1)), f - vec3(1, 1, 1)), u.x), u.y), u.z);
  }
`;

/** The wire: a tube whose radius is a uniform, with light pulses travelling from the core outwards. */
const WIRE_VERT = /* glsl */ `
  uniform float uR;
  uniform float uR0;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    vUv = uv;
    vec3 p = position + normal * (uR - uR0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vView = -mv.xyz;
    vN = normalMatrix * normal;
    gl_Position = projectionMatrix * mv;
  }
`;
const WIRE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uFrom;
  uniform float uTime;
  uniform float uIntensity;
  uniform float uDash;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    float along = vUv.x;
    float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), 1.6);
    float w = fract(along * 5.0 - uTime * 0.55);
    float pulse = smoothstep(0.0, 0.08, w) * (1.0 - smoothstep(0.08, 0.42, w));
    float dash = mix(1.0, step(0.5, fract(along * 26.0 - uTime * 0.8)), uDash);
    vec3 col = mix(uFrom, uColor, smoothstep(0.0, 0.45, along));
    float a = (0.14 + 0.55 * fres + 0.85 * pulse) * uIntensity * dash;
    a *= smoothstep(0.0, 0.05, along) * (1.0 - smoothstep(0.95, 1.0, along));
    gl_FragColor = vec4(col * (0.55 + 0.9 * pulse), a);
  }
`;

/** Particles riding a wire: soft discs whose colour follows how far along they are. */
const DOT_VERT = /* glsl */ `
  uniform float uDensity;
  uniform float uSize;
  uniform float uPixelRatio;
  attribute float aRank;
  attribute float aSeed;
  attribute float aT;
  varying float vOn;
  varying float vT;
  varying float vSeed;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    vOn = step(aRank, uDensity);
    vT = aT;
    vSeed = aSeed;
    gl_PointSize = vOn * uSize * uPixelRatio * (0.55 + 0.9 * aSeed) * (9.0 / -mv.z);
  }
`;
const DOT_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uFrom;
  uniform float uIntensity;
  varying float vOn;
  varying float vT;
  varying float vSeed;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = pow(smoothstep(0.5, 0.0, d), 2.2);
    vec3 col = mix(uFrom, uColor, smoothstep(0.0, 0.4, vT));
    float fade = smoothstep(0.0, 0.06, vT) * (1.0 - smoothstep(0.9, 1.0, vT));
    gl_FragColor = vec4(col * 1.25, a * vOn * uIntensity * fade * (0.55 + 0.45 * vSeed));
  }
`;

/** A recipient: a glassy sphere, bright at the rim, with a slow shimmer. */
const NODE_VERT = /* glsl */ `
  uniform float uTime;
  varying vec3 vN;
  varying vec3 vView;
  varying vec3 vPos;
  ${NOISE}
  void main() {
    vPos = position;
    vec3 p = position * (1.0 + 0.05 * noise(position * 2.2 + uTime * 0.35));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vView = -mv.xyz;
    vN = normalMatrix * normal;
    gl_Position = projectionMatrix * mv;
  }
`;
const NODE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uIntensity;
  varying vec3 vN;
  varying vec3 vView;
  varying vec3 vPos;
  ${NOISE}
  void main() {
    float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), 2.2);
    float swirl = 0.5 + 0.5 * noise(vPos * 3.0 + vec3(0.0, uTime * 0.4, 0.0));
    vec3 core = uColor * (0.18 + 0.35 * swirl);
    vec3 col = core + uColor * fres * 1.6 + vec3(1.0) * pow(fres, 4.0) * 0.6;
    gl_FragColor = vec4(col * uIntensity, (0.55 + 0.45 * fres) * clamp(uIntensity, 0.0, 1.0));
  }
`;

/** The trade core: an iridescent, breathing orb in the brand's wire colours. */
const CORE_VERT = /* glsl */ `
  uniform float uTime;
  varying vec3 vN;
  varying vec3 vView;
  varying vec3 vPos;
  varying float vBump;
  ${NOISE}
  void main() {
    float n = noise(position * 1.6 + uTime * 0.25);
    vBump = n;
    vec3 p = position * (1.0 + 0.12 * n);
    vPos = p;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vView = -mv.xyz;
    vN = normalMatrix * normal;
    gl_Position = projectionMatrix * mv;
  }
`;
const CORE_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec3 vN;
  varying vec3 vView;
  varying vec3 vPos;
  varying float vBump;
  vec3 wire(float t) {
    t = fract(t);
    vec3 y = vec3(0.969, 0.784, 0.298);
    vec3 p = vec3(0.965, 0.663, 0.769);
    vec3 b = vec3(0.576, 0.886, 0.984);
    vec3 g = vec3(0.651, 0.937, 0.796);
    if (t < 0.25) return mix(y, p, t * 4.0);
    if (t < 0.5) return mix(p, b, (t - 0.25) * 4.0);
    if (t < 0.75) return mix(b, g, (t - 0.5) * 4.0);
    return mix(g, y, (t - 0.75) * 4.0);
  }
  void main() {
    float ndv = abs(dot(normalize(vN), normalize(vView)));
    float fres = pow(1.0 - ndv, 1.8);
    vec3 irid = wire(fres * 0.9 + vPos.y * 0.18 + vBump * 0.6 + uTime * 0.05);
    vec3 col = irid * (0.35 + 1.4 * fres) + vec3(1.0) * pow(fres, 5.0) * 0.8;
    gl_FragColor = vec4(col, 0.92);
  }
`;

/** The backdrop: deep ink with slow, faint bands of the wire colours. */
const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec3 vDir;
  ${NOISE}
  void main() {
    vec3 ink = vec3(0.027, 0.035, 0.047);
    float n1 = noise(vDir * 2.4 + vec3(uTime * 0.03, 0.0, uTime * 0.02));
    float n2 = noise(vDir * 4.0 - vec3(0.0, uTime * 0.025, 0.0));
    vec3 aurora = mix(vec3(0.576, 0.886, 0.984), vec3(0.965, 0.663, 0.769), smoothstep(-0.4, 0.6, n2));
    aurora = mix(aurora, vec3(0.651, 0.937, 0.796), smoothstep(0.2, 0.9, n1));
    float band = smoothstep(0.05, 0.75, n1 * 0.6 + n2 * 0.5 + 0.25) * smoothstep(-0.8, 0.4, vDir.y);
    gl_FragColor = vec4(ink + aurora * band * 0.11, 1.0);
  }
`;

// --- the component -----------------------------------------------------------

export function FeeFlow({ scenarios }: { scenarios: Record<Scenario, FlowScenario> }) {
  const [phase, setPhase] = useState<"curve" | "pool">("curve");
  const [mode, setMode] = useState<"rewards" | "classic">("rewards");
  const [state, setState] = useState<"idle" | "running" | "unsupported">("idle");
  const stageRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const sceneApi = useRef<{ show: (s: FlowScenario) => void } | null>(null);
  const scenario = scenarios[`${phase}-${mode}`];

  useEffect(() => {
    sceneApi.current?.show(scenario);
  }, [scenario]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || cleanup || disposed) return;
        io.disconnect();
        import("three")
          .then((THREE) => {
            if (disposed) return;
            cleanup = startScene(THREE, stage, labelsRef.current!, scenarios[`${phase}-${mode}`], sceneApi);
            setState(cleanup ? "running" : "unsupported");
          })
          .catch(() => setState("unsupported"));
      },
      { rootMargin: "200px" },
    );
    io.observe(stage);
    return () => {
      disposed = true;
      io.disconnect();
      cleanup?.();
      sceneApi.current = null;
    };
    // The scene is built once; scenario changes go through sceneApi.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flows = scenario.flows;
  return (
    <figure className="flow">
      <div className="flow-controls">
        <div className="flow-toggle" role="group" aria-label="Where the trade happens">
          {(["curve", "pool"] as const).map((p) => (
            <button key={p} type="button" aria-pressed={phase === p} onClick={() => setPhase(p)}>
              {p === "curve" ? "On the bonding curve" : "In the Raydium pool"}
            </button>
          ))}
        </div>
        <div className="flow-toggle" role="group" aria-label="Fee mode">
          {(["rewards", "classic"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === "rewards" ? "New school" : "Old school"}
            </button>
          ))}
        </div>
      </div>
      <div className="flow-stage" ref={stageRef} data-state={state} aria-hidden="true">
        <div className="flow-labels" ref={labelsRef}>
          <div className="flow-label flow-label-in" data-node="in">
            <span className="flow-label-name">Every trade</span>
            <span className="flow-label-rate">pays {fmtPct(scenario.totalPct)}</span>
          </div>
          {flows.map((f) => (
            <div key={f.key} className="flow-label" data-node={f.key} data-zero={f.ratePct === 0 || undefined}>
              <span className="flow-label-name" style={{ color: f.color }}>
                {f.label}
              </span>
              <span className="flow-label-rate">{f.ratePct > 0 ? `${fmtPct(f.ratePct)} of each trade` : "nothing here"}</span>
              {f.key === "creator" && scenario.hopPct ? (
                <span className="flow-label-hop">incl. {fmtPct(scenario.hopPct)} via higher.fun, off-chain</span>
              ) : null}
              {f.soFarSol > 0 ? <span className="flow-label-sol">{fmtSol(f.soFarSol)} SOL so far</span> : null}
            </div>
          ))}
        </div>
        {state === "unsupported" ? <p className="flow-fallback">This diagram needs WebGL. The same split is listed below.</p> : null}
      </div>
      <figcaption>
        <p className="flow-caption">
          {phase === "curve"
            ? mode === "rewards"
              ? "On the curve, a New school trade pays 1%: half to higher.fun, a quarter to the creator and a quarter to Raydium. higher.fun passes half of its share on to the coin's holders, as SOL airdrops."
              : "On the curve, an Old school trade pays only Raydium's 0.25%. higher.fun takes 1% of the supply at graduation instead."
            : mode === "rewards"
              ? `In the pool, every trade pays ${fmtPct(scenario.totalPct)}. Most is LP fees: the burned ${100 - (scenario.lockedPct ?? 30)}% of the liquidity keeps its share in the pool, and the locked ${scenario.lockedPct ?? 30}%'s share goes to higher.fun's Fee Key, which passes a third to the creator.`
              : `In the pool, every trade pays ${fmtPct(scenario.totalPct)}. All of an Old school coin's starting liquidity is burned, so its LP fees stay in the pool.`}
        </p>
        <ul className="flow-list">
          {flows.map((f) => (
            <li key={f.key}>
              <span className="split-swatch" style={{ background: f.color }} aria-hidden="true" />
              <span>
                <strong>{f.label}</strong>{" "}
                <span className="flow-list-rate">{f.ratePct > 0 ? `${fmtPct(f.ratePct)} of each trade` : "nothing"}</span>
                {f.soFarSol > 0 ? <span className="muted"> · {fmtSol(f.soFarSol)} SOL so far</span> : null}
                <span className="muted small flow-list-detail">{f.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

// --- the scene -----------------------------------------------------------------

type Api = { current: { show: (s: FlowScenario) => void } | null };

interface Stream {
  key: FlowKey | "in" | "hop";
  curve: Three.CatmullRomCurve3;
  wire: Three.ShaderMaterial;
  dots: Three.ShaderMaterial;
  dotGeo: Three.BufferGeometry;
  offsets: Float32Array;
  speeds: Float32Array;
  node?: { mesh: Three.Mesh; mat: Three.ShaderMaterial; halo: Three.Sprite; haloMat: Three.SpriteMaterial };
  target: { r: number; density: number; intensity: number; size: number };
  now: { r: number; density: number; intensity: number; size: number };
}

function startScene(THREE: typeof Three, stage: HTMLDivElement, labels: HTMLDivElement, first: FlowScenario, api: Api): (() => void) | undefined {
  let renderer: Three.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  } catch {
    return undefined;
  }
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x07090c, 1);
  stage.prepend(renderer.domElement);
  renderer.domElement.className = "flow-canvas";

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  const look = new THREE.Vector3(0.9, 0, 0);
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(d: T) => (disposables.push(d), d);
  const time = { value: 0 };

  // Backdrop and stars.
  const sky = new THREE.Mesh(
    keep(new THREE.SphereGeometry(60, 48, 32)),
    keep(new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: { uTime: time }, side: THREE.BackSide, depthWrite: false })),
  );
  scene.add(sky);
  const starGeo = keep(new THREE.BufferGeometry());
  const stars = new Float32Array(900 * 3);
  for (let i = 0; i < 900; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(18 + Math.random() * 20);
    stars.set([v.x, v.y, v.z], i * 3);
  }
  starGeo.setAttribute("position", new THREE.BufferAttribute(stars, 3));
  scene.add(new THREE.Points(starGeo, keep(new THREE.PointsMaterial({ color: 0xc8d3e0, size: 0.045, transparent: true, opacity: 0.55, depthWrite: false }))));

  // The core.
  const coreMesh = new THREE.Mesh(
    keep(new THREE.IcosahedronGeometry(0.78, 24)),
    keep(new THREE.ShaderMaterial({ vertexShader: CORE_VERT, fragmentShader: CORE_FRAG, uniforms: { uTime: time }, transparent: true })),
  );
  coreMesh.position.set(...CORE);
  scene.add(coreMesh);
  const haloTex = keep(radialTexture(THREE));
  const coreHalo = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: haloTex, color: 0xffffff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })));
  coreHalo.scale.setScalar(4.2);
  coreHalo.position.copy(coreMesh.position);
  scene.add(coreHalo);

  const v3 = (p: [number, number, number]) => new THREE.Vector3(...p);
  const white = new THREE.Color(0xffffff);
  const R0 = 0.05;

  function makeStream(key: Stream["key"], points: Three.Vector3[], color: Three.Color, from: Three.Color, dashed = false): Stream {
    const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
    const wire = keep(
      new THREE.ShaderMaterial({
        vertexShader: WIRE_VERT,
        fragmentShader: WIRE_FRAG,
        uniforms: { uTime: time, uColor: { value: color }, uFrom: { value: from }, uR: { value: R0 }, uR0: { value: R0 }, uIntensity: { value: 0 }, uDash: { value: dashed ? 1 : 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    scene.add(new THREE.Mesh(keep(new THREE.TubeGeometry(curve, 160, R0, 14, false)), wire));
    const dotGeo = keep(new THREE.BufferGeometry());
    const n = key === "hop" ? 60 : PARTICLES;
    const offsets = new Float32Array(n);
    const speeds = new Float32Array(n);
    const rank = new Float32Array(n);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      offsets[i] = Math.random();
      speeds[i] = 0.07 + Math.random() * 0.07;
      rank[i] = Math.random();
      seed[i] = Math.random();
    }
    dotGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    dotGeo.setAttribute("aT", new THREE.BufferAttribute(new Float32Array(n), 1));
    dotGeo.setAttribute("aRank", new THREE.BufferAttribute(rank, 1));
    dotGeo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    const dots = keep(
      new THREE.ShaderMaterial({
        vertexShader: DOT_VERT,
        fragmentShader: DOT_FRAG,
        uniforms: { uColor: { value: color }, uFrom: { value: from }, uDensity: { value: 0 }, uSize: { value: 5 }, uPixelRatio: { value: dpr }, uIntensity: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const pts = new THREE.Points(dotGeo, dots);
    pts.frustumCulled = false;
    scene.add(pts);
    const zero = { r: 0.012, density: 0, intensity: 0, size: 0.2 };
    return { key, curve, wire, dots, dotGeo, offsets, speeds, target: { ...zero }, now: { ...zero } };
  }

  const core = v3(CORE);
  const streams: Stream[] = [];
  const inStream = makeStream(
    "in",
    [v3(SOURCE), new THREE.Vector3(-5.6, -0.15, 0.9), new THREE.Vector3(-3.9, 0.1, 0.3), core.clone().add(new THREE.Vector3(-0.6, 0, 0))],
    white,
    new THREE.Color(0x9fb4c8),
  );
  streams.push(inStream);
  const byKey = new Map<string, Stream>();
  for (const f of first.flows) {
    const end = v3(NODES[f.key]);
    const color = new THREE.Color(f.color);
    const mid = core.clone().lerp(end, 0.5);
    mid.z += (end.y > 0 ? -1 : 1) * 1.1;
    mid.y += end.y * 0.15;
    const s = makeStream(f.key, [core.clone().add(new THREE.Vector3(0.6, 0, 0)), core.clone().lerp(mid, 0.6), mid, end], color, white);
    const mat = keep(new THREE.ShaderMaterial({ vertexShader: NODE_VERT, fragmentShader: NODE_FRAG, uniforms: { uTime: time, uColor: { value: color }, uIntensity: { value: 0.3 } }, transparent: true }));
    const mesh = new THREE.Mesh(keep(new THREE.IcosahedronGeometry(1, 12)), mat);
    mesh.position.copy(end);
    scene.add(mesh);
    const haloMat = keep(new THREE.SpriteMaterial({ map: haloTex, color, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
    const halo = new THREE.Sprite(haloMat);
    halo.position.copy(end);
    scene.add(halo);
    s.node = { mesh, mat, halo, haloMat };
    streams.push(s);
    byKey.set(f.key, s);
  }
  // higher.fun's Fee Key passing the creator their third, off-chain: a dashed wire between the two nodes.
  const hi = v3(NODES["higher.fun"]);
  const cr = v3(NODES.creator);
  // Behind the nodes, so it never crosses their labels.
  const hopMid = hi.clone().lerp(cr, 0.5).add(new THREE.Vector3(-0.45, 0, -1.5));
  const colorOf = (key: FlowKey) => new THREE.Color(first.flows.find((f) => f.key === key)?.color ?? "#ffffff");
  const hop = makeStream("hop", [hi, hopMid, cr], colorOf("creator"), colorOf("higher.fun"), true);
  streams.push(hop);

  let frames = 0;
  function show(s: FlowScenario) {
    // Shares of this phase's fee; wire and node sizes follow the square root, so small shares stay visible.
    const total = s.flows.reduce((n, f) => n + f.ratePct, 0) || 1;
    for (const f of s.flows) {
      const st = byKey.get(f.key);
      if (!st) continue;
      const share = f.ratePct / total;
      st.target = f.ratePct > 0
        ? { r: 0.022 + 0.13 * Math.sqrt(share), density: 0.12 + 0.88 * Math.sqrt(share), intensity: 1, size: 0.2 + 0.36 * Math.sqrt(share) }
        : { r: 0.012, density: 0, intensity: 0.16, size: 0.16 };
    }
    inStream.target = { r: 0.05 + 0.11 * Math.sqrt(s.totalPct), density: 0.35 + 0.65 * Math.sqrt(Math.min(1, s.totalPct)), intensity: 1, size: 0 };
    hop.target = s.hopPct ? { r: 0.016, density: 0.8, intensity: 0.9, size: 0 } : { r: 0.012, density: 0, intensity: 0, size: 0 };
    frames = 180;
  }
  show(first);
  api.current = { show };

  // Size, pointer parallax, visibility.
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  let fit = 11;
  const resize = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Back far enough that the scene's width fits. A narrow frame looks further right and lets the incoming wire run
    // off the left edge, so the split itself stays large.
    const tall = camera.aspect < 1.6;
    look.x = tall ? 1.5 : 0.9;
    fit = Math.max(11, (tall ? 4.9 : 6.2) / (Math.tan((camera.fov * Math.PI) / 360) * camera.aspect));
    frames = Math.max(frames, 2);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();
  const onMove = (e: PointerEvent) => {
    const r = stage.getBoundingClientRect();
    pointer.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    pointer.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
  };
  stage.addEventListener("pointermove", onMove);
  let visible = true;
  const vis = new IntersectionObserver((es) => (visible = es.some((e) => e.isIntersecting)));
  vis.observe(stage);

  const labelEls = new Map<string, HTMLElement>();
  const refreshLabels = () => {
    labelEls.clear();
    labels.querySelectorAll<HTMLElement>("[data-node]").forEach((el) => labelEls.set(el.dataset.node!, el));
  };
  const mo = new MutationObserver(refreshLabels);
  mo.observe(labels, { childList: true });
  refreshLabels();

  const tmp = new THREE.Vector3();
  const clock = new THREE.Clock();
  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    if (!visible) return;
    if (reduced && frames <= 0) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!reduced) time.value += dt;
    frames--;
    const k = 1 - Math.exp(-dt * 3.5);

    pointer.x += (pointer.tx - pointer.x) * k;
    pointer.y += (pointer.ty - pointer.y) * k;
    const t = reduced ? 0 : time.value;
    const dist = fit;
    camera.position.set(Math.sin(t * 0.08) * 1.4 + pointer.x * 0.8, 0.9 + Math.sin(t * 0.11) * 0.35 - pointer.y * 0.5, dist);
    camera.lookAt(look);

    for (const s of streams) {
      const n = s.now;
      const g = s.target;
      n.r += (g.r - n.r) * k;
      n.density += (g.density - n.density) * k;
      n.intensity += (g.intensity - n.intensity) * k;
      n.size += (g.size - n.size) * k;
      s.wire.uniforms.uR!.value = n.r;
      s.wire.uniforms.uIntensity!.value = n.intensity;
      s.dots.uniforms.uDensity!.value = n.density;
      s.dots.uniforms.uIntensity!.value = n.intensity;
      s.dots.uniforms.uSize!.value = 3.2 + n.r * 38;
      const pos = s.dotGeo.getAttribute("position") as Three.BufferAttribute;
      const along = s.dotGeo.getAttribute("aT") as Three.BufferAttribute;
      for (let i = 0; i < s.offsets.length; i++) {
        if (!reduced) s.offsets[i] = (s.offsets[i]! + s.speeds[i]! * dt) % 1;
        const u = s.offsets[i]!;
        s.curve.getPointAt(u, tmp);
        // Spread across the wire's width, so a thick stream reads as a thick stream.
        const j = (i * 0.618) % 1;
        tmp.x += Math.sin(j * 40 + u * 9) * n.r * 0.9;
        tmp.y += Math.cos(j * 31 + u * 7) * n.r * 0.9;
        tmp.z += Math.sin(j * 23 + u * 11) * n.r * 0.9;
        pos.setXYZ(i, tmp.x, tmp.y, tmp.z);
        along.setX(i, u);
      }
      pos.needsUpdate = true;
      along.needsUpdate = true;
      if (s.node) {
        s.node.mesh.scale.setScalar(n.size);
        s.node.mat.uniforms.uIntensity!.value = 0.25 + 0.95 * n.intensity;
        s.node.halo.scale.setScalar(n.size * 6.5);
        s.node.haloMat.opacity = 0.08 + 0.42 * n.intensity;
      }
    }
    coreMesh.rotation.y = t * 0.15;
    coreMesh.rotation.x = Math.sin(t * 0.2) * 0.2;
    renderer.render(scene, camera);

    // Labels follow their nodes on screen, beside the node's rim, and stay inside the frame.
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const pxPerUnit = (p: Three.Vector3) => h / (2 * Math.tan((camera.fov * Math.PI) / 360) * camera.position.distanceTo(p));
    const place = (id: string, p: Three.Vector3, radius: number, dy: number) => {
      const el = labelEls.get(id);
      if (!el) return;
      tmp.copy(p).project(camera);
      const x = ((tmp.x + 1) / 2) * w + radius * pxPerUnit(p) + 12;
      const y = ((1 - tmp.y) / 2) * h + dy;
      const cx = Math.min(Math.max(x, 12), w - el.offsetWidth - 12);
      const cy = Math.min(Math.max(y, 12), h - el.offsetHeight - 12);
      el.style.transform = `translate(${cx}px, ${cy}px)`;
    };
    for (const s of streams) {
      if (s.node) place(s.key, s.node.mesh.position, s.now.size * 1.1, -20);
    }
    place("in", inStream.curve.getPointAt(0.5, new THREE.Vector3()), -0.2, -58);
  };
  loop();

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    vis.disconnect();
    mo.disconnect();
    stage.removeEventListener("pointermove", onMove);
    for (const d of disposables) d.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    api.current = null;
  };
}

/** A soft white radial gradient, for halos. */
function radialTexture(THREE: typeof Three): Three.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.25, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
