// Writes programs/line-wager/tests/fixtures/ts-instructions.json: wager transactions built by highwire-core's own
// codec (src/tx/wager-codec.ts), for the program's tests (tests/ts_built.rs) to run against the real program. Keys come
// from fixed seeds the Rust side derives the same way, so it can sign for them. Four series: one played a round, then
// retired and settled; one opened and cancelled; one left idle a day and refunded; one frozen and refunded by the
// config authority mid-round, between a pause and an unpause (the maintainer's wager-admin builds these two).
//
// usage: npm run wager-fixtures -w highwire-core (it runs this too)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { fallbackCommitment, moveCommitment, sideOf } from "highwire-core/arena";
import { configUpdateInstruction, freezeAndRefundInstruction, pauseInstruction, ticketCheck, ticketMessage, wagerInstruction, WAGER_PROGRAM_IDS, type WagerParties, type WagerTicket } from "../src/codec.ts";

const out = join(dirname(fileURLToPath(import.meta.url)), "../../../programs/line-wager/tests/fixtures/ts-instructions.json");

const seed = (n: number) => new Uint8Array(32).fill(n);
const keys = { A: Keypair.fromSeed(seed(1)), B: Keypair.fromSeed(seed(2)), fee: Keypair.fromSeed(seed(3)), crank: Keypair.fromSeed(seed(4)), authority: Keypair.fromSeed(seed(5)) };
const ticketKey = seed(7);
const program = new PublicKey(WAGER_PROGRAM_IDS.devnet!);
const T0 = 1_800_000_000;
const STAKE = 100_000_000n;
const parties: WagerParties = { playerA: keys.A.publicKey, playerB: keys.B.publicKey, feeAccount: keys.fee.publicKey };

type Signer = keyof typeof keys;
interface Step {
  label: string;
  at: number;
  signers: Signer[];
  instructions: { programId: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }[];
}
const steps: Step[] = [];
const step = (label: string, at: number, signers: Signer[], ixs: TransactionInstruction[]) =>
  steps.push({
    label,
    at,
    signers,
    instructions: ixs.map((ix) => ({ programId: ix.programId.toBase58(), keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data).toString("hex") })),
  });

const ticketFor = (seriesId: string): WagerTicket => ({ seriesId, playerA: keys.A.publicKey.toBase58(), playerB: keys.B.publicKey.toBase58(), stake: STAKE, acceptDeadline: T0 + 300, expiry: T0 + 600, keyId: 1 });
const signed = (t: WagerTicket) => ticketCheck(program, t, new PublicKey(ed25519.getPublicKey(ticketKey)), ed25519.sign(ticketMessage(program, t), ticketKey));
const salt = "33".repeat(32);

function openAndAccept(seriesId: string, at: number) {
  const t = ticketFor(seriesId);
  step(`open ${seriesId.slice(0, 4)}`, at, ["A"], [signed(t), wagerInstruction(program, keys.A.publicKey, seriesId, { kind: "open", ticket: t, fallbackHash: fallbackCommitment(seriesId, "A", { kind: "zero" }, salt) })]);
  return t;
}
function accept(t: WagerTicket, at: number) {
  step(`accept ${t.seriesId.slice(0, 4)}`, at, ["B"], [signed(t), wagerInstruction(program, keys.B.publicKey, t.seriesId, { kind: "accept", fallbackHash: fallbackCommitment(t.seriesId, "B", { kind: "steady", pull: 2 }, salt) })]);
}

// Series 1: a round played, then A retires; anyone settles.
const s1 = "55".repeat(32);
accept(openAndAccept(s1, T0), T0);
const pulls = { A: 4, B: 1 };
const nonce = { A: "aa".repeat(32), B: "bb".repeat(32) };
for (const p of ["A", "B"] as const) {
  const hash = moveCommitment(s1, 0, 1, sideOf(p, 0), pulls[p], nonce[p]);
  step(`commit ${p}`, T0 + 5, [p], [wagerInstruction(program, keys[p].publicKey, s1, { kind: "commit", round: 1, hash })]);
}
for (const p of ["A", "B"] as const) step(`reveal ${p}`, T0 + 6, [p], [wagerInstruction(program, keys[p].publicKey, s1, { kind: "reveal", pull: pulls[p], nonce: nonce[p] })]);
step("retire A", T0 + 7, ["A"], [wagerInstruction(program, keys.A.publicKey, s1, { kind: "retire" })]);
step("settle", T0 + 8, [], [wagerInstruction(program, keys.crank.publicKey, s1, { kind: "settle" }, parties)]);

// Series 2: opened, never accepted, cancelled by A.
const s2 = "66".repeat(32);
openAndAccept(s2, T0);
step("cancel", T0 + 9, ["A"], [wagerInstruction(program, keys.A.publicKey, s2, { kind: "cancel" }, parties)]);

// Series 3: both stake, B misses round 1's commit, A's fallback-free commit times B out; then a day idle and refunded.
const s3 = "77".repeat(32);
accept(openAndAccept(s3, T0), T0);
step("commit A", T0 + 1, ["A"], [wagerInstruction(program, keys.A.publicKey, s3, { kind: "commit", round: 1, hash: moveCommitment(s3, 0, 1, "a", 2, nonce.A) })]);
step("timeout", T0 + 121, [], [wagerInstruction(program, keys.crank.publicKey, s3, { kind: "timeout" })]);
step("reveal fallback B", T0 + 122, ["B"], [wagerInstruction(program, keys.B.publicKey, s3, { kind: "revealFallback", fallback: { kind: "steady", pull: 2 }, salt })]);
step("emergency refund", T0 + 122 + 86_400, [], [wagerInstruction(program, keys.crank.publicKey, s3, { kind: "emergencyRefund" }, parties)]);

// Series 4: both stake, A commits round 1; the authority pauses new series, freezes this one (both stakes back in
// full), and unpauses.
const s4 = "88".repeat(32);
accept(openAndAccept(s4, T0), T0);
step("commit A (4)", T0 + 1, ["A"], [wagerInstruction(program, keys.A.publicKey, s4, { kind: "commit", round: 1, hash: moveCommitment(s4, 0, 1, "a", 3, nonce.A) })]);
step("pause", T0 + 2, ["authority"], [pauseInstruction(program, keys.authority.publicKey, true)]);
step("freeze and refund", T0 + 3, ["authority"], [freezeAndRefundInstruction(program, keys.authority.publicKey, s4, parties)]);
step("unpause", T0 + 4, ["authority"], [pauseInstruction(program, keys.authority.publicKey, false)]);
// Then every other setting at once, as wager-admin sets them: the authority (handed to itself), a new ticket key, the fee
// and its account, the tiers and both caps. ts_built.rs reads the config back.
step("update the config", T0 + 5, ["authority"], [
  configUpdateInstruction(program, keys.authority.publicKey, {
    authority: keys.authority.publicKey,
    ticketKey: { key: new PublicKey(ed25519.getPublicKey(seed(9))), id: 2 },
    feeBps: 300,
    feeAccount: keys.crank.publicKey,
    tiers: [10_000_000n, STAKE],
    maxStake: 500_000_000n,
    openStakeCap: 5_000_000_000n,
  }),
]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ program: program.toBase58(), t0: T0, stake: STAKE.toString(), ticketKey: new PublicKey(ed25519.getPublicKey(ticketKey)).toBase58(), feeAccount: keys.fee.publicKey.toBase58(), steps }, null, 1));
console.log(`wrote ${steps.length} transactions built by the TypeScript codec`);
