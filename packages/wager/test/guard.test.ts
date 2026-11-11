import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { assertSafe, describeTransaction, PROGRAMS } from "highwire-core";
import { ticketCheck, ticketMessage, WAGER_PROGRAM_IDS, WAGER_TAGS, wagerInstruction } from "../src/codec.ts";
import { wagerGuard, type WagerExpectation } from "../src/guard.ts";

// The wager program's safety checks, attacked: hand-made transactions, each of which must be refused. These were in
// highwire-core's attacks.test.ts while the checks lived in decode.ts; the checks are the guard's now, and the refusals
// are the same, word for word.

const wallet = Keypair.generate().publicKey;
const attacker = Keypair.generate().publicKey;
const memo = new TransactionInstruction({ programId: new PublicKey(PROGRAMS.memo), keys: [], data: Buffer.from("highwire") });
const tx = (...ixs: TransactionInstruction[]) =>
  new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: PublicKey.default.toBase58(), instructions: [...ixs, memo] }).compileToV0Message());
const meta = (pubkey: PublicKey, isWritable = true) => ({ pubkey, isSigner: false, isWritable });

test("wagers: only the local signer's, exactly as expected; refused by anyone without the guard's expectation", async () => {
  const program = new PublicKey(WAGER_PROGRAM_IDS.devnet!);
  const secret = new Uint8Array(32).fill(7);
  const ticketKey = new PublicKey(ed25519.getPublicKey(secret));
  const ticket = { seriesId: "55".repeat(32), playerA: wallet.toBase58(), playerB: attacker.toBase58(), stake: 100_000_000n, acceptDeadline: 1_300, expiry: 1_600, keyId: 1 };
  const check = (t = ticket, key = secret) => ticketCheck(program, t, new PublicKey(ed25519.getPublicKey(key)), ed25519.sign(ticketMessage(program, t), key));
  const open = (t = ticket, signer = wallet) => wagerInstruction(program, signer, t.seriesId, { kind: "open", ticket: t, fallbackHash: "44".repeat(32) });
  const expectOpen: WagerExpectation = { kind: "open", seriesId: ticket.seriesId, ticket, ticketKey };
  // "unexpected" is a caller with the guard but no expectation; "unguarded" is one with no guard at all (the sign page).
  type Expect = WagerExpectation | "unexpected" | "unguarded";
  const ok = (t: VersionedTransaction, exp: Expect = expectOpen) =>
    assertSafe(t, "devnet", { wallet, allowLaunchLab: false, allowCpmm: false, guards: exp === "unguarded" ? [] : [wagerGuard(exp === "unexpected" ? undefined : exp)] });
  const no = (t: VersionedTransaction, why: RegExp, exp: Expect = expectOpen) => assert.throws(() => ok(t, exp), why);

  ok(tx(check(), open()));
  assert.ok(describeTransaction(tx(check(), open()), "devnet", [], [wagerGuard()]).instructions.some((i) => i.known && /Stake 0.1 SOL and open a best-of-5 wager series/.test(i.text)));
  // The same checks run again from scratch on the same expectations: a guard keeps no count between transactions.
  const twice = { wallet, allowLaunchLab: false, allowCpmm: false, guards: [wagerGuard(expectOpen)] };
  assertSafe(tx(check(), open()), "devnet", twice);
  assertSafe(tx(check(), open()), "devnet", twice);
  // A caller that expects no wager refuses the ticket check and the wager alike.
  no(tx(check(), open()), /an Ed25519 check, which only a wager's open or accept carries/, "unexpected");
  no(tx(open()), /a wager on The Line, which only the local signer's wagers make/, "unexpected");
  // And one with no guard at all, as the sign page is, sees two programs outside the allow-list and nothing it can read.
  no(tx(check(), open()), /calls a program outside the allow-list/, "unguarded");
  no(tx(open()), /calls a program outside the allow-list/, "unguarded");
  assert.equal(describeTransaction(tx(check(), open()), "devnet").instructions.filter((i) => !i.known).length, 2);
  // On a cluster without the program the guard answers for nothing.
  assert.throws(() => assertSafe(tx(check(), open()), "mainnet", { wallet, guards: [wagerGuard(expectOpen)] }), /calls a program outside the allow-list/);
  // A ticket signed by another key, for another stake or series, or not immediately before the open.
  no(tx(check(ticket, new Uint8Array(32).fill(9)), open()), /isn't signed by the matchmaker's key/);
  no(tx(check({ ...ticket, stake: 1_000_000_000n }), open()), /isn't this series' ticket/);
  no(tx(check(), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), open()), /isn't immediately before the wager/);
  no(tx(open()), /without its ticket check/);
  // An open whose data disagrees with its ticket (a bigger stake than the ticket's), or for another wallet.
  no(tx(check(), open({ ...ticket, stake: 1_000_000_000n })), /doesn't match its ticket/);
  no(tx(check(), open(ticket, attacker)), /player isn't the expected one|unexpected signer/);
  // Another kind than the flow builds, two wager instructions, or another series' account.
  const retire = (id = ticket.seriesId) => wagerInstruction(program, wallet, id, { kind: "retire" });
  const expectCommit: WagerExpectation = { kind: "commit", seriesId: ticket.seriesId, commit: { match: 0, round: 1 } };
  no(tx(retire()), /not the wager instruction this flow builds/, expectCommit);
  const commit = (id = ticket.seriesId, match = 0, round = 1) => wagerInstruction(program, wallet, id, { kind: "commit", match, round, hash: "66".repeat(32) });
  ok(tx(commit()), expectCommit);
  assert.ok(describeTransaction(tx(commit(ticket.seriesId, 1, 3)), "devnet", [], [wagerGuard()]).instructions.some((i) => i.known && /Commit a hidden move for match 2, round 3 of wager series/.test(i.text)));
  // A commit names its match and round, and they must be the ones it was made for: the program takes it in no other,
  // and one naming another would stand (or be refused) where its hidden move can't be opened.
  no(tx(commit(ticket.seriesId, 1, 1)), /the commit names match 2, round 1, not the match 1, round 1 it was made for/, expectCommit);
  no(tx(commit(ticket.seriesId, 0, 2)), /the commit names match 1, round 2, not the match 1, round 1 it was made for/, expectCommit);
  no(tx(commit()), /a commit without the match and round it's for/, { kind: "commit", seriesId: ticket.seriesId });
  // A commit as it was before it named its match (the tag, the round, the hash: 34 bytes) isn't a wager instruction now.
  const oldCommit = new TransactionInstruction({ programId: program, keys: commit().keys, data: Buffer.concat([Buffer.from([WAGER_TAGS.commit, 1]), Buffer.alloc(32, 0x66)]) });
  no(tx(oldCommit), /not the wager instruction this flow builds/, expectCommit);
  assert.ok(describeTransaction(tx(oldCommit), "devnet", [], [wagerGuard()]).instructions.some((i) => !i.known && /UNKNOWN/.test(i.text)));
  no(tx(commit(), commit()), /more than one wager instruction/, expectCommit);
  no(tx(commit("77".repeat(32))), /series account isn't the expected one/, expectCommit);
  // A payout must name the incinerator as its burn account, not someone's wallet.
  const parties = { playerA: wallet, playerB: attacker, feeAccount: attacker };
  const settle = wagerInstruction(program, wallet, ticket.seriesId, { kind: "settle" }, parties);
  const expectSettle: WagerExpectation = { kind: "settle", seriesId: ticket.seriesId };
  ok(tx(settle), expectSettle);
  const swapped = new TransactionInstruction({ programId: program, keys: settle.keys.map((k, i) => (i === settle.keys.length - 1 ? meta(attacker) : k)), data: settle.data });
  no(tx(swapped), /burn account isn't the expected one/, expectSettle);
  // A payout with an extra account, or an accept of a ticket naming another wallet as B.
  const padded = new TransactionInstruction({ programId: program, keys: [...settle.keys, meta(attacker)], data: settle.data });
  no(tx(padded), /settle with unexpected accounts/, expectSettle);
  const accept = wagerInstruction(program, wallet, ticket.seriesId, { kind: "accept", fallbackHash: "44".repeat(32) });
  no(tx(check(), accept), /isn't for this wallet to accept/, { kind: "accept", seriesId: ticket.seriesId, ticket, ticketKey });
  // The admin instructions are never built, whatever the expectation says.
  const freeze = new TransactionInstruction({ programId: program, keys: [], data: Buffer.from([WAGER_TAGS.freezeAndRefund]) });
  no(tx(freeze), /Highwire never builds/, { kind: "freezeAndRefund", seriesId: ticket.seriesId });
});
