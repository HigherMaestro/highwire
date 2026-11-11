import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { commitDeadline, decodeSeriesAccount, decodeWager, decodeWagerConfig, encodeWager, revealDeadline, ticketMessage, WAGER_PROGRAM_IDS, type WagerArgs } from "../src/codec.ts";

// The wager program's byte formats, against test/fixtures/wager-codec.json, which the program's own tests
// (programs/line-wager/tests/codec.rs) check is exactly what it encodes.

const file = JSON.parse(readFileSync(new URL("../../core/test/fixtures/wager-codec.json", import.meta.url), "utf8"));
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const h = (b: number) => b.toString(16).padStart(2, "0").repeat(32);

test("every instruction Highwire builds encodes as the program does, and decodes back", async () => {
  const args: Record<string, WagerArgs> = {
    open: { kind: "open", ticket: { seriesId: h(0x11), playerA: key(5), playerB: key(6), stake: 100_000_000n, acceptDeadline: 1_300, expiry: 1_600, keyId: 3 }, fallbackHash: h(0x44) },
    accept: { kind: "accept", fallbackHash: h(0x55) },
    cancel: { kind: "cancel" },
    commit: { kind: "commit", round: 7, hash: h(0x66) },
    reveal: { kind: "reveal", pull: 13, nonce: h(0x22) },
    revealFallback: { kind: "revealFallback", fallback: { kind: "steady", pull: 9 }, salt: h(0x33) },
    timeout: { kind: "timeout" },
    settle: { kind: "settle" },
    retire: { kind: "retire" },
    emergencyRefund: { kind: "emergencyRefund" },
  };
  assert.deepEqual(Object.keys(args).sort(), Object.keys(file.instructions).filter((k) => k !== "initConfig").sort());
  // The maintainer's one-time setup, from the same file.
  const { initConfigInstruction } = await import("../src/codec.ts");
  const init = initConfigInstruction(new PublicKey(WAGER_PROGRAM_IDS.devnet!), {
    authority: new PublicKey(key(1)), ticketKey: new PublicKey(key(2)), ticketKeyId: 3, feeBps: 250, feeAccount: new PublicKey(key(4)),
    tiers: [10_000_000n, 100_000_000n], maxStake: 100_000_000n, openStakeCap: 5_000_000_000n, revealSeconds: 120,
  });
  assert.equal(Buffer.from(init.data).toString("hex"), file.instructions.initConfig);
  assert.equal(decodeWager(Buffer.from(init.data))?.kind, "initConfig");
  for (const [kind, a] of Object.entries(args)) {
    const bytes = encodeWager(a);
    assert.equal(bytes.toString("hex"), file.instructions[kind], kind);
    assert.equal(decodeWager(bytes)?.kind, kind);
  }
  const open = decodeWager(Buffer.from(file.instructions.open, "hex"));
  assert.deepEqual(open, { kind: "open", seriesId: h(0x11), playerB: key(6), stake: 100_000_000n, acceptDeadline: 1_300, expiry: 1_600, keyId: 3, fallbackHash: h(0x44) });
  // Truncated, padded or unknown: not a wager instruction.
  assert.equal(decodeWager(Buffer.from(file.instructions.commit.slice(0, -2), "hex")), null);
  assert.equal(decodeWager(Buffer.from(file.instructions.retire + "00", "hex")), null);
  assert.equal(decodeWager(Buffer.from([99])), null);
  assert.throws(() => encodeWager({ kind: "reveal", pull: 256, nonce: h(1) }), /0 to 255/);
});

test("the config and a series mid-game read exactly as the program wrote them", () => {
  const c = decodeWagerConfig(Buffer.from(file.config, "hex"));
  assert.deepEqual(
    { ...c, tiers: c.tiers.map(String) },
    {
      authority: key(1), ticketKey: key(2), ticketKeyId: 3, paused: false, feeBps: 250, feeAccount: key(4),
      tiers: ["10000000", "100000000"], maxStake: 1_000_000_000n, openStakeCap: 5_000_000_000n, openStake: 200_000_000n, revealSeconds: 120,
      rules: { places: 3, energy: 30, regen: 2, rounds: 15, tieBreakSpent: false, roundSeconds: 120, bankSeconds: 600 },
    },
  );
  const { header, series } = decodeSeriesAccount(Buffer.from(file.seriesAccount, "hex"));
  assert.deepEqual(header, {
    status: "live", seriesId: h(0x11), playerA: key(5), playerB: key(6), stake: 100_000_000n, feeBps: 250, feeAccount: key(4),
    ticketKeyId: 3, acceptDeadline: 1_300, ticketExpiry: 1_600, lastChange: 1_140, fallbackHashA: h(0x44),
  });
  assert.ok(series);
  // B missed round 1's commit and revealed its fallback (steady 9); A pulled 4. Round 2's commit phase opened at 1140.
  assert.deepEqual(series.fallback, { A: null, B: { kind: "steady", pull: 9 } });
  assert.equal(series.fallbackHash.A, h(0x44));
  assert.deepEqual([series.match, series.phase, series.phaseOpenedAt, series.game.rounds], [0, "commit", 1_140, 1]);
  assert.deepEqual(series.game.lastPull, [4, 9]);
  assert.deepEqual(series.game.energy, [28, 23]);
  assert.deepEqual(series.bank, { A: 590, B: 480 });
  assert.deepEqual(series.round, [{ hash: null, owesFallback: false, pull: null }, { hash: null, owesFallback: false, pull: null }]);
  assert.deepEqual([series.results.every((r) => r === null), series.ending], [true, null]);
  assert.equal(commitDeadline(series, 0), 1_140 + 120);
  assert.equal(revealDeadline(series), 1_140 + 120);
});

test("the ticket message is the program's: domain, program, series, players, stake, deadlines, key id", () => {
  const program = new PublicKey(WAGER_PROGRAM_IDS.devnet!);
  const m = ticketMessage(program, { seriesId: h(0x11), playerA: key(5), playerB: key(6), stake: 1n, acceptDeadline: 2, expiry: 3, keyId: 4 });
  assert.equal(m.length, 176);
  assert.equal(m.subarray(0, 22).toString(), "highwire-line-ticket-1");
  assert.ok(m.subarray(22, 54).equals(program.toBuffer()));
  assert.equal(m.readUInt16LE(174), 4);
});

test("the desk's ticket is byte for byte the one the program checks", async () => {
  // The relay signs tickets with its own encoder (it doesn't depend on this package); the program verifies the codec's.
  const { wagerTicketMessage } = await import("highwire-relay");
  const program = WAGER_PROGRAM_IDS.devnet!;
  for (const [stake, acceptDeadline, expiry, keyId] of [[100_000_000n, 1_300, 1_600, 1], [10_000_000n, 1_762_800_000, 1_762_800_000, 65_535], [18_446_744_073_709_551_615n, 0, 4_294_967_295, 0]] as const) {
    const t = { seriesId: h(0x5a), playerA: key(1), playerB: key(2), stake, acceptDeadline, expiry, keyId };
    assert.deepEqual(Buffer.from(wagerTicketMessage(program, { ...t, stake: stake.toString() })), ticketMessage(new PublicKey(program), t));
  }
});
