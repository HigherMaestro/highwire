// The arena's shaders (ArenaStage.tsx draws them on one full-screen triangle each, plain WebGL, no library). One for
// the page's opening, where the two sides meet on a wire, and one scene a game, raymarched from distance fields so
// nothing is modelled or downloaded: The Line's wire and node, Link battles' two handhelds on their cable, and a shape
// still forming for the games to come. All of them are decoration: they show no match, no fighter and no result.
//
// Every shader gets: uRes (pixels), uTime (seconds), uPointer (0..1 across its host, eased), uHover (0..1, eased),
// uLight (0 on ink, 1 on paper), uBg (the colour behind it, read from the page) and uPulse (where and when it was last
// pressed). GLSL ES 1.00, so it runs on WebGL 1.

export type SceneName = "clash" | "line" | "link" | "next";

export const VERTEX = /* glsl */ `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const COMMON = /* glsl */ `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uPointer;
uniform float uHover;
uniform float uLight;
uniform vec3 uBg;
uniform vec3 uPulse;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * noise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return s;
}
// The brand's wire: gold, pink, blue, mint.
vec3 wireGradient(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 a = vec3(0.969, 0.784, 0.298);
  vec3 b = vec3(0.965, 0.663, 0.769);
  vec3 c = vec3(0.576, 0.886, 0.984);
  vec3 d = vec3(0.651, 0.937, 0.796);
  if (t < 0.35) return mix(a, b, t / 0.35);
  if (t < 0.7) return mix(b, c, (t - 0.35) / 0.35);
  return mix(c, d, (t - 0.7) / 0.3);
}
// A colour as ink on paper: deeper, so it reads on the light theme.
vec3 deepen(vec3 c) { return pow(c, vec3(1.9)) * 0.86; }
// Light added to a colour: it glows on ink, and stains on paper.
vec3 glow(vec3 base, vec3 c, float amount) {
  return mix(base + c * amount, mix(base, deepen(c), clamp(amount * 0.8, 0.0, 0.9)), uLight);
}
`;

const CLASH = /* glsl */ `
${COMMON}
float gAspect;
// Where the front rests: the middle of a tall stage, right of the words on a wide one.
float gHome;
// Where the two sides meet, at height y: it leans toward the pointer, most where the pointer is, and never sits still.
float frontAt(float y) {
  float lean = ((uPointer.x - 0.5) * gAspect - gHome) * 0.6 * uHover;
  float near = exp(-pow((y - (uPointer.y - 0.5)) * 2.4, 2.0));
  return gHome + lean * (0.3 + 0.7 * near) + 0.07 * sin(y * 3.3 + uTime * 0.6) + 0.12 * (fbm(vec2(y * 1.9 + 3.0, uTime * 0.2)) - 0.5);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  gAspect = uRes.x / uRes.y;
  gHome = 0.17 * gAspect * smoothstep(1.0, 1.7, gAspect);
  vec2 p = (uv - 0.5) * vec2(gAspect, 1.0);
  float t = uTime;
  float front = frontAt(p.y);
  float d = p.x - front;
  float side = smoothstep(-0.012, 0.012, d);

  // Each side streams toward the other, warped so it rolls like smoke.
  vec2 fa = vec2(p.x * 1.25 - t * 0.15, p.y * 1.5 + 2.0);
  vec2 fb = vec2(p.x * 1.25 + t * 0.15, p.y * 1.5 + 9.0);
  vec2 f = mix(fa, fb, side);
  vec2 warp = vec2(fbm(f * 1.4 + vec2(0.0, t * 0.05)), fbm(f * 1.4 + vec2(5.2, -t * 0.04)));
  float w = fbm(f + 1.8 * warp);
  float pile = exp(-abs(d) * 4.2);
  float body = smoothstep(0.3, 0.85, w + pile * 0.32);
  float ridge = pow(1.0 - abs(2.0 * fbm(f * 2.4 + warp * 2.0) - 1.0), 7.0);

  float half_ = gAspect * 0.5;
  vec3 ca = mix(vec3(0.969, 0.784, 0.298), vec3(0.965, 0.663, 0.769), smoothstep(-half_, gHome, p.x));
  vec3 cb = mix(vec3(0.576, 0.886, 0.984), vec3(0.651, 0.937, 0.796), smoothstep(gHome, half_, p.x));
  vec3 col = mix(ca, cb, side);

  float seam = exp(-abs(d) * 130.0) + 0.3 * exp(-abs(d) * 24.0);
  float spark = pow(noise(vec2(p.y * 34.0, t * 5.0)), 6.0) * exp(-abs(d) * 20.0) * 1.7;

  // A press sends a ring out from where it landed.
  float age = t - uPulse.z;
  vec2 at = (uPulse.xy - 0.5) * vec2(gAspect, 1.0);
  float ring = exp(-pow((length(p - at) - age * 0.95) * 9.0, 2.0)) * exp(-age * 1.5) * step(0.0, age);

  // The wire across the stage, and the node where the front crosses it.
  float y0 = 0.36;
  float f0 = frontAt(y0);
  float sag = 0.03 * exp(-abs(p.x - f0) * 2.6);
  float wd = abs(p.y - (y0 - sag));
  float wireCore = exp(-wd * uRes.y * 0.75);
  float wireHalo = exp(-wd * 55.0) * 0.22;
  vec3 wcol = wireGradient(uv.x);
  float nd = length(p - vec2(f0, y0 - 0.03));
  float core = smoothstep(0.017, 0.011, nd);
  float halo = exp(-nd * 13.0) * 0.75 + exp(-nd * 4.0) * 0.18;

  // Quieter toward the edges and the bottom, where the words are.
  float calm = smoothstep(0.22, 0.78, uv.y) * 0.78 + 0.22;
  float energy = (body * (0.24 + 0.6 * ridge) + pile * 0.1 + ring * 0.5) * calm;

  vec3 ink = uBg + col * energy * 0.95;
  ink += mix(col, vec3(1.0), 0.6) * (seam * 0.9 + spark) * calm * calm;
  ink += wcol * (wireCore * 0.95 + wireHalo) + mix(wcol, vec3(1.0), 0.5) * halo + vec3(core);

  vec3 paper = mix(uBg, deepen(col), clamp(energy * 0.85, 0.0, 0.8));
  paper = mix(paper, vec3(0.055, 0.067, 0.086), clamp((seam * 0.75 + spark * 0.6) * calm * calm, 0.0, 0.9));
  paper = mix(paper, deepen(wcol), clamp(wireCore + wireHalo, 0.0, 1.0));
  paper = mix(paper, deepen(wcol), clamp(halo * 0.7, 0.0, 0.8));
  paper = mix(paper, vec3(0.055, 0.067, 0.086), core);

  vec3 outc = mix(ink, paper, uLight);
  outc += (hash21(gl_FragCoord.xy + fract(t) * 91.0) - 0.5) * 0.02;
  gl_FragColor = vec4(outc, 1.0);
}
`;

const MARCH = /* glsl */ `
${COMMON}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float sdRoundBox(vec3 p, vec3 b, float r) { vec3 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r; }
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) { vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h) - r; }
// A ring around the x axis.
float sdRing(vec3 p, float big, float small) { return length(vec2(length(p.yz) - big, p.x)) - small; }
vec2 nearer(vec2 a, vec2 b) { return a.x < b.x ? a : b; }
`;

const LINE = /* glsl */ `
${MARCH}
const float STEP_X = 0.56;
float gNode;
// The place the node rests at over time: a tug that goes back and forth, never the same way twice in a row.
float placeAt(float n) { return floor(2.9 * sin(n * 1.31) * cos(n * 0.37 + 1.0) + 0.5); }
float nodeX() {
  float s = uTime * 0.55;
  float e = smoothstep(0.0, 1.0, smoothstep(0.15, 0.85, fract(s)));
  float walk = mix(placeAt(floor(s)), placeAt(floor(s) + 1.0), e) * STEP_X;
  return mix(walk, clamp((uPointer.x - 0.5) * 4.4, -3.0 * STEP_X, 3.0 * STEP_X), uHover);
}
// 1 the wire, 2 a place's ring, 3 the node, 4 a post, 5 the floor.
vec2 map(vec3 p) {
  vec2 m = vec2(sdCapsule(p, vec3(-2.0, 0.0, 0.0), vec3(2.0, 0.0, 0.0), 0.012), 1.0);
  float xi = clamp(floor(p.x / STEP_X + 0.5), -3.0, 3.0);
  m = nearer(m, vec2(sdRing(p - vec3(xi * STEP_X, 0.0, 0.0), 0.062, 0.011), 2.0));
  m = nearer(m, vec2(length(p - vec3(gNode, 0.0, 0.0)) - 0.095, 3.0));
  vec3 q = vec3(abs(p.x) - 2.0, p.y, p.z);
  m = nearer(m, vec2(sdCapsule(q, vec3(0.0, -0.7, 0.0), vec3(0.0, 0.05, 0.0), 0.04), 4.0));
  m = nearer(m, vec2(p.y + 0.7, 5.0));
  return m;
}
vec3 normalAt(vec3 p) {
  vec2 e = vec2(0.0015, -0.0015);
  return normalize(e.xyy * map(p + e.xyy).x + e.yyx * map(p + e.yyx).x + e.yxy * map(p + e.yxy).x + e.xxx * map(p + e.xxx).x);
}
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  gNode = nodeX();
  float yaw = 0.28 * sin(uTime * 0.17) + (uPointer.x - 0.5) * 0.5 * uHover;
  float pitch = 0.2 + (0.5 - uPointer.y) * 0.16 * uHover;
  vec3 ro = vec3(0.0, 0.25, 5.0);
  ro.yz *= rot(-pitch);
  ro.xz *= rot(yaw);
  vec3 fw = normalize(vec3(0.0, -0.12, 0.0) - ro);
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  // Wider canvases see no more of the wire: they'd only push it to the middle.
  float zoom = 1.9 * min(1.0, uRes.x / uRes.y / 1.6);
  vec3 rd = normalize(fw * zoom + rt * uv.x + up * uv.y);

  float t = 0.0, id = 0.0, closest = 9.0;
  for (int i = 0; i < 72; i++) {
    vec3 p = ro + rd * t;
    vec2 m = map(p);
    closest = min(closest, length(p - vec3(gNode, 0.0, 0.0)));
    if (m.x < 0.0015) { id = m.y; break; }
    t += m.x;
    if (t > 12.0) break;
  }
  vec3 node = vec3(gNode, 0.0, 0.0);
  float along = (gNode + 2.0) / 4.0;
  vec3 nodeCol = wireGradient(along);
  vec3 col = uBg;
  if (id > 0.5) {
    vec3 p = ro + rd * t;
    vec3 n = normalAt(p);
    vec3 key = normalize(vec3(0.4, 0.9, 0.5));
    float dif = max(dot(n, key), 0.0);
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    float lamp = 1.0 / (1.0 + 9.0 * dot(p - node, p - node));
    vec3 here = wireGradient((p.x + 2.0) / 4.0);
    vec3 metal = mix(vec3(0.16, 0.18, 0.22), vec3(0.78, 0.76, 0.72), uLight);
    if (id < 1.5) {
      col = glow(mix(uBg, here, 0.35), here, 0.9);
    } else if (id < 2.5) {
      float mine = step(abs(abs(p.x) - 3.0 * STEP_X), 0.2);
      col = metal * (0.35 + 0.65 * dif) + rim * 0.25;
      col = glow(col, here, mine * 0.8 + lamp * 0.6);
    } else if (id < 3.5) {
      col = glow(mix(vec3(1.0), nodeCol, 0.25) * (0.75 + 0.25 * dif), nodeCol, rim * 0.6);
      col = mix(col, mix(deepen(nodeCol), vec3(0.055, 0.067, 0.086), 0.55 - 0.4 * dif), uLight);
    } else if (id < 4.5) {
      col = metal * (0.3 + 0.7 * dif) + rim * 0.2;
      col = glow(col, here, 0.25 + lamp * 0.3);
    } else {
      // The floor: it catches the wire's colours under it, brightest under the node.
      float under = exp(-abs(p.z) * 2.6);
      float pool = exp(-length(p.xz - node.xz) * 2.2);
      vec3 base = mix(uBg * 1.25 + 0.012, uBg * 0.97, uLight);
      col = glow(base, here, under * 0.16);
      col = glow(col, nodeCol, pool * 0.5);
      float grid = smoothstep(0.03, 0.0, abs(fract(p.x / STEP_X + 0.5) - 0.5) * STEP_X) * exp(-abs(p.z) * 1.4);
      col = glow(col, here, grid * 0.12);
    }
    float fog = 1.0 - exp(-0.012 * t * t);
    col = mix(col, uBg, fog);
  }
  // The node's light in the air around it.
  col = glow(col, nodeCol, 0.028 / (closest * closest + 0.02));
  col += (hash21(gl_FragCoord.xy) - 0.5) * 0.015;
  gl_FragColor = vec4(col, 1.0);
}
`;

const LINK = /* glsl */ `
${MARCH}
float gCable;
vec3 gLocal;
float gUnit;
vec3 unitPos(float s) { return vec3(s * 0.78, 0.04 * sin(uTime * 1.2 + s * 1.3) - 0.02, 0.0); }
// A point in one handheld's own frame: turned in toward the other, leaning back.
vec3 toUnit(vec3 p, float s) {
  p -= unitPos(s);
  p.xz *= rot(s * 0.42);
  p.yz *= rot(-0.22);
  return p;
}
float unit(vec3 q) {
  float body = sdRoundBox(q, vec3(0.3, 0.46, 0.04), 0.045);
  body = max(body, -sdRoundBox(q - vec3(0.0, 0.2, 0.095), vec3(0.215, 0.165, 0.02), 0.008));
  float pad = min(sdRoundBox(q - vec3(-0.14, -0.2, 0.09), vec3(0.075, 0.024, 0.012), 0.006), sdRoundBox(q - vec3(-0.14, -0.2, 0.09), vec3(0.024, 0.075, 0.012), 0.006));
  float keys = min(length((q - vec3(0.1, -0.23, 0.085)) * vec3(1.0, 1.0, 1.8)) - 0.04, length((q - vec3(0.2, -0.16, 0.085)) * vec3(1.0, 1.0, 1.8)) - 0.04);
  return min(body, min(pad, keys));
}
vec3 cablePoint(float u) {
  vec3 a = unitPos(-1.0) + vec3(0.06, 0.5, -0.06);
  vec3 b = unitPos(1.0) + vec3(-0.06, 0.5, -0.06);
  vec3 c = vec3(0.0, 1.02 + 0.03 * sin(uTime * 0.8), -0.5);
  return mix(mix(a, c, u), mix(c, b, u), u);
}
// 1 a handheld (gUnit says which, gLocal where on it), 2 the cable (gCable how far along), 3 the floor.
vec2 map(vec3 p) {
  vec3 ql = toUnit(p, -1.0), qr = toUnit(p, 1.0);
  float dl = unit(ql), dr = unit(qr);
  vec2 m = vec2(min(dl, dr), 1.0);
  gUnit = dl < dr ? -1.0 : 1.0;
  gLocal = dl < dr ? ql : qr;
  float dc = 9.0;
  vec3 a = cablePoint(0.0);
  for (int i = 1; i <= 8; i++) {
    float u = float(i) / 8.0;
    vec3 b = cablePoint(u);
    vec3 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    float di = length(pa - ba * h) - 0.017;
    if (di < dc) { dc = di; gCable = (float(i) - 1.0 + h) / 8.0; }
    a = b;
  }
  m = nearer(m, vec2(dc, 2.0));
  m = nearer(m, vec2(p.y + 0.62, 3.0));
  return m;
}
vec3 normalAt(vec3 p) {
  vec2 e = vec2(0.0015, -0.0015);
  return normalize(e.xyy * map(p + e.xyy).x + e.yyx * map(p + e.yyx).x + e.yxy * map(p + e.yxy).x + e.xxx * map(p + e.xxx).x);
}
// What a screen shows: blocks of light, a bar that runs down, and the scan of an old display. Nothing from a game.
float screen(vec2 s, float which) {
  vec2 cell = floor(s * vec2(18.0, 14.0));
  float tick = floor(uTime * 3.0 + which * 1.7);
  float blocks = step(0.62, hash21(cell + tick * 0.37 + which * 11.0)) * step(cell.y, 8.0) * step(2.0, cell.y);
  float bar = step(cell.y, 11.5) * step(10.5, cell.y) * step(cell.x, 2.0 + 13.0 * (0.5 + 0.5 * sin(uTime * 0.5 + which * 2.0)));
  float frame = step(12.5, cell.y) * step(mod(cell.x, 5.0), 3.0) * 0.6;
  float scan = 0.85 + 0.15 * sin(s.y * 190.0);
  return clamp(blocks * 0.8 + bar + frame, 0.0, 1.0) * scan;
}
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float yaw = 0.2 * sin(uTime * 0.21) + (uPointer.x - 0.5) * 0.7 * uHover;
  float pitch = 0.1 + (0.5 - uPointer.y) * 0.22 * uHover;
  vec3 ro = vec3(0.0, 0.2, 4.0);
  ro.yz *= rot(-pitch);
  ro.xz *= rot(yaw);
  vec3 fw = normalize(vec3(0.0, 0.14, 0.0) - ro);
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  float zoom = 2.0 * min(1.0, uRes.x / uRes.y / 1.45);
  vec3 rd = normalize(fw * zoom + rt * uv.x + up * uv.y);

  float t = 0.0, id = 0.0;
  for (int i = 0; i < 72; i++) {
    vec2 m = map(ro + rd * t);
    if (m.x < 0.0015) { id = m.y; break; }
    t += m.x * 0.9;
    if (t > 11.0) break;
  }
  vec3 sideA = vec3(0.965, 0.663, 0.769), sideB = vec3(0.576, 0.886, 0.984);
  vec3 lcd = vec3(0.651, 0.937, 0.796);
  vec3 col = uBg;
  if (id > 0.5) {
    vec3 p = ro + rd * t;
    map(p);
    float which = gUnit;
    vec3 q = gLocal;
    float along = gCable;
    vec3 n = normalAt(p);
    vec3 key = normalize(vec3(0.3, 0.8, 0.6));
    float dif = max(dot(n, key), 0.0);
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    float spec = pow(max(dot(reflect(rd, n), key), 0.0), 24.0);
    if (id < 1.5) {
      vec3 mine = which < 0.0 ? sideA : sideB;
      vec3 shell = mix(mix(vec3(0.1, 0.11, 0.14), mine, 0.2), mix(vec3(0.9, 0.89, 0.86), mine, 0.35), uLight);
      col = shell * (0.3 + 0.7 * dif) + spec * 0.35 + rim * mix(mine * 0.5, vec3(0.2), uLight);
      vec2 s = (q.xy - vec2(0.0, 0.2)) / vec2(0.215, 0.165);
      if (abs(s.x) < 1.0 && abs(s.y) < 1.0 && q.z > 0.04) {
        float lit = screen(s * 0.5 + 0.5, which);
        vec3 dark = vec3(0.05, 0.09, 0.08);
        col = mix(dark + lcd * lit * 0.95, mix(vec3(0.72, 0.8, 0.7), vec3(0.1, 0.2, 0.16), lit), uLight) + spec * 0.2;
      } else if (q.z > 0.075 && q.y < -0.05) {
        col = mix(col * 0.55, col * 0.8, uLight) + spec * 0.3;
      }
    } else if (id < 2.5) {
      // Light runs the cable both ways: each side's colour toward the other.
      float there = exp(-pow((fract(along - uTime * 0.45) - 0.5) * 9.0, 2.0));
      float back = exp(-pow((fract(1.0 - along - uTime * 0.45 + 0.5) - 0.5) * 9.0, 2.0));
      col = mix(vec3(0.07, 0.08, 0.1), vec3(0.3, 0.31, 0.33), uLight) * (0.4 + 0.6 * dif) + rim * 0.15;
      col = glow(col, sideA, there * 1.3);
      col = glow(col, sideB, back * 1.3);
    } else {
      float l = exp(-length(p.xz - unitPos(-1.0).xz) * 2.4), r = exp(-length(p.xz - unitPos(1.0).xz) * 2.4);
      vec3 base = mix(uBg * 1.25 + 0.012, uBg * 0.97, uLight);
      col = glow(base, sideA, l * 0.3);
      col = glow(col, sideB, r * 0.3);
      col = mix(col, col * 0.6, (l + r) * 0.5 * uLight);
    }
    float fog = 1.0 - exp(-0.014 * t * t);
    col = mix(col, uBg, fog);
  }
  col += (hash21(gl_FragCoord.xy) - 0.5) * 0.015;
  gl_FragColor = vec4(col, 1.0);
}
`;

const NEXT = /* glsl */ `
${MARCH}
float map(vec3 p) {
  float wob = sin(p.x * 3.4 + uTime * 0.9) * sin(p.y * 3.1 + uTime * 0.7) * sin(p.z * 3.7 - uTime * 0.6);
  float press = exp(-max(0.0, uTime - uPulse.z) * 2.0) * 0.12;
  return length(p) - 0.62 - (0.13 + 0.1 * uHover + press) * wob;
}
vec3 normalAt(vec3 p) {
  vec2 e = vec2(0.002, -0.002);
  return normalize(e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) + e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
}
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec3 ro = vec3(0.0, 0.0, 2.6);
  ro.xz *= rot(uTime * 0.2 + (uPointer.x - 0.5) * 1.2 * uHover);
  ro.yz *= rot((uPointer.y - 0.5) * 0.6 * uHover);
  vec3 fw = normalize(-ro);
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  vec3 rd = normalize(fw * 1.7 + rt * uv.x + up * uv.y);
  float t = 0.0, hit = 0.0, closest = 9.0;
  for (int i = 0; i < 56; i++) {
    float d = map(ro + rd * t);
    closest = min(closest, d);
    if (d < 0.002) { hit = 1.0; break; }
    t += d * 0.7;
    if (t > 6.0) break;
  }
  vec3 col = uBg;
  if (hit > 0.5) {
    vec3 p = ro + rd * t;
    vec3 n = normalAt(p);
    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 2.2);
    // Contour lines over the shape, in the wire's colours: a thing being drawn, not finished.
    float bands = smoothstep(0.42, 0.5, abs(fract(p.y * 7.0 + uTime * 0.15) - 0.5));
    vec3 hue = wireGradient(fract(0.5 + 0.5 * n.x + 0.25 * n.y));
    vec3 base = mix(uBg * 1.6 + 0.02, uBg * 0.94, uLight);
    col = glow(base, hue, bands * 0.75 + fres * 0.7);
  }
  col = glow(col, wireGradient(0.5 + 0.4 * uv.x), 0.012 / (closest * closest + 0.02) * (1.0 - hit));
  col += (hash21(gl_FragCoord.xy) - 0.5) * 0.015;
  gl_FragColor = vec4(col, 1.0);
}
`;

export const FRAGMENT: Record<SceneName, string> = { clash: CLASH, line: LINE, link: LINK, next: NEXT };
