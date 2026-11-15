import createSameBoy, { type SameBoyModule } from "./wasm/sameboy.mjs";

// The rig (docs/link-battles.md 7): two Game Boys on one emulated link cable, in SameBoy's core built to WebAssembly.
// This file is only the emulator: load the game and states, run frames, press buttons, read and write memory, save.
// What the memory means is in yellow.ts; nothing here knows it's Pokémon.

export type Side = 0 | 1;
export const SIDES: readonly Side[] = [0, 1];

/** SameBoy's GB_model_t values the rig may run. */
export const MODEL = { DMG_B: 0x002, CGB_E: 0x205, AGB_A: 0x207 } as const;

/** SameBoy's GB_key_t. */
export const KEY = { RIGHT: 0, LEFT: 1, UP: 2, DOWN: 3, A: 4, B: 5, SELECT: 6, START: 7 } as const;
export type Key = keyof typeof KEY;

/** The most code addresses a rig can watch (native/rig.c). */
export const MAX_WATCHES = 64;

/** A watch that ended a run early: the side whose CPU reached it, and the watch's index. */
export type Stop = { side: Side; watch: number };

/** SameBoy's GB_direct_access_t, the ones the rig reads. */
export const MEMORY = { ROM: 0, RAM: 1, CART_RAM: 2, VRAM: 3, HRAM: 4, IO: 5 } as const;

let modulePromise: Promise<SameBoyModule> | null = null;
const sameboy = () => (modulePromise ??= createSameBoy());

/** One pair of linked Game Boys. A process holds one at a time: the WebAssembly module is a single instance. */
export class Rig {
  private frames = 0;

  private constructor(private readonly m: SameBoyModule) {}

  /** Two Game Boys of `model` with `rom` in both, linked. */
  static async create(rom: Uint8Array, model: number = MODEL.CGB_E): Promise<Rig> {
    const m = await sameboy();
    m._rig_init(model);
    const rig = new Rig(m);
    for (const side of SIDES) rig.withBuffer(rom, (ptr) => m._rig_load_rom(side, ptr, rom.length));
    return rig;
  }

  /** Frames run since the rig was made (a frame ends when both Game Boys have reached a vertical blank). */
  get frameCount(): number {
    return this.frames;
  }

  model(side: Side): number {
    return this.m._rig_model(side);
  }

  /** Loads a SameBoy save state into one Game Boy; throws if SameBoy refuses it. */
  loadState(side: Side, state: Uint8Array): void {
    const result = this.withBuffer(state, (ptr) => this.m._rig_load_state(side, ptr, state.length));
    if (result !== 0) throw new Error(`SameBoy refused the state for side ${side} (${result}).`);
  }

  saveState(side: Side): Uint8Array {
    if (this.midFrame) throw new Error("The rig is mid-frame; finish the frame before saving.");
    const size = this.m._rig_state_size(side);
    const ptr = this.m._malloc(size);
    try {
      this.m._rig_save_state(side, ptr);
      return this.m.HEAPU8.slice(ptr, ptr + size);
    } finally {
      this.m._free(ptr);
    }
  }

  /**
   * Runs both Game Boys `frames` frames, or until a stop watch fires (then mid-frame: the next run finishes that frame).
   * Returns the watch that stopped it, or null.
   */
  run(frames = 1): Stop | null {
    const done = this.m._rig_run_frames(frames);
    this.frames += done;
    const stopped = this.m._rig_stopped();
    return stopped ? { side: ((stopped >> 8) - 1) as Side, watch: stopped & 0xff } : null;
  }

  /** Runs until `done` is true (checked after every frame) or `budget` frames pass; returns the frames run, or null at the budget. */
  runUntil(done: () => boolean, budget: number): number | null {
    for (let i = 1; i <= budget; i++) {
      this.run(1);
      if (done()) return i;
    }
    return null;
  }

  /** True between a stop watch and the end of the frame it fired in. States may be saved only between frames. */
  get midFrame(): boolean {
    return this.m._rig_mid_frame() !== 0;
  }

  /**
   * Watches a code address: from now on the rig notes each time either CPU executes it (`stamps`), and with `stop`
   * ends the run there. `bank` is the ROM bank for addresses from 0x4000; bank 0's are watched whatever is mapped.
   */
  watch(addr: number, bank: number, stop = false): number {
    const id = this.m._rig_watch(addr, bank, stop ? 1 : 0);
    if (id < 0) throw new Error(`Can't watch ${bank.toString(16)}:${addr.toString(16)} (at most ${MAX_WATCHES}, in ROM).`);
    return id;
  }

  /**
   * Each watch's stamp on one side: the side's running count of watch hits when that watch was last hit (0: never),
   * and, last, the count itself. Comparing stamps says which routines ran, and in what order.
   */
  stamps(side: Side): Uint32Array {
    const base = this.m._rig_seq() / 4 + side * (MAX_WATCHES + 1);
    return this.m.HEAPU32.slice(base, base + MAX_WATCHES + 1);
  }

  /** Forgets every watch (a battle sets its own up; a second one on the same rig mustn't inherit the first's). */
  clearWatches(): void {
    this.m._rig_watch_clear();
  }

  /** The link cable's bits in flight, which a saved battle must carry to resume exactly (rig.c). */
  get cable(): number {
    return this.m._rig_cable_get();
  }

  set cable(bits: number) {
    this.m._rig_cable_set(bits & 3);
  }

  /** The CPU's program counter, for debugging. */
  pc(side: Side): number {
    return this.m._rig_pc(side);
  }

  key(side: Side, key: Key, pressed: boolean): void {
    this.m._rig_set_key(side, KEY[key], pressed ? 1 : 0);
  }

  /** Presses a button for `hold` frames, then releases it for `release` frames. */
  press(side: Side, key: Key, hold = 4, release = 8): void {
    this.key(side, key, true);
    this.run(hold);
    this.key(side, key, false);
    this.run(release);
  }

  /** Reads one byte as the CPU would see it, without side effects. */
  read(side: Side, addr: number): number {
    return this.m._rig_read(side, addr);
  }

  readBytes(side: Side, addr: number, length: number): number[] {
    return Array.from({ length }, (_, i) => this.read(side, addr + i));
  }

  /** A big-endian 16-bit value, as the game stores HP. */
  read16(side: Side, addr: number): number {
    return (this.read(side, addr) << 8) | this.read(side, addr + 1);
  }

  write(side: Side, addr: number, value: number): void {
    this.m._rig_write(side, addr, value & 0xff);
  }

  /** A copy of one of a Game Boy's memories (MEMORY). */
  memory(side: Side, which: number): Uint8Array {
    const ptr = this.m._rig_direct(side, which);
    return this.m.HEAPU8.slice(ptr, ptr + this.m._rig_last_size());
  }

  setRendering(on: boolean): void {
    this.m._rig_set_rendering(on ? 1 : 0);
  }

  /** The last frame one Game Boy drew, 160 × 144 RGBA, when rendering is on. */
  screen(side: Side): Uint8Array {
    const ptr = this.m._rig_pixels(side);
    return this.m.HEAPU8.slice(ptr, ptr + 160 * 144 * 4);
  }

  private withBuffer<T>(bytes: Uint8Array, use: (ptr: number) => T): T {
    const ptr = this.m._malloc(bytes.length);
    try {
      this.m.HEAPU8.set(bytes, ptr);
      return use(ptr);
    } finally {
      this.m._free(ptr);
    }
  }
}
