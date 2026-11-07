"use client";

import { useEffect, useRef, useState } from "react";
import type * as Three from "three";

// "How it works", as a dive through scales: scrolling flies the camera from higher.fun's whole field of coins, into one
// coin and its holders, into one trade on a wire, and out to the Highwire H. One pinned three.js scene; the captions
// are plain text beside it, and reduced motion cuts between the four frames instead of flying.

export interface DiveStage {
  title: string;
  body: string;
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

const POINT_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aHue;
  uniform float uPixel;
  uniform float uTime;
  varying float vHue;
  varying float vDepth;
  void main() {
    vHue = aHue;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    gl_PointSize = aSize * uPixel / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const POINT_FRAG = /* glsl */ `
  ${GRADIENT_GLSL}
  uniform float uOpacity;
  varying float vHue;
  varying float vDepth;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float core = smoothstep(0.45, 0.0, d);
    float halo = pow(1.0 - d, 2.0) * 0.4;
    vec3 c = mix(wireGradient(vHue), vec3(1.0), core * 0.6);
    gl_FragColor = vec4(c, (core + halo) * uOpacity);
  }
`;

const WIRE_VERT = /* glsl */ `
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFacing = abs(dot(normalize(normalMatrix * normal), normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
  }
`;

const WIRE_FRAG = /* glsl */ `
  ${GRADIENT_GLSL}
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uPulse;
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    vec3 col = wireGradient(vUv.x);
    float lit = uPulse >= 0.0 ? exp(-abs(vUv.x - uPulse) * 30.0) : 0.0;
    if (uGlow > 0.5) {
      gl_FragColor = vec4(col, pow(vFacing, 2.4) * (0.12 + 0.5 * lit) * uOpacity);
    } else {
      gl_FragColor = vec4(col * (0.85 + 0.25 * vFacing) + col * lit * 0.8, uOpacity);
    }
  }
`;

// Each stage's camera: where it sits and what it looks at.
// From the second stage on, the camera aims left of its subject, so the subject sits in the frame's right half, clear
// of the caption.
const SHOTS: { pos: [number, number, number]; look: [number, number, number] }[] = [
  { pos: [0, 42, 120], look: [0, 0, 0] },
  { pos: [7.2, 3.2, 10.5], look: [3.2, 1.2, 2] },
  { pos: [5.2, 1.5, 4.6], look: [4.3, 1.1, 2] },
  { pos: [5.4, 1.5, 12.6], look: [4.4, 1.0, 2] },
];

function startScene(THREE: typeof Three, stage: HTMLDivElement, reduced: boolean) {
  let renderer: Three.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    return null;
  }
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.className = "dive-canvas";
  stage.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 600);
  const pixel = { value: 300 };
  const time = { value: 0 };
  const target = new THREE.Vector3(6, 1.2, 2);

  const points = (positions: Float32Array, sizes: Float32Array, hues: Float32Array) => {
    const geo = keep(new THREE.BufferGeometry());
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute("aHue", new THREE.BufferAttribute(hues, 1));
    const opacity = { value: 1 };
    const mat = keep(new THREE.ShaderMaterial({ vertexShader: POINT_VERT, fragmentShader: POINT_FRAG, uniforms: { uPixel: pixel, uTime: time, uOpacity: opacity }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    const p = new THREE.Points(geo, mat);
    scene.add(p);
    return { p, opacity };
  };

  // 1. The field: every coin a point, in a slow spiral; the one we dive into sits at `target`.
  const FIELD = 1400;
  const fPos = new Float32Array(FIELD * 3);
  const fSize = new Float32Array(FIELD);
  const fHue = new Float32Array(FIELD);
  for (let i = 0; i < FIELD; i++) {
    const r = 6 + Math.pow(Math.random(), 0.6) * 70;
    const a = Math.random() * Math.PI * 2 + r * 0.05;
    fPos.set([Math.cos(a) * r, (Math.random() - 0.5) * 6 * (1 - r / 90), Math.sin(a) * r], i * 3);
    fSize[i] = 0.35 + Math.random() * 0.9;
    fHue[i] = Math.random();
  }
  fPos.set([target.x, target.y, target.z], 0);
  fSize[0] = 1.6;
  fHue[0] = 0.35;
  const field = points(fPos, fSize, fHue);

  // 2. One coin: a bright core, and its holders orbiting it.
  const HOLDERS = 320;
  const hPos = new Float32Array(HOLDERS * 3);
  const hSize = new Float32Array(HOLDERS);
  const hHue = new Float32Array(HOLDERS);
  const hOrbit = new Float32Array(HOLDERS * 3);
  for (let i = 0; i < HOLDERS; i++) {
    hOrbit.set([0.5 + Math.pow(Math.random(), 1.6) * 2.6, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.9], i * 3);
    hSize[i] = 0.025 + Math.pow(Math.random(), 4) * 0.12;
    hHue[i] = 0.3 + Math.random() * 0.45;
  }
  const holders = points(hPos, hSize, hHue);
  const core = points(new Float32Array([target.x, target.y, target.z]), new Float32Array([0.9]), new Float32Array([0.35]));

  // 3 and 4. The wire: a trade riding it, then the H's two posts and its node.
  const wireCurve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(4.2, 1.8, 2), new THREE.Vector3(6, -0.2, 2), new THREE.Vector3(7.8, 1.8, 2));
  const wireOpacity = { value: 0 };
  const pulse = { value: -1 };
  const wireMat = (glow: boolean) =>
    keep(new THREE.ShaderMaterial({ vertexShader: WIRE_VERT, fragmentShader: WIRE_FRAG, uniforms: { uOpacity: wireOpacity, uGlow: { value: glow ? 1 : 0 }, uPulse: pulse }, transparent: true, depthWrite: false, blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending }));
  scene.add(new THREE.Mesh(keep(new THREE.TubeGeometry(wireCurve, 200, 0.045, 12, false)), wireMat(false)));
  scene.add(new THREE.Mesh(keep(new THREE.TubeGeometry(wireCurve, 200, 0.26, 12, false)), wireMat(true)));
  const postMat = keep(new THREE.MeshBasicMaterial({ color: 0xf6f4ee, transparent: true, opacity: 0 }));
  for (const x of [4.2, 7.8]) {
    const post = new THREE.Mesh(keep(new THREE.CapsuleGeometry(0.11, 3.4, 6, 16)), postMat);
    post.position.set(x, 1.3, 2);
    scene.add(post);
  }
  const nodeMat = keep(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }));
  const node = new THREE.Mesh(keep(new THREE.SphereGeometry(0.17, 24, 16)), nodeMat);
  scene.add(node);
  const nodeRing = new THREE.Mesh(keep(new THREE.TorusGeometry(0.19, 0.045, 12, 40)), keep(new THREE.MeshBasicMaterial({ color: 0x0e1116, transparent: true, opacity: 0 })));
  scene.add(nodeRing);

  const resize = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    pixel.value = (h * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360));
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();

  const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
  const band = (p: number, a: number, b: number) => clamp01((p - a) / (b - a));
  const pos = new THREE.Vector3();
  const look = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  // progress: 0..3, the stage index plus how far toward the next.
  function frame(progress: number) {
    const i = Math.min(2, Math.floor(progress));
    const f = reduced ? Math.round(progress - i) : ease(progress - i);
    const a = SHOTS[i]!;
    const b = SHOTS[i + 1]!;
    pos.set(...a.pos).lerp(tmp.set(...b.pos), f);
    look.set(...a.look).lerp(tmp.set(...b.look), f);
    camera.position.copy(pos);
    camera.position.x += Math.sin(time.value * 0.1) * 0.15 * (1 - band(progress, 2, 3));
    camera.lookAt(look);

    field.opacity.value = 1 - band(progress, 0.55, 1.25) * 0.85;
    const coin = band(progress, 0.5, 1) * (1 - band(progress, 1.6, 2.1));
    holders.opacity.value = coin;
    core.opacity.value = coin;
    wireOpacity.value = band(progress, 1.6, 2.1);
    const h = band(progress, 2.4, 2.9);
    postMat.opacity = h;
    nodeMat.opacity = h;
    (nodeRing.material as Three.MeshBasicMaterial).opacity = h;
    // A trade rides the wire in stage three; in stage four the node settles where the brand mark has it.
    const ride = (time.value * 0.25) % 1;
    const t = reduced ? 0.5 : h > 0 ? 0.5 + (ride - 0.5) * (1 - h) : ride;
    pulse.value = wireOpacity.value > 0 ? t : -1;
    wireCurve.getPoint(t, node.position);
    nodeRing.position.copy(node.position);
    nodeRing.lookAt(camera.position);
    if (h === 0) {
      nodeMat.opacity = wireOpacity.value;
      node.scale.setScalar(0.6);
    } else node.scale.setScalar(0.6 + 0.4 * h);

    for (let k = 0; k < HOLDERS; k++) {
      const r = hOrbit[k * 3]!;
      const ang = hOrbit[k * 3 + 1]! + time.value * (0.25 / r);
      hPos[k * 3] = target.x + Math.cos(ang) * r;
      hPos[k * 3 + 1] = target.y + hOrbit[k * 3 + 2]! * r * 0.3;
      hPos[k * 3 + 2] = target.z + Math.sin(ang) * r;
    }
    (holders.p.geometry.getAttribute("position") as Three.BufferAttribute).needsUpdate = true;
    renderer.render(scene, camera);
  }

  let visible = false;
  const vis = new IntersectionObserver((es) => (visible = es.some((e) => e.isIntersecting)));
  vis.observe(stage);
  let progress = 0;
  const clock = new THREE.Clock();
  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    if (!visible) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!reduced) time.value += dt;
    frame(progress);
  };
  loop();

  return {
    setProgress(p: number) {
      progress = p;
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      vis.disconnect();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

export function WireDive({ stages }: { stages: DiveStage[] }) {
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ReturnType<typeof startScene>>(null);
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState<"idle" | "running" | "flat">("idle");

  useEffect(() => {
    const section = sectionRef.current;
    const stage = stageRef.current;
    if (!section || !stage) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let disposed = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || sceneRef.current || disposed) return;
        io.disconnect();
        import("three")
          .then((THREE) => {
            if (disposed) return;
            sceneRef.current = startScene(THREE, stage, reduced);
            setMode(sceneRef.current ? "running" : "flat");
            onScroll();
          })
          .catch(() => setMode("flat"));
      },
      { rootMargin: "400px" },
    );
    io.observe(section);
    // Progress through the pinned section: 0 at its top, stages.length - 1 at its end.
    const onScroll = () => {
      const r = section.getBoundingClientRect();
      const span = r.height - window.innerHeight;
      const p = span > 0 ? Math.min(1, Math.max(0, -r.top / span)) * (stages.length - 1) : 0;
      sceneRef.current?.setProgress(p);
      setActive(Math.min(stages.length - 1, Math.round(p)));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      disposed = true;
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, [stages.length]);

  return (
    <section className="dive" ref={sectionRef} aria-labelledby="dive-title" style={{ height: `${stages.length * 100}svh` }} data-mode={mode}>
      <div className="dive-sticky">
        <div className="dive-stage" ref={stageRef} aria-hidden="true" />
        <div className="dive-vignette" aria-hidden="true" />
        <div className="wrap dive-copy">
          <p className="eyebrow">How it works</p>
          <h2 id="dive-title" className="sr-only">
            How Highwire works, from the launchpad down to one trade
          </h2>
          <ol className="dive-stages">
            {stages.map((s, i) => (
              <li key={s.title} data-active={i === active || undefined}>
                <span className="dive-index">
                  {String(i + 1).padStart(2, "0")} / {String(stages.length).padStart(2, "0")}
                </span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
