import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FRAGMENT } from "../components/arena/shaders.ts";
import { beams } from "../components/fees/Parts.tsx";
import { RECIPIENTS } from "../lib/fees.ts";

// The page headers' pictures (PageStage): every header that has one is also what it follows the pointer over, the
// fee pages' beams say only what the page's figures say, and each scene is a whole shader.

const WEB = fileURLToPath(new URL("..", import.meta.url));
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sources(p) : name.endsWith(".tsx") ? [p] : [];
  });

test("every header with the wire's styles has a picture, and is the host its picture follows", () => {
  const headers = [...sources(join(WEB, "app")), ...sources(join(WEB, "components"))].flatMap((p) => {
    const src = readFileSync(p, "utf8");
    return [...src.matchAll(/<section className="page-hero[^>]*>\s*(<[^>]*>)/g)].map((m) => ({ file: p.slice(WEB.length), open: m[0], next: m[1]! }));
  });
  assert.ok(headers.length >= 7, `found ${headers.length} headers`);
  for (const h of headers) {
    assert.match(h.open, /data-stage-host=""/, `${h.file}: the header isn't its picture's host`);
    assert.match(h.next, /^<PageStage scene="/, `${h.file}: the header has no picture`);
  }
});

test("the fee header's beams are each recipient's share, in the page's order, and even when there are no figures", () => {
  const split = { creator: 30, "higher.fun": 50, holders: 0, Raydium: 15, liquidity: 5 };
  const got = beams(split);
  assert.equal(got.length, RECIPIENTS.length);
  assert.deepEqual(got, RECIPIENTS.map((r) => split[r.key] / 100));
  // A recipient with nothing has no beam, and the rest still add up to the whole.
  assert.equal(got[RECIPIENTS.findIndex((r) => r.key === "holders")], 0);
  assert.ok(Math.abs(got.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  // Nothing to go on: five even beams, never an invented split.
  const even = RECIPIENTS.map(() => 1 / RECIPIENTS.length);
  assert.deepEqual(beams(), even);
  assert.deepEqual(beams({ creator: 0, "higher.fun": 0, holders: 0, Raydium: 0, liquidity: 0 }), even);
  // A bad figure never reaches the shader as a negative width.
  assert.ok(beams({ creator: -4, "higher.fun": 1, holders: 0, Raydium: 0, liquidity: 0 }).every((v) => v >= 0 && v <= 1));
});

test("the fee header's shader colours its beams as the page colours its recipients", () => {
  const split = FRAGMENT.split;
  for (const [i, r] of RECIPIENTS.entries()) {
    const [red, green, blue] = [1, 3, 5].map((at) => (parseInt(r.color.slice(at, at + 2), 16) / 255).toFixed(3));
    const line = i < RECIPIENTS.length - 1 ? `if (i == ${i}) return vec3(${red}, ${green}, ${blue});` : `return vec3(${red}, ${green}, ${blue});`;
    assert.ok(split.includes(line), `beam ${i} isn't ${r.label}'s colour (${r.color})`);
  }
});

test("every scene is a whole WebGL 1 shader that takes the page's colours", () => {
  for (const [name, src] of Object.entries(FRAGMENT)) {
    assert.match(src, /void main\(\) \{/, name);
    assert.match(src, /gl_FragColor = vec4\(/, name);
    assert.match(src, /uniform vec3 uBg;/, name);
    assert.match(src, /uLight/, name);
    // GLSL ES 1.00: none of the later versions' words.
    assert.doesNotMatch(src, /#version|\btexture\(|\bout vec4\b|\bin vec\d\b/, name);
    // An unfilled template would reach the GPU as text.
    assert.doesNotMatch(src, /\$\{/, name);
  }
});
