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

// Watches: code addresses in the game whose execution the rig records (docs/link-battles.md 7.2). Each hit stamps the
// watch with its side's running count, so TypeScript can tell which routines ran since it last looked and in what
// order; a watch marked `stop` also ends rig_run_frames early, mid-frame, so memory can be read at that instruction.
#define MAX_WATCHES 64
#define ANY_BANK 0xFFFF
static uint8_t watched[0x8000 / 8]; // ROM addresses with at least one watch, to keep the per-instruction check cheap
static struct { uint16_t addr; uint16_t bank; bool stop; } watches[MAX_WATCHES];
static unsigned watch_count;
// seq[side][i] is the count at watch i's last hit; seq[side][MAX_WATCHES] is the side's running count.
static uint32_t seq[SIDES][MAX_WATCHES + 1];
static int stopped; // 0, or (side + 1) << 8 | watch
// A frame stopped by a watch is finished by the next run; a frame's start resets the cable's cycle balance, so a state
// saved between frames is all there is to the pair.
static bool mid_frame;
static long delta;

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

static void on_instruction(GB_gameboy_t *gb, uint16_t address, uint8_t opcode) {
  (void)opcode;
  if (address >= 0x8000 || !(watched[address >> 3] & (1 << (address & 7)))) return;
  unsigned side = side_of(gb);
  uint16_t bank = 0;
  if (address >= 0x4000) {
    size_t size;
    GB_get_direct_access(gb, GB_DIRECT_ACCESS_ROM, &size, &bank);
  }
  for (unsigned i = 0; i < watch_count; i++) {
    if (watches[i].addr != address || (watches[i].bank != ANY_BANK && watches[i].bank != bank)) continue;
    seq[side][i] = ++seq[side][MAX_WATCHES];
    if (watches[i].stop && !stopped) stopped = (int)((side + 1) << 8 | i);
  }
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
  mid_frame = false;
  stopped = 0;
  watch_count = 0;
  memset(watched, 0, sizeof watched);
  memset(seq, 0, sizeof seq);
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
    GB_set_execution_callback(&gbs[i], on_instruction);
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
  mid_frame = false;
  return GB_load_state_from_buffer(&gbs[side], buffer, size);
}

/**
 * Runs both Game Boys for `frames` frames, a frame ending when both have reached a vertical blank, interleaving
 * GB_run by the cycles each has run so the cable never drifts. Returns the frames finished, fewer when a stop watch
 * fires (rig_stopped() then says which); the next call finishes the frame it stopped in.
 */
EMSCRIPTEN_KEEPALIVE int rig_run_frames(int frames) {
  stopped = 0;
  for (int f = 0; f < frames; f++) {
    if (!mid_frame) {
      vblank[0] = vblank[1] = false;
      delta = 0;
      mid_frame = true;
    }
    while (!vblank[0] || !vblank[1]) {
      if (delta >= 0) delta -= GB_run(&gbs[0]);
      else delta += GB_run(&gbs[1]);
      if (stopped) return f;
    }
    mid_frame = false;
  }
  return frames;
}

EMSCRIPTEN_KEEPALIVE int rig_stopped(void) { return stopped; }

EMSCRIPTEN_KEEPALIVE int rig_mid_frame(void) { return mid_frame; }

/** Adds a watch on `addr` in ROM bank `bank` (0xFFFF for any); returns its index, or -1 when full. */
EMSCRIPTEN_KEEPALIVE int rig_watch(int addr, int bank, int stop) {
  if (watch_count >= MAX_WATCHES || addr < 0 || addr >= 0x8000) return -1;
  watches[watch_count].addr = (uint16_t)addr;
  watches[watch_count].bank = addr < 0x4000 ? ANY_BANK : (uint16_t)bank;
  watches[watch_count].stop = stop != 0;
  watched[addr >> 3] |= (uint8_t)(1 << (addr & 7));
  return (int)watch_count++;
}

EMSCRIPTEN_KEEPALIVE void rig_watch_clear(void) {
  watch_count = 0;
  memset(watched, 0, sizeof watched);
  memset(seq, 0, sizeof seq);
}

/** seq, as uint32s: side 0's MAX_WATCHES stamps and its count, then side 1's. */
EMSCRIPTEN_KEEPALIVE uint32_t *rig_seq(void) { return &seq[0][0]; }

/**
 * The cable's bits in flight: each side's outgoing bit, held until the other's transfer ends. They live here, not in
 * SameBoy's state, so a saved battle carries them (bit 0: side 0's, bit 1: side 1's) and resumes exactly at any frame.
 */
EMSCRIPTEN_KEEPALIVE int rig_cable_get(void) { return (bit_to_send[0] ? 1 : 0) | (bit_to_send[1] ? 2 : 0); }

EMSCRIPTEN_KEEPALIVE void rig_cable_set(int bits) {
  bit_to_send[0] = (bits & 1) != 0;
  bit_to_send[1] = (bits & 2) != 0;
}

EMSCRIPTEN_KEEPALIVE int rig_pc(int side) { return GB_get_registers(&gbs[side])->pc; }

EMSCRIPTEN_KEEPALIVE void rig_set_key(int side, int key, int pressed) { GB_set_key_state(&gbs[side], (GB_key_t)key, pressed != 0); }

EMSCRIPTEN_KEEPALIVE int rig_read(int side, int addr) { return GB_safe_read_memory(&gbs[side], (uint16_t)addr); }

/**
 * Writes one byte. Work RAM and high RAM are written directly, never through the CPU's bus: between frames a game is
 * often inside its vertical blank's OAM DMA, when the bus drops CPU writes, and a dropped write of the dice desyncs the
 * battle. Anything else (registers, cartridge RAM) goes through the bus with its side effects.
 */
EMSCRIPTEN_KEEPALIVE void rig_write(int side, int addr, int value) {
  size_t size;
  uint16_t bank;
  if (addr >= 0xC000 && addr < 0xE000) {
    uint8_t *ram = GB_get_direct_access(&gbs[side], GB_DIRECT_ACCESS_RAM, &size, &bank);
    size_t offset = addr < 0xD000 ? (size_t)(addr - 0xC000) : (size_t)(addr - 0xD000) + 0x1000 * (bank ? bank : 1);
    if (offset < size) ram[offset] = (uint8_t)value;
    return;
  }
  if (addr >= 0xFF80 && addr < 0xFFFF) {
    uint8_t *hram = GB_get_direct_access(&gbs[side], GB_DIRECT_ACCESS_HRAM, &size, &bank);
    if ((size_t)(addr - 0xFF80) < size) hram[addr - 0xFF80] = (uint8_t)value;
    return;
  }
  GB_write_memory(&gbs[side], (uint16_t)addr, (uint8_t)value);
}

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
