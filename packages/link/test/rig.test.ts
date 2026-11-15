import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDR, dealDice, disagreements, DICE_LENGTH, MEMORY, MODEL, Rig, snapshot } from "highwire-link";

// The rig without the game: a cartridge of empty bytes is enough to check the emulator loads, steps both Game Boys
// together, reads and writes memory, and saves and restores state exactly. Tests that play a battle need the game
// (HIGHWIRE_LINK_ROM) and run in scripts/phase0.ts, never in CI.

const blank = () => new Uint8Array(0x8000);

test("two Game Boys step together, frame by frame", async () => {
  const rig = await Rig.create(blank(), MODEL.CGB_E);
  rig.run(30);
  assert.equal(rig.frameCount, 30);
  assert.equal(rig.model(0), MODEL.CGB_E);
  assert.equal(rig.model(1), MODEL.CGB_E);
});

test("memory reads and writes reach the right Game Boy", async () => {
  const rig = await Rig.create(blank());
  rig.write(0, 0xc123, 0xab);
  rig.write(1, 0xc123, 0x5c);
  assert.equal(rig.read(0, 0xc123), 0xab);
  assert.equal(rig.read(1, 0xc123), 0x5c);
  rig.write(0, ADDR.battleMonHP, 0x01);
  rig.write(0, ADDR.battleMonHP + 1, 0x2c);
  assert.equal(rig.read16(0, ADDR.battleMonHP), 300);
});

test("a saved state restores exactly, and the run from it repeats exactly", async () => {
  const rig = await Rig.create(blank());
  rig.run(10);
  const states = [rig.saveState(0), rig.saveState(1)] as const;
  rig.run(20);
  const after = [rig.saveState(0), rig.saveState(1)];
  rig.loadState(0, states[0]);
  rig.loadState(1, states[1]);
  rig.run(20);
  assert.deepEqual(rig.saveState(0), after[0]);
  assert.deepEqual(rig.saveState(1), after[1]);
});

test("a damaged state is refused", async () => {
  const rig = await Rig.create(blank());
  const state = rig.saveState(0);
  assert.throws(() => rig.loadState(0, state.subarray(0, 1000)), /refused/);
});

test("a fresh pair powers on the same every time", async () => {
  const one = await Rig.create(blank());
  const first = one.memory(0, MEMORY.RAM);
  const two = await Rig.create(blank());
  assert.deepEqual(two.memory(0, MEMORY.RAM), first);
});

test("the dice are dealt into both games alike, and the games then agree", async () => {
  const rig = await Rig.create(blank());
  // Power-on memory is noise; clear the battle fields so only the dice are compared.
  for (const side of [0, 1] as const) for (let a = 0xcfd7; a <= 0xd02f; a++) rig.write(side, a, 0);
  const dice = Uint8Array.from({ length: DICE_LENGTH }, (_, i) => i * 17 + 3);
  dealDice(rig, dice);
  const [a, b] = [snapshot(rig, 0), snapshot(rig, 1)];
  assert.deepEqual(a.dice, [...dice]);
  assert.equal(a.diceIndex, 0);
  assert.deepEqual(disagreements(a, b), []);
  rig.write(1, ADDR.linkBattleRandomNumberList, 0);
  assert.match(disagreements(a, snapshot(rig, 1)).join("\n"), /^dice:/);
  assert.throws(() => dealDice(rig, new Uint8Array(9)), /10 bytes/);
});

// A blank cartridge is a sled of NOPs from 0x0100, so the CPU executes every address after it once, in order.
test("a watch stamps each hit, in order, on the side that ran it", async () => {
  const rig = await Rig.create(blank());
  const late = rig.watch(0x0200, 0);
  const early = rig.watch(0x0180, 0);
  // A 32 KB cartridge always has bank 1 at 0x4000, so a watch there in bank 5 never fires.
  const never = rig.watch(0x4100, 5);
  const banked = rig.watch(0x4100, 1);
  rig.run(1);
  for (const side of [0, 1] as const) {
    const stamps = rig.stamps(side);
    assert.ok(stamps[early]! > 0);
    assert.ok(stamps[late]! > stamps[early]!);
    assert.equal(stamps[never], 0);
    assert.ok(stamps[banked]! > stamps[late]!);
    assert.equal(stamps[stamps.length - 1], Math.max(...stamps.subarray(0, stamps.length - 1)));
  }
});

test("a stop watch ends the run mid-frame, and states can't be saved until the frame is finished", async () => {
  const rig = await Rig.create(blank());
  const id = rig.watch(0x0300, 0, true);
  const stop = rig.run(5);
  assert.deepEqual(stop, { side: 0, watch: id });
  assert.equal(rig.frameCount, 0);
  assert.ok(rig.midFrame);
  assert.throws(() => rig.saveState(0), /mid-frame/);
  const next = rig.run(1);
  assert.deepEqual(next, { side: 1, watch: id });
  assert.equal(rig.run(1), null);
  assert.equal(rig.frameCount, 1);
  assert.ok(!rig.midFrame);
  rig.saveState(0);
});

test("a fresh rig forgets the last one's watches", async () => {
  const one = await Rig.create(blank());
  one.watch(0x0180, 0, true);
  const two = await Rig.create(blank());
  assert.equal(two.run(1), null);
  assert.equal(two.stamps(0)[0], 0);
});

test("work RAM is written directly, so a write lands even mid-DMA", async () => {
  const rig = await Rig.create(blank());
  rig.run(2);
  // Start an OAM DMA from work RAM on side 0: the bus drops CPU writes outside high RAM while it runs.
  rig.write(0, 0xff46, 0xc1);
  rig.write(0, ADDR.linkBattleRandomNumberList, 0x5a);
  rig.write(0, 0xff90, 0x33);
  assert.equal(rig.read(0, ADDR.linkBattleRandomNumberList), 0x5a);
  assert.equal(rig.read(0, 0xff90), 0x33);
});
