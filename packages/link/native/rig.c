// The link battle rig's native half: two Game Boys in one process, joined by an emulated link cable, stepped together
// by cycle count. Everything else (decisions, memory reading, the dice) is TypeScript in src/; this file only exposes
// SameBoy's core (docs/link-battles.md 7.1). Built to WebAssembly by scripts/build-wasm.sh.

#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <emscripten/emscripten.h>
#include "Core/gb.h"
#include "Core/random.h"

#define SIDES 2
#define SCREEN_PIXELS (160 * 144)

static GB_gameboy_t gbs[SIDES];
static bool ready[SIDES];
static bool bit_to_send[SIDES];
static bool vblank[SIDES];
static uint32_t pixels[SIDES][SCREEN_PIXELS];
static size_t last_size;

static unsigned side_of(GB_gameboy_t *gb) { return gb == &gbs[1] ? 1 : 0; }

static void on_vblank(GB_gameboy_t *gb, GB_vblank_type_t type) {
  (void)type;
  vblank[side_of(gb)] = true;
}

// The cable: each Game Boy's outgoing bit is held until the other's transfer ends, as SameBoy's libretro core does.
static void serial_start(GB_gameboy_t *gb, bool bit_received) { bit_to_send[side_of(gb)] = bit_received; }

static bool serial_end(GB_gameboy_t *gb) {
  unsigned me = side_of(gb), other = 1 - me;
  bool ret = GB_serial_get_data_bit(&gbs[other]);
  GB_serial_set_data_bit(&gbs[other], bit_to_send[me]);
  return ret;
}

static uint32_t rgb_encode(GB_gameboy_t *gb, uint8_t r, uint8_t g, uint8_t b) {
  (void)gb;
  return 0xFF000000u | ((uint32_t)b << 16) | ((uint32_t)g << 8) | r; // RGBA in little-endian memory
}

static void silent_log(GB_gameboy_t *gb, const char *string, GB_log_attributes_t attributes) {
  (void)gb; (void)string; (void)attributes;
}

/** Makes (or remakes) both Game Boys as `model` (a GB_model_t). */
EMSCRIPTEN_KEEPALIVE void rig_init(int model) {
  // SameBoy fills power-on memory from a clock-seeded generator; a constant seed makes a fresh pair the same every
  // time, so a bootstrap made from one is reproducible (docs/link-battles.md 7.1).
  GB_random_seed(0x4C494E4Bu);
  for (unsigned i = 0; i < SIDES; i++) {
    if (ready[i]) GB_free(&gbs[i]);
    GB_init(&gbs[i], (GB_model_t)model);
    GB_set_log_callback(&gbs[i], silent_log);
    GB_set_vblank_callback(&gbs[i], on_vblank);
    GB_set_rgb_encode_callback(&gbs[i], rgb_encode);
    GB_set_pixels_output(&gbs[i], pixels[i]);
    GB_set_rendering_disabled(&gbs[i], true);
    GB_set_serial_transfer_bit_start_callback(&gbs[i], serial_start);
    GB_set_serial_transfer_bit_end_callback(&gbs[i], serial_end);
    bit_to_send[i] = true;
    ready[i] = true;
  }
}

EMSCRIPTEN_KEEPALIVE void rig_load_rom(int side, const uint8_t *buffer, size_t size) {
  GB_load_rom_from_buffer(&gbs[side], buffer, size);
}

EMSCRIPTEN_KEEPALIVE size_t rig_state_size(int side) { return GB_get_save_state_size(&gbs[side]); }

EMSCRIPTEN_KEEPALIVE void rig_save_state(int side, uint8_t *buffer) { GB_save_state_to_buffer(&gbs[side], buffer); }

/** 0 on success, as SameBoy returns. */
EMSCRIPTEN_KEEPALIVE int rig_load_state(int side, const uint8_t *buffer, size_t size) {
  return GB_load_state_from_buffer(&gbs[side], buffer, size);
}

/**
 * Runs both Game Boys for `frames` frames, a frame ending when both have reached a vertical blank, interleaving
 * GB_run by the cycles each has run so the cable never drifts. Returns the frames run.
 */
EMSCRIPTEN_KEEPALIVE int rig_run_frames(int frames) {
  for (int f = 0; f < frames; f++) {
    vblank[0] = vblank[1] = false;
    long delta = 0;
    while (!vblank[0] || !vblank[1]) {
      if (delta >= 0) delta -= GB_run(&gbs[0]);
      else delta += GB_run(&gbs[1]);
    }
  }
  return frames;
}

EMSCRIPTEN_KEEPALIVE void rig_set_key(int side, int key, int pressed) { GB_set_key_state(&gbs[side], (GB_key_t)key, pressed != 0); }

EMSCRIPTEN_KEEPALIVE int rig_read(int side, int addr) { return GB_safe_read_memory(&gbs[side], (uint16_t)addr); }

EMSCRIPTEN_KEEPALIVE void rig_write(int side, int addr, int value) { GB_write_memory(&gbs[side], (uint16_t)addr, (uint8_t)value); }

/** A pointer into one of SameBoy's memories (a GB_direct_access_t); its size is in rig_last_size(). */
EMSCRIPTEN_KEEPALIVE void *rig_direct(int side, int access) {
  uint16_t bank = 0;
  return GB_get_direct_access(&gbs[side], (GB_direct_access_t)access, &last_size, &bank);
}

EMSCRIPTEN_KEEPALIVE size_t rig_last_size(void) { return last_size; }

EMSCRIPTEN_KEEPALIVE void rig_set_rendering(int on) {
  for (unsigned i = 0; i < SIDES; i++) GB_set_rendering_disabled(&gbs[i], on == 0);
}

/** The last frame each Game Boy drew, 160 × 144 RGBA pixels, when rendering is on. */
EMSCRIPTEN_KEEPALIVE uint32_t *rig_pixels(int side) { return pixels[side]; }

EMSCRIPTEN_KEEPALIVE int rig_model(int side) { return (int)GB_get_model(&gbs[side]); }
