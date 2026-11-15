import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFilm, FilmEncoder, FilmPlayer, SCREEN_H, SCREEN_W } from "../src/film.ts";

// The films' format (docs/link-battles.md 13.3) without the game: screens made up here, encoded, decoded and played
// back, which must give every frame exactly.

const PIXELS = SCREEN_W * SCREEN_H;
const COLOURS = [
  [255, 255, 255],
  [248, 168, 88],
  [200, 64, 32],
  [0, 0, 0],
  [96, 160, 248],
] as const;

/** A screen of palette colours as RGBA. */
function rgba(indices: Uint8Array, colours: readonly (readonly number[])[] = COLOURS): Uint8Array {
  const out = new Uint8Array(PIXELS * 4);
  for (let p = 0; p < PIXELS; p++) {
    const c = colours[indices[p]!]!;
    out.set([c[0]!, c[1]!, c[2]!, 255], p * 4);
  }
  return out;
}

/** What the player shows, as the same RGBA (its words are little-endian RGBA). */
const shown = (screen: Uint32Array) => new Uint8Array(screen.buffer.slice(0));

let seed = 7;
const rand = (n: number) => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) % n;
};

test("a film plays back every frame of both screens exactly", async () => {
  const frames: [Uint8Array, Uint8Array][] = [];
  let a = new Uint8Array(PIXELS);
  let b = new Uint8Array(PIXELS).fill(1);
  for (let f = 0; f < 40; f++) {
    a = a.slice();
    b = b.slice();
    // Some frames change nothing (text waiting), some a few pixels, some the whole screen (a flash).
    if (f % 10 === 9) a.fill(rand(COLOURS.length));
    else if (f % 3) for (let i = 0; i < 50; i++) a[rand(PIXELS)] = rand(COLOURS.length);
    if (f % 4 === 0) for (let i = 0; i < 400; i++) b[rand(PIXELS)] = rand(COLOURS.length);
    frames.push([rgba(a), rgba(b)]);
  }
  const enc = new FilmEncoder(12);
  for (const pair of frames) enc.add(pair);
  const bytes = await enc.finish();
  const film = await decodeFilm(bytes);
  assert.equal(film.turn, 12);
  assert.equal(film.fps, 60);
  assert.equal(film.frames, frames.length);
  assert.equal(film.palette.length, COLOURS.length);
  const player = new FilmPlayer(film);
  for (const [i, pair] of frames.entries()) {
    assert.ok(player.next(), `frame ${i}`);
    assert.deepEqual(shown(player.screens[0]), pair[0], `side 0, frame ${i}`);
    assert.deepEqual(shown(player.screens[1]), pair[1], `side 1, frame ${i}`);
  }
  assert.equal(player.next(), false, "nothing after the last frame");
  player.rewind();
  assert.ok(player.next());
  assert.deepEqual(shown(player.screens[0]), frames[0]![0], "rewound to the first frame");
});

test("a still frame costs almost nothing", async () => {
  const still = rgba(new Uint8Array(PIXELS).map((_, p) => (p % 7) % COLOURS.length));
  const one = new FilmEncoder(1);
  one.add([still, still]);
  const many = new FilmEncoder(1);
  for (let i = 0; i < 600; i++) many.add([still, still]);
  const [a, b] = [await one.finish(), await many.finish()];
  assert.ok(b.length - a.length < 2000, `600 still frames added ${b.length - a.length} bytes`);
});

test("more than 256 colours is refused, and anything that isn't a film too", async () => {
  const enc = new FilmEncoder(1);
  const wild = new Uint8Array(PIXELS * 4);
  for (let p = 0; p < PIXELS; p++) wild.set([p & 0xff, p >> 8, 7, 255], p * 4);
  assert.throws(() => enc.add([wild, wild]), /256 colours/);
  await assert.rejects(decodeFilm(new TextEncoder().encode("not a film at all")), /Not a film/);
  const good = new FilmEncoder(3);
  good.add([rgba(new Uint8Array(PIXELS)), rgba(new Uint8Array(PIXELS))]);
  const bytes = await good.finish();
  // A body cut short fails as it plays, never draws past it.
  const cut = await decodeFilm(bytes);
  const player = new FilmPlayer({ ...cut, frames: 2 });
  assert.ok(player.next());
  assert.throws(() => player.next(), /cut short/);
});

test("the film module stays browser-safe: it imports nothing", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/film.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m, "the practice page's player loads highwire-link/film in the browser");
});

test("a film with no frames reads back, and one that inflates past its frames is refused", async () => {
  const none = await decodeFilm(await new FilmEncoder(0).finish());
  assert.equal(none.frames, 0);
  assert.equal(new FilmPlayer(none).next(), false);
  // A hostile film: one frame's header, and a body of a megabyte of zeros.
  const one = new FilmEncoder(1);
  one.add([rgba(new Uint8Array(PIXELS)), rgba(new Uint8Array(PIXELS))]);
  const real = await one.finish();
  const zeros = new Uint8Array(new Blob([new Uint8Array(1 << 20)]).size);
  const body = new Uint8Array(await new Response(new Blob([zeros]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  const headerLength = 16 + real[15]! * 3;
  const bomb = new Uint8Array(headerLength + body.length);
  bomb.set(real.subarray(0, headerLength));
  bomb.set(body, headerLength);
  await assert.rejects(decodeFilm(bomb), /bigger than its frames/);
});
