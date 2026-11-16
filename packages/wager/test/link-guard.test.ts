import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { ed25519 } from "@noble/curves/ed25519";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { assertSafe, describeTransaction, PROGRAMS } from "highwire-core";
import { ticketCheck, ticketMessage, WAGER_PROGRAM_IDS } from "../src/codec.ts";
import { wagerGuard } from "../src/guard.ts";
import { LINK_WAGER_TAGS, linkBattleAddress, linkConfigAddress, linkResultMessage, linkSignedCheck, linkTicketMessage, linkWagerInstruction, type LinkResult, type LinkTicket } from "../src/link-codec.ts";
import { linkWagerFacts, linkWagerGuard, type LinkWagerExpectation } from "../src/link-guard.ts";
import { linkClosingEvent } from "../src/link-tx.ts";

// Link battles' practice-stake program's safety checks, attacked: hand-made transactions, each of which must be
// refused. A stake or a settle is allowed only to a caller that expects exactly it; everyone else (the sign page, the
// build tools, a guard with no expectation) refuses every instruction of the program and every Ed25519 check.

const wallet = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;
const attacker = Keypair.generate().publicKey;
const program = new PublicKey(new Uint8Array(32).fill(0x50));
const memo = new TransactionInstruction({ programId: new PublicKey(PROGRAMS.memo), keys: [], data: Buffer.from("highwire") });
const txBy = (payer: PublicKey, ...ixs: TransactionInstruction[]) => new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: [...ixs, memo] }).compileToV0Message());
const tx = (...ixs: TransactionInstruction[]) => txBy(wallet, ...ixs);

const deskSecret = new Uint8Array(32).fill(7);
const refSecret = new Uint8Array(32).fill(9);
const ticketKey = new PublicKey(ed25519.getPublicKey(deskSecret));
const resultKey = new PublicKey(ed25519.getPublicKey(refSecret));
const battleId = "55".repeat(32);
const ticket: LinkTicket = { battleId, playerA: wallet.toBase58(), playerB: other.toBase58(), stake: 100_000_000n, acceptDeadline: 1_300, expiry: 1_600, keyId: 1 };
const result: LinkResult = { battleId, playerA: wallet.toBase58(), playerB: other.toBase58(), outcome: "a", keyId: 1 };
const parties = { playerA: wallet, playerB: other };

const ticketIx = (t = ticket, secret = deskSecret) => linkSignedCheck(linkTicketMessage(program, t), new PublicKey(ed25519.getPublicKey(secret)), ed25519.sign(linkTicketMessage(program, t), secret));
const resultIx = (r = result, secret = refSecret) => linkSignedCheck(linkResultMessage(program, r), new PublicKey(ed25519.getPublicKey(secret)), ed25519.sign(linkResultMessage(program, r), secret));
const open = (t = ticket, signer = wallet) => linkWagerInstruction(program, signer, t.battleId, { kind: "open", ticket: t });
const settle = (r = result, p = parties) => linkWagerInstruction(program, wallet, r.battleId, { kind: "settle", outcome: r.outcome, keyId: r.keyId }, p);

const expectOpen: LinkWagerExpectation = { kind: "open", battleId, ticket, ticketKey };
const expectSettle: LinkWagerExpectation = { kind: "settle", battleId, result, resultKey };
type Expect = LinkWagerExpectation | "unexpected" | "unguarded";
const ok = (t: VersionedTransaction, exp: Expect, w = wallet) =>
  assertSafe(t, "devnet", { wallet: w, allowLaunchLab: false, allowCpmm: false, guards: exp === "unguarded" ? [] : [linkWagerGuard(program, exp === "unexpected" ? undefined : exp)] });
const no = (t: VersionedTransaction, why: RegExp, exp: Expect, w = wallet) => assert.throws(() => ok(t, exp, w), why);

test("a stake: only the expected one, with exactly its ticket just before it", () => {
  ok(tx(ticketIx(), open()), expectOpen);
  assert.ok(describeTransaction(tx(ticketIx(), open()), "devnet", [], [linkWagerGuard(program)]).instructions.some((i) => i.known && /Stake 0.1 SOL on a link battle against/.test(i.text)));
  // A guard keeps no count between transactions.
  ok(tx(ticketIx(), open()), expectOpen);
  // Nobody who doesn't expect it takes it: no guard at all (the sign page), or a guard with no expectation.
  no(tx(ticketIx(), open()), /outside the allow-list|only a link battle's stake or settle carries/, "unguarded");
  no(tx(ticketIx(), open()), /only a link battle's stake or settle carries|only the local signer's stakes make/, "unexpected");
  no(tx(open()), /only the local signer's stakes make/, "unexpected");
  // No ticket, a ticket by another key, another battle's ticket, a smaller ticket for a larger stake.
  no(tx(open()), /without its ticket check just before it/, expectOpen);
  no(tx(ticketIx(ticket, new Uint8Array(32).fill(8)), open()), /isn't signed by the desk's key/, expectOpen);
  no(tx(ticketIx({ ...ticket, battleId: "66".repeat(32) }), open()), /isn't this battle's ticket/, expectOpen);
  no(tx(ticketIx(), open({ ...ticket, stake: 250_000_000n })), /doesn't match its ticket/, expectOpen);
  // The ticket check not immediately before the stake, or twice.
  no(tx(ticketIx(), memo, open()), /isn't immediately before/, expectOpen);
  no(tx(ticketIx(), ticketIx(), open()), /isn't immediately before|more than one signature check/, expectOpen);
  // The stake twice, or for another battle than expected.
  no(tx(ticketIx(), open(), open()), /more than one link-wager instruction/, expectOpen);
  no(tx(ticketIx(), open()), /battle account isn't the expected one|is for another battle/, { ...expectOpen, battleId: "66".repeat(32) });
  // A ticket that pairs other wallets, or this wallet against itself.
  const theirs = { ...ticket, playerA: attacker.toBase58() };
  no(tx(ticketIx(theirs), open(theirs)), /isn't for this wallet against another/, { ...expectOpen, ticket: theirs });
  // An extra account smuggled in.
  const padded = open();
  padded.keys.push({ pubkey: attacker, isSigner: false, isWritable: true });
  no(tx(ticketIx(), padded), /unexpected accounts/, expectOpen);
  // The Line's ticket can't stand in for this one, nor the referee's result.
  const line = new PublicKey(WAGER_PROGRAM_IDS.devnet!);
  const lineTicket = { seriesId: battleId, playerA: ticket.playerA, playerB: ticket.playerB, stake: ticket.stake, acceptDeadline: ticket.acceptDeadline, expiry: ticket.expiry, keyId: 1 };
  no(tx(ticketCheck(line, lineTicket, ticketKey, ed25519.sign(ticketMessage(line, lineTicket), deskSecret)), open()), /isn't this battle's ticket/, expectOpen);
  no(tx(resultIx(result, deskSecret), open()), /isn't this battle's ticket/, expectOpen);
  // And The Line's own guard doesn't take this program's instructions.
  assert.throws(() => assertSafe(tx(ticketIx(), open()), "devnet", { wallet, allowLaunchLab: false, allowCpmm: false, guards: [wagerGuard()] }), /Ed25519 check|outside the allow-list/);
});

test("an accept is for the wallet the ticket names as B", () => {
  const accept = linkWagerInstruction(program, other, battleId, { kind: "accept" });
  const exp: LinkWagerExpectation = { kind: "accept", battleId, ticket, ticketKey };
  ok(txBy(other, ticketIx(), accept), exp, other);
  // A tries to accept its own battle.
  const mine = linkWagerInstruction(program, wallet, battleId, { kind: "accept" });
  no(tx(ticketIx(), mine), /isn't for this wallet to accept/, exp);
  no(txBy(other, accept), /without its ticket check/, exp, other);
});

test("a settle: only the expected one, with exactly the referee's result just before it", () => {
  ok(tx(resultIx(), settle()), expectSettle);
  assert.ok(describeTransaction(tx(resultIx(), settle()), "devnet", [], [linkWagerGuard(program)]).instructions.some((i) => i.known && /on the referee's result: paying player A both stakes/.test(i.text)));
  no(tx(resultIx(), settle()), /outside the allow-list|only a link battle's stake or settle carries/, "unguarded");
  no(tx(settle()), /without its result check just before it/, expectSettle);
  // A result by another key (the desk's included), for another battle, or another outcome than expected.
  no(tx(resultIx(result, deskSecret), settle()), /isn't signed by the referee's key/, expectSettle);
  no(tx(resultIx({ ...result, battleId: "66".repeat(32) }), settle()), /isn't this battle's result/, expectSettle);
  no(tx(resultIx({ ...result, outcome: "b" }), settle({ ...result, outcome: "b" })), /isn't this battle's result/, expectSettle);
  // The signed result says A; the instruction says B.
  no(tx(resultIx(), settle({ ...result, outcome: "b" })), /doesn't match its result/, expectSettle);
  // The right result, paid to someone else.
  no(tx(resultIx(), settle(result, { playerA: attacker, playerB: other })), /names other players than its result/, expectSettle);
  // The desk's ticket can't stand in for a result.
  no(tx(ticketIx(), settle()), /isn't signed by the referee's key/, expectSettle);
  // A signature check takes no accounts of its own.
  const check = resultIx();
  const withAccount = new TransactionInstruction({ programId: check.programId, keys: [{ pubkey: attacker, isSigner: false, isWritable: true }], data: check.data });
  no(tx(withAccount, settle()), /an Ed25519 check takes no accounts/, expectSettle);
});

test("a cancel and a refund carry no signature check, and exactly their accounts", () => {
  const cancel = linkWagerInstruction(program, wallet, battleId, { kind: "cancel" }, parties);
  const refund = linkWagerInstruction(program, wallet, battleId, { kind: "refund" }, parties);
  ok(tx(cancel), { kind: "cancel", battleId, parties });
  ok(tx(refund), { kind: "refund", battleId, parties });
  no(tx(refund), /not the link-wager instruction this flow builds/, { kind: "cancel", battleId, parties });
  no(tx(ticketIx(), cancel), /only a link battle's stake or settle carries/, { kind: "cancel", battleId, parties });
  // The payees are the battle's own two wallets, in their places: nothing else is taken, even though the program
  // would refuse it too (a refused transaction still costs its fee).
  const swapped = { playerA: attacker, playerB: other };
  no(tx(linkWagerInstruction(program, wallet, battleId, { kind: "cancel" }, swapped)), /opener's wallet isn't the expected one/, { kind: "cancel", battleId, parties });
  no(tx(linkWagerInstruction(program, wallet, battleId, { kind: "refund" }, swapped)), /opener's wallet isn't the expected one/, { kind: "refund", battleId, parties });
  no(tx(linkWagerInstruction(program, wallet, battleId, { kind: "refund" }, { playerA: wallet, playerB: attacker })), /second wallet isn't the expected one/, { kind: "refund", battleId, parties });
  no(tx(cancel), /without the battle's wallets/, { kind: "cancel", battleId });
  no(tx(refund), /without the battle's wallets/, { kind: "refund", battleId });
  // The authority's instructions are never a player's.
  const freeze = new TransactionInstruction({ programId: program, keys: [{ pubkey: wallet, isSigner: true, isWritable: false }, { pubkey: linkConfigAddress(program), isSigner: false, isWritable: true }, { pubkey: linkBattleAddress(program, battleId), isSigner: false, isWritable: true }], data: Buffer.from([LINK_WAGER_TAGS.freezeAndRefund]) });
  no(tx(freeze), /not the link-wager instruction this flow builds/, { kind: "refund", battleId, parties });
});

test("what a stake's envelope does is read from its bytes", () => {
  const env = (t: VersionedTransaction) => ({ transactions: [{ base64: Buffer.from(t.serialize()).toString("base64") }] }) as never;
  assert.deepEqual(linkWagerFacts(env(tx(ticketIx(), open())), program), { kind: "open", battle: linkBattleAddress(program, battleId).toBase58(), stake: 100_000_000n });
  assert.deepEqual(linkWagerFacts(env(tx(resultIx(), settle())), program), { kind: "settle", battle: linkBattleAddress(program, battleId).toBase58() });
  assert.equal(linkWagerFacts(env(tx(memo)), program), null, "not one of this program's");
  assert.throws(() => linkWagerFacts(env(tx(ticketIx(), open(), open())), program), /more than one/);
  // An accept names no amount of its own: it's the ticket's, in the check just before it, which the program requires
  // to be the battle's own ticket. Never an RPC's word.
  const accept = linkWagerInstruction(program, other, battleId, { kind: "accept" });
  assert.deepEqual(linkWagerFacts(env(txBy(other, ticketIx(), accept)), program), { kind: "accept", battle: linkBattleAddress(program, battleId).toBase58(), stake: 100_000_000n });
  assert.deepEqual(linkWagerFacts(env(txBy(other, ticketIx({ ...ticket, stake: 250_000_000n }), accept)), program)?.stake, 250_000_000n);
  assert.throws(() => linkWagerFacts(env(txBy(other, accept)), program), /without its ticket just before it/);
  assert.throws(() => linkWagerFacts(env(txBy(other, resultIx(), accept)), program), /without its ticket just before it/, "a result is no ticket");
  assert.throws(() => linkWagerFacts(env(txBy(other, ticketIx(), memo, accept)), program), /without its ticket just before it/);
});

test("a closed battle's outcome is the program's own closing event for it, and nothing else", () => {
  const P = program.toBase58();
  const b64 = (b: Uint8Array | string) => Buffer.from(b).toString("base64");
  const data = (kind: number, battle: string, outcome: number) => `Program data: ${b64("link-wager")} ${b64(Uint8Array.of(kind))} ${b64(Buffer.from(battle, "hex"))} ${b64(Uint8Array.of(outcome))}`;
  const frame = (prog: string, inner: string[], depth = 1) => [`Program ${prog} invoke [${depth}]`, ...inner, `Program ${prog} success`];
  const evil = "Evi1Program11111111111111111111111111111111";
  assert.deepEqual(linkClosingEvent(frame(P, [data(1, battleId, 1)]), P, battleId), { how: "settled", outcome: "b" });
  assert.deepEqual(linkClosingEvent(frame(P, [data(1, battleId, 3)]), P, battleId), { how: "settled", outcome: "void" });
  assert.deepEqual(linkClosingEvent(frame(P, [data(2, battleId, 255)]), P, battleId), { how: "cancelled" });
  assert.deepEqual(linkClosingEvent(frame(P, [data(3, battleId, 255)]), P, battleId), { how: "refunded" });
  // Forged by another program, after the program's frame closed, for another battle, or The Line's event: ignored.
  assert.equal(linkClosingEvent(frame(evil, [data(1, battleId, 0)]), P, battleId), null);
  assert.equal(linkClosingEvent([...frame(P, []), data(1, battleId, 0)], P, battleId), null);
  assert.equal(linkClosingEvent(frame(P, [data(1, "66".repeat(32), 0)]), P, battleId), null);
  assert.equal(linkClosingEvent(frame(P, [data(1, battleId, 0).replace(b64("link-wager"), b64("line-wager"))]), P, battleId), null);
  assert.equal(linkClosingEvent(["Log truncated", ...frame(P, [data(1, battleId, 0)])], P, battleId), null);
});
