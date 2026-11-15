// A turn's film (docs/link-battles.md 13.3, phase 4): both Game Boys' screens, every frame of one turn, in a small
// format of our own that a browser decodes with nothing but DecompressionStream. Browser-safe: no Node, no emulator
// (`highwire-link/film`). The referee makes films after its response (record.ts); the page plays them.
//
// Layout: the header below, then the body compressed with raw deflate. The body is, for each frame and each side in
// turn, a bitmap of the screen's 360 tiles (8 × 8 pixels, 20 across, 18 down; a bit set where the tile changed since the
// side's previous frame) followed by each changed tile's 64 pixels as palette indices. A Game Boy's screen changes a few
// tiles at a time and often not at all, so a still frame costs a few bytes.
//
//   "HWF1"  u16 width  u16 height  u8 fps  u32 frames  u16 turn  u8 colours (0 is 256)  colours × [r, g, b]  body…

export const FILM_MAGIC = "HWF1";
export const SCREEN_W = 160;
export const SCREEN_H = 144;
const TILES_X = SCREEN_W / 8;
const TILES_Y = SCREEN_H / 8;
const TILES = TILES_X * TILES_Y;
const BITMAP = TILES / 8;
const PIXELS = SCREEN_W * SCREEN_H;

async function deflate(chunks: Uint8Array[], format: "deflate-raw", way: "compress" | "decompress"): Promise<Uint8Array> {
  const stream = new Blob(chunks as never).stream().pipeThrough(way === "compress" ? new CompressionStream(format) : new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Builds a film a frame at a time, from both screens as RGBA (what `Rig.screen` returns). */
export class FilmEncoder {
  private colours = new Map<number, number>();
  private prev: [Int16Array, Int16Array] = [new Int16Array(PIXELS).fill(-1), new Int16Array(PIXELS).fill(-1)];
  private cur = new Int16Array(PIXELS);
  private chunks: Uint8Array[] = [];
  frames = 0;

  constructor(
    readonly turn: number,
    readonly fps = 60,
  ) {}

  /** Adds one frame: both sides' screens, 160 × 144 RGBA each. Throws past 256 colours (a Game Boy shows far fewer). */
  add(screens: readonly [Uint8Array, Uint8Array]): void {
    for (const side of [0, 1] as const) this.side(side, screens[side]);
    this.frames++;
  }

  private side(side: 0 | 1, rgba: Uint8Array) {
    if (rgba.length !== PIXELS * 4) throw new Error("A screen is 160 × 144 RGBA.");
    const cur = this.cur;
    let last = -1;
    let lastIndex = 0;
    for (let p = 0, q = 0; p < PIXELS; p++, q += 4) {
      const c = (rgba[q]! << 16) | (rgba[q + 1]! << 8) | rgba[q + 2]!;
      if (c !== last) {
        let i = this.colours.get(c);
        if (i === undefined) {
          i = this.colours.size;
          if (i >= 256) throw new Error("A film holds at most 256 colours.");
          this.colours.set(c, i);
        }
        last = c;
        lastIndex = i;
      }
      cur[p] = lastIndex;
    }
    const prev = this.prev[side];
    const bitmap = new Uint8Array(BITMAP);
    const tiles: number[] = [];
    for (let t = 0; t < TILES; t++) {
      const x0 = (t % TILES_X) * 8;
      const y0 = Math.floor(t / TILES_X) * 8;
      changed: for (let y = y0; y < y0 + 8; y++) {
        for (let x = x0, p = y * SCREEN_W + x0; x < x0 + 8; x++, p++) {
          if (cur[p] !== prev[p]) {
            bitmap[t >> 3]! |= 1 << (t & 7);
            tiles.push(t);
            break changed;
          }
        }
      }
    }
    const out = new Uint8Array(BITMAP + tiles.length * 64);
    out.set(bitmap);
    let at = BITMAP;
    for (const t of tiles) {
      const x0 = (t % TILES_X) * 8;
      const y0 = Math.floor(t / TILES_X) * 8;
      for (let y = y0; y < y0 + 8; y++) for (let p = y * SCREEN_W + x0, e = p + 8; p < e; p++) out[at++] = cur[p]!;
    }
    this.chunks.push(out);
    prev.set(cur);
  }

  /** The finished film. */
  async finish(): Promise<Uint8Array> {
    const body = await deflate(this.chunks, "deflate-raw", "compress");
    const n = this.colours.size;
    const header = new Uint8Array(4 + 2 + 2 + 1 + 4 + 2 + 1 + n * 3);
    const view = new DataView(header.buffer);
    header.set(new TextEncoder().encode(FILM_MAGIC));
    view.setUint16(4, SCREEN_W);
    view.setUint16(6, SCREEN_H);
    header[8] = this.fps;
    view.setUint32(9, this.frames);
    view.setUint16(13, this.turn);
    header[15] = n & 0xff;
    let at = 16;
    for (const c of this.colours.keys()) {
      header[at++] = (c >> 16) & 0xff;
      header[at++] = (c >> 8) & 0xff;
      header[at++] = c & 0xff;
    }
    const out = new Uint8Array(header.length + body.length);
    out.set(header);
    out.set(body, header.length);
    return out;
  }
}

/** A decoded film: play it forward with a `FilmPlayer`. */
export interface Film {
  turn: number;
  fps: number;
  frames: number;
  /** Each colour as one little-endian RGBA word, ready for an ImageData's Uint32Array. */
  palette: Uint32Array;
  body: Uint8Array;
}

/** Reads a film's header and inflates its body. Throws on anything that isn't one. */
export async function decodeFilm(bytes: Uint8Array): Promise<Film> {
  if (bytes.length < 16 || new TextDecoder().decode(bytes.subarray(0, 4)) !== FILM_MAGIC) throw new Error("Not a film.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4) !== SCREEN_W || view.getUint16(6) !== SCREEN_H) throw new Error("A film is 160 × 144.");
  const fps = bytes[8]!;
  const frames = view.getUint32(9);
  const turn = view.getUint16(13);
  const n = bytes[15]! || 256;
  if (bytes.length < 16 + n * 3) throw new Error("A film's palette is cut short.");
  const palette = new Uint32Array(n);
  for (let i = 0, at = 16; i < n; i++, at += 3) palette[i] = (0xff << 24) | (bytes[at + 2]! << 16) | (bytes[at + 1]! << 8) | bytes[at]!;
  const body = await deflate([bytes.subarray(16 + n * 3)], "deflate-raw", "decompress");
  return { turn, fps, frames, palette, body };
}

/**
 * Plays a film forward a frame at a time into two RGBA screens (Uint32 words, as an ImageData's buffer reads). Films are
 * short (a turn), so stepping back means starting again.
 */
export class FilmPlayer {
  /** The frame the screens show, -1 before the first. */
  frame = -1;
  private at = 0;
  readonly screens: [Uint32Array, Uint32Array] = [new Uint32Array(PIXELS), new Uint32Array(PIXELS)];

  constructor(readonly film: Film) {}

  /** Advances one frame; false at the end. Throws if the body is malformed. */
  next(): boolean {
    if (this.frame + 1 >= this.film.frames) return false;
    const { body, palette } = this.film;
    for (const side of [0, 1] as const) {
      if (this.at + BITMAP > body.length) throw new Error("The film is cut short.");
      const bitmap = this.at;
      this.at += BITMAP;
      const screen = this.screens[side];
      for (let t = 0; t < TILES; t++) {
        if (!(body[bitmap + (t >> 3)]! & (1 << (t & 7)))) continue;
        if (this.at + 64 > body.length) throw new Error("The film is cut short.");
        const x0 = (t % TILES_X) * 8;
        const y0 = Math.floor(t / TILES_X) * 8;
        for (let y = y0; y < y0 + 8; y++) for (let p = y * SCREEN_W + x0, e = p + 8; p < e; p++) screen[p] = palette[body[this.at++]!] ?? 0xff000000;
      }
    }
    this.frame++;
    return true;
  }

  /** Back to before the first frame. */
  rewind(): void {
    this.frame = -1;
    this.at = 0;
    for (const s of this.screens) s.fill(0);
  }
}
