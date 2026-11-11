import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { commitDeadline, decodeLegacyCommit, decodeSeriesAccount, decodeWager, decodeWagerConfig, encodeWager, revealDeadline, ticketMessage, WAGER_PROGRAM_IDS, type WagerArgs } from "../src/tx/wager-codec.ts";

// The wager program's byte formats, against test/fixtures/wager-codec.json, which the program's own tests
// (programs/line-wager/tests/codec.rs) check is exactly what it encodes.

const file = JSON.parse(readFileSync(new URL("./fixtures/wager-codec.json", import.meta.url), "utf8"));
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const h = (b: number) => b.toString(16).padStart(2, "0").repeat(32);

test("every instruction Highwire builds encodes as the program does, and decodes back", async () => {
  const args: Record<string, WagerArgs> = {
    open: { kind: "open", ticket: { seriesId: h(0x11), playerA: key(5), playerB: key(6), stake: 100_000_000n, acceptDeadline: 1_300, expiry: 1_600, keyId: 3 }, fallbackHash: h(0x44) },
    accept: { kind: "accept", fallbackHash: h(0x55) },
    cancel: { kind: "cancel" },
    commit: { kind: "commit", match: 2, round: 7, hash: h(0x66) },
    reveal: { kind: "reveal", pull: 13, nonce: h(0x22) },
    revealFallback: { kind: "revealFallback", fallback: { kind: "steady", pull: 9 }, salt: h(0x33) },
    timeout: { kind: "timeout" },
    settle: { kind: "settle" },
    retire: { kind: "retire" },
    emergencyRefund: { kind: "emergencyRefund" },
  };
  assert.deepEqual(Object.keys(args).sort(), Object.keys(file.instructions).filter((k) => k !== "initConfig").sort());
  // The maintainer's one-time setup, from the same file.
  const { initConfigInstruction } = await import("../src/tx/wager-codec.ts");
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
  assert.deepEqual(decodeWager(Buffer.from(file.instructions.commit, "hex")), { kind: "commit", match: 2, round: 7, hash: h(0x66) });
  // A commit is 35 bytes: the tag, the match, the round, the hash. Before it named its match it was 34 (the tag, the
  // round, the hash), which is no instruction now; only the history reader knows that shape, as a commit with no match.
  assert.equal(file.instructions.commit.length, 70);
  const before = Buffer.concat([Buffer.from([5, 7]), Buffer.from(h(0x66), "hex")]);
  assert.equal(decodeWager(before), null);
  assert.deepEqual(decodeLegacyCommit(before), { round: 7, hash: h(0x66) });
  assert.equal(decodeLegacyCommit(Buffer.from(file.instructions.commit, "hex")), null);
  assert.equal(decodeLegacyCommit(Buffer.from(file.instructions.reveal, "hex")), null, "a reveal is 34 bytes too, under another tag");
  assert.throws(() => encodeWager({ kind: "commit", match: 256, round: 1, hash: h(1) }), /the match is a whole number from 0 to 255/);
  // Truncated, padded or unknown: not a wager instruction.
  assert.equal(decodeWager(Buffer.from(file.instructions.commit.slice(0, -2), "hex")), null);
  assert.equal(decodeWager(Buffer.from(file.instructions.commit + "00", "hex")), null);
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

test("a series' outcome is the program's own closing event for it, and nothing else", async () => {
  const { closingEvent, seriesOutcome } = await import("../src/tx/wager.ts");
  const P = WAGER_PROGRAM_IDS.devnet!;
  const id = h(0x11);
  const b64 = (b: Uint8Array | string) => Buffer.from(b).toString("base64");
  const data = (kind: number, series: string, outcome: number) => `Program data: ${b64("line-wager")} ${b64(Uint8Array.of(kind))} ${b64(Buffer.from(series, "hex"))} ${b64(Uint8Array.of(outcome))}`;
  const frame = (program: string, inner: string[], depth = 1) => [`Program ${program} invoke [${depth}]`, ...inner, `Program ${program} consumed 5000 of 200000 compute units`, `Program ${program} success`];
  const other = "Evi1Program11111111111111111111111111111111";
  // A settle to B, as the program logs it.
  assert.deepEqual(closingEvent(frame(P, [data(1, id, 1)]), P, id), { state: "closed", how: "settled", winner: "B" });
  assert.deepEqual(closingEvent(frame(P, [data(1, id, 2)]), P, id), { state: "closed", how: "settled", winner: null });
  assert.deepEqual(closingEvent(frame(P, [data(2, id, 255)]), P, id), { state: "closed", how: "cancelled" });
  assert.deepEqual(closingEvent(frame(P, [data(3, id, 255)]), P, id), { state: "closed", how: "refunded" });
  // Made through another program: the program's own frame, one level down, still counts.
  assert.deepEqual(closingEvent(frame(other, frame(P, [data(1, id, 0)], 2)), P, id), { state: "closed", how: "settled", winner: "A" });
  // Forged by another program (its frame, even after the real program's frame closed), or for another series: ignored.
  assert.equal(closingEvent(frame(other, [data(1, id, 0)]), P, id), null);
  assert.equal(closingEvent([...frame(P, []), data(1, id, 0)], P, id), null);
  assert.equal(closingEvent(frame(P, [data(1, h(0x22), 0)]), P, id), null);
  assert.equal(closingEvent(frame(P, [`Program log: ${data(1, id, 0)}`]), P, id), null);
  // A truncated log reads as nothing found, never as a guess.
  assert.equal(closingEvent(["Log truncated", ...frame(P, [data(1, id, 0)])], P, id), null);

  // seriesOutcome: the account while it plays; then the event, past unrelated transactions that name the address.
  const chain = (opts: { account?: Buffer; history?: string[][] }) =>
    ({
      cluster: "devnet",
      connection: {
        getAccountInfo: async () => (opts.account ? { data: opts.account, owner: new PublicKey(P) } : null),
        getSignaturesForAddress: async () => (opts.history ?? []).map((_, i) => ({ signature: `s${i}`, err: null })),
        getTransaction: async (sig: string) => ({ meta: { logMessages: opts.history![Number(sig.slice(1))] } }),
      },
    }) as never;
  assert.deepEqual(await seriesOutcome(chain({ account: Buffer.from(file.seriesAccount, "hex") }), id), { state: "live" });
  const noise = Array.from({ length: 30 }, () => frame("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", ["Program log: Memo"]));
  assert.deepEqual(await seriesOutcome(chain({ history: [...noise, frame(P, [data(1, id, 0)])] }), id), { state: "closed", how: "settled", winner: "A" });
  assert.deepEqual(await seriesOutcome(chain({ history: noise }), id), { state: "none" });
  assert.deepEqual(await seriesOutcome(chain({}), id), { state: "none" });
});
