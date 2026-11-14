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
