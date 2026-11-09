import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { commitDeadline, decodeSeriesAccount, decodeWager, decodeWagerConfig, encodeWager, revealDeadline, ticketMessage, WAGER_PROGRAM_IDS, type WagerArgs } from "../src/tx/wager-codec.ts";

// The wager program's byte formats, against test/fixtures/wager-codec.json, which the program's own tests
// (programs/line-wager/tests/codec.rs) check is exactly what it encodes.

const file = JSON.parse(readFileSync(new URL("./fixtures/wager-codec.json", import.meta.url), "utf8"));
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const h = (b: number) => b.toString(16).padStart(2, "0").repeat(32);

test("every instruction Highwire builds encodes as the program does, and decodes back", () => {
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
  assert.deepEqual(Object.keys(args).sort(), Object.keys(file.instructions).sort());
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

test("a series' outcome: its account while it plays, then the transaction that closed it", async () => {
  const { Keypair, TransactionMessage, VersionedTransaction } = await import("@solana/web3.js");
  const { seriesOutcome, wagerInstruction } = await import("../src/tx/wager.ts");
  const program = new PublicKey(WAGER_PROGRAM_IDS.devnet!);
  const [a, b, fee, crank] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey] as const;
  const id = h(0x11);
  const stake = 100_000_000n;
  const closing = (kind: "settle" | "cancel" | "emergencyRefund", deltas: [bigint, bigint]) => {
    const ix = wagerInstruction(program, crank, id, { kind } as never, { playerA: a, playerB: b, feeAccount: fee });
    const message = new TransactionMessage({ payerKey: crank, recentBlockhash: PublicKey.default.toBase58(), instructions: [ix] }).compileToV0Message();
    const keys = message.staticAccountKeys.map((k) => k.toBase58());
    const pre = keys.map(() => 1_000_000_000);
    const post = keys.map((k, i) => pre[i]! + Number(k === a.toBase58() ? deltas[0] : k === b.toBase58() ? deltas[1] : 0n));
    return { transaction: new VersionedTransaction(message), meta: { preBalances: pre, postBalances: post } };
  };
  const chain = (opts: { account?: Buffer; history?: ReturnType<typeof closing>[] }) =>
    ({
      cluster: "devnet",
      connection: {
        getAccountInfo: async () => (opts.account ? { data: opts.account, owner: program } : null),
        getSignaturesForAddress: async () => (opts.history ?? []).map((_, i) => ({ signature: `s${i}`, err: null })),
        getTransaction: async (sig: string) => opts.history?.[Number(sig.slice(1))] ?? null,
      },
    }) as never;
  const players = { playerA: a.toBase58(), playerB: b.toBase58(), stake };
  assert.deepEqual(await seriesOutcome(chain({ account: Buffer.from(file.seriesAccount, "hex") }), id, players), { state: "live" });
  assert.deepEqual(await seriesOutcome(chain({}), id, players), { state: "none" });
  const won = 2n * stake - 5_000_000n;
  assert.deepEqual(await seriesOutcome(chain({ history: [closing("settle", [won, 4_000_000n])] }), id, players), { state: "closed", how: "settled", winner: "A" });
  assert.deepEqual(await seriesOutcome(chain({ history: [closing("settle", [4_000_000n, won])] }), id, players), { state: "closed", how: "settled", winner: "B" });
  assert.deepEqual(await seriesOutcome(chain({ history: [closing("settle", [stake + 4_000_000n, stake])] }), id, players), { state: "closed", how: "settled", winner: null });
  assert.deepEqual(await seriesOutcome(chain({ history: [closing("cancel", [stake, 0n])] }), id, players), { state: "closed", how: "cancelled" });
  assert.deepEqual(await seriesOutcome(chain({ history: [closing("emergencyRefund", [stake, stake])] }), id, players), { state: "closed", how: "refunded" });
});
