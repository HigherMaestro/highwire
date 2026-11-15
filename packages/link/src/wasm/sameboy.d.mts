// Types for the Emscripten build of native/rig.c (scripts/build-wasm.sh).

export interface SameBoyModule {
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _rig_init(model: number): void;
  _rig_load_rom(side: number, ptr: number, size: number): void;
  _rig_state_size(side: number): number;
  _rig_save_state(side: number, ptr: number): void;
  _rig_load_state(side: number, ptr: number, size: number): number;
  _rig_run_frames(frames: number): number;
  _rig_set_key(side: number, key: number, pressed: number): void;
  _rig_read(side: number, addr: number): number;
  _rig_write(side: number, addr: number, value: number): void;
  _rig_direct(side: number, access: number): number;
  _rig_last_size(): number;
  _rig_set_rendering(on: number): void;
  _rig_pixels(side: number): number;
  _rig_model(side: number): number;
  _rig_stopped(): number;
  _rig_mid_frame(): number;
  _rig_watch(addr: number, bank: number, stop: number): number;
  _rig_watch_clear(): void;
  _rig_seq(): number;
  _rig_pc(side: number): number;
  _rig_cable_get(): number;
  _rig_cable_set(bits: number): void;
}

declare const createSameBoy: () => Promise<SameBoyModule>;
export default createSameBoy;
