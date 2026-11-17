import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeText } from "../src/data.ts";
import { encodeName, TRAINER_NAME_MAX, trainerName, writeTrainers } from "../src/trainers.ts";

// The trainers' names (trainers.ts) without the game: what a name becomes, and where it goes in each game's memory.

test("a name keeps only what the game can show, seven characters at most", () => {
  assert.equal(trainerName("LGTM", "AGENT"), "LGTM");
  assert.equal(trainerName("Looks Good To Me", "AGENT"), "Looks G");
  assert.equal(trainerName("  $CONFLICT!! ", "AGENT"), "CONFLIC");
  assert.equal(trainerName("Pokémon", "AGENT"), "Pokemon", "accents fold to their letters");
  assert.equal(trainerName("🚀🚀", "AGENT"), "AGENT", "nothing left: the fallback");
  assert.equal(trainerName("a\u0000b\nc", "AGENT"), "abc", "no control codes reach the game");
  assert.ok(trainerName("x".repeat(40), "AGENT").length <= TRAINER_NAME_MAX);
});

test("a name is the game's characters, padded with its terminator, and reads back", () => {
  const bytes = encodeName("Lgtm 42");
  assert.equal(bytes.length, 11);
  assert.deepEqual([...bytes.subarray(7)], [0x50, 0x50, 0x50, 0x50]);
  assert.equal(decodeText(bytes), "Lgtm 42");
});

test("each game's player is its own side, its opponent the other, on both teams' trainers", () => {
  const mem = [new Map<number, number>(), new Map<number, number>()];
  writeTrainers({ write: (side, addr, v) => void mem[side]!.set(addr, v) }, ["HOUSE", "LGTM"]);
  const read = (side: 0 | 1, at: number) => decodeText(Array.from({ length: 11 }, (_, i) => mem[side]!.get(at + i) ?? 0x50));
  for (const [side, own, other] of [[0, "HOUSE", "LGTM"], [1, "LGTM", "HOUSE"]] as const) {
    assert.equal(read(side, 0xd157), own, "the player's name");
    assert.equal(read(side, 0xd886), other, "the other player's, as the cable brought it");
    assert.equal(read(side, 0xd049), other, "the copy the battle's text reads");
    for (let i = 0; i < 6; i++) {
      assert.equal(read(side, 0xd272 + i * 11), own, `own team's trainer ${i}`);
      assert.equal(read(side, 0xd9ab + i * 11), other, `the other team's trainer ${i}`);
    }
  }
});
