import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { PublicKey } from "@solana/web3.js";
import {
  decodeLinkBattle,
  decodeLinkConfig,
  decodeLinkWager,
  encodeLinkConfigInit,
  encodeLinkConfigUpdate,
  encodeLinkWager,
  LINK_BATTLE_LEN,
  LINK_BATTLE_PLAYER_OFFSETS,
  LINK_CONFIG_LEN,
  LINK_WAGER_PROGRAM_IDS,
  linkBattleAddress,
  linkConfigAddress,
  linkResultMessage,
  linkTicketMessage,
  linkWagerInstruction,
  linkWagerProgram,
  type LinkResult,
  type LinkTicket,
} from "../src/link-codec.ts";

// Link battles' practice-stake program's byte formats, against test/fixtures/link-codec.json, which the program's own
// tests check byte for byte (programs/link-wager/tests/codec.rs): if this codec and the Rust ever disagree, one fails.

const f = JSON.parse(readFileSync(new URL("./fixtures/link-codec.json", import.meta.url), "utf8"));
const program = new PublicKey(f.program);
const ticket: LinkTicket = { battleId: f.ticket.battleId, playerA: f.ticket.playerA, playerB: f.ticket.playerB, stake: BigInt(f.ticket.stake), acceptDeadline: f.ticket.acceptDeadline, expiry: f.ticket.expiry, keyId: f.ticket.keyId };
const result: LinkResult = { battleId: f.result.battleId, playerA: f.result.playerA, playerB: f.result.playerB, outcome: f.result.outcome, keyId: f.result.keyId };
const hex = (b: Buffer) => b.toString("hex");

test("the program isn't deployed anywhere yet, so staking on link battles has no address to use", () => {
  assert.deepEqual(LINK_WAGER_PROGRAM_IDS, { devnet: null, mainnet: null });
  assert.equal(linkWagerProgram("devnet"), null);
});

test("addresses, the ticket's message and the result's are the fixture's", () => {
  assert.equal(linkConfigAddress(program).toBase58(), f.configAddress);
  assert.equal(linkBattleAddress(program, ticket.battleId).toBase58(), f.battleAddress);
  assert.equal(hex(linkTicketMessage(program, ticket)), f.ticket.message);
  assert.equal(hex(linkResultMessage(program, result)), f.result.message);
  // A ticket and a result for the same battle are never the same bytes, and neither is The Line's ticket.
  assert.notEqual(f.ticket.message.slice(0, 44), f.result.message.slice(0, 44));
  assert.equal(Buffer.from(f.ticket.message, "hex").subarray(0, 22).toString(), "highwire-link-ticket-1");
  assert.equal(Buffer.from(f.result.message, "hex").subarray(0, 22).toString(), "highwire-link-result-1");
  assert.throws(() => linkBattleAddress(program, "AB".repeat(32)), /lowercase hex/);
});

test("every instruction encodes as the fixture has it, and decodes back", () => {
  const i = f.instructions;
  const init = { ...f.init, tiers: f.init.tiers.map(BigInt), maxStake: BigInt(f.init.maxStake), openStakeCap: BigInt(f.init.openStakeCap) };
  assert.equal(hex(encodeLinkConfigInit(init)), i.initConfig);
  assert.equal(hex(encodeLinkConfigUpdate({})), i.updateConfigNone);
  assert.equal(hex(encodeLinkWager({ kind: "open", ticket })), i.open);
  assert.equal(hex(encodeLinkWager({ kind: "accept" })), i.accept);
  assert.equal(hex(encodeLinkWager({ kind: "cancel" })), i.cancel);
  assert.equal(hex(encodeLinkWager({ kind: "settle", outcome: "b", keyId: 9 })), i.settle);
  assert.equal(hex(encodeLinkWager({ kind: "refund" })), i.refund);
  const open = decodeLinkWager(Buffer.from(i.open, "hex"));
  assert.deepEqual(open, { kind: "open", battleId: ticket.battleId, playerB: ticket.playerB, stake: ticket.stake, acceptDeadline: ticket.acceptDeadline, expiry: ticket.expiry, keyId: ticket.keyId });
  assert.deepEqual(decodeLinkWager(Buffer.from(i.settle, "hex")), { kind: "settle", outcome: "b", keyId: 9 });
  for (const kind of ["accept", "cancel", "refund", "freezeAndRefund"] as const) assert.deepEqual(decodeLinkWager(Buffer.from(i[kind], "hex")), { kind });
  // Anything that isn't exactly an instruction: an unknown tag, trailing bytes, an outcome the program doesn't know.
  assert.equal(decodeLinkWager(Buffer.from([99])), null);
  assert.equal(decodeLinkWager(Buffer.from(`${i.accept}00`, "hex")), null);
  assert.equal(decodeLinkWager(Buffer.from(`${i.open}00`, "hex")), null);
  assert.equal(decodeLinkWager(Buffer.from([5, 4, 9, 0])), null);
  assert.throws(() => encodeLinkConfigInit({ ...init, tiers: [1n, 2n, 3n, 4n, 5n] }), /four tiers/);
});

test("both accounts decode from the bytes the program writes", () => {
  const config = Buffer.from(f.accounts.config, "hex");
  assert.equal(config.length, LINK_CONFIG_LEN);
  assert.deepEqual(decodeLinkConfig(config), {
    authority: f.init.authority,
    ticketKey: f.init.ticketKey,
    ticketKeyId: 7,
    resultKey: f.init.resultKey,
    resultKeyId: 9,
    paused: true,
    tiers: [100_000_000n, 250_000_000n],
    maxStake: 250_000_000n,
    openStakeCap: 10_000_000_000n,
    openStake: 200_000_000n,
    refundAfterSeconds: 21_600,
  });
  const battle = Buffer.from(f.accounts.battle, "hex");
  assert.equal(battle.length, LINK_BATTLE_LEN);
  assert.deepEqual(decodeLinkBattle(battle), { status: "live", battleId: ticket.battleId, playerA: ticket.playerA, playerB: ticket.playerB, stake: ticket.stake, ticketKeyId: 7, acceptDeadline: ticket.acceptDeadline, ticketExpiry: ticket.expiry, openedAt: 1_800_000_010, liveAt: 1_800_000_020 });
  // The wallets sit where the filters look for them.
  assert.equal(new PublicKey(battle.subarray(LINK_BATTLE_PLAYER_OFFSETS.A, LINK_BATTLE_PLAYER_OFFSETS.A + 32)).toBase58(), ticket.playerA);
  assert.equal(new PublicKey(battle.subarray(LINK_BATTLE_PLAYER_OFFSETS.B, LINK_BATTLE_PLAYER_OFFSETS.B + 32)).toBase58(), ticket.playerB);
  assert.throws(() => decodeLinkBattle(battle.subarray(0, 100)), /shorter/);
  assert.throws(() => decodeLinkConfig(Buffer.concat([Buffer.from([2]), config.subarray(1)])), /version-1/);
});

test("each instruction lists its accounts in the program's order", () => {
  const a = new PublicKey(ticket.playerA), b = new PublicKey(ticket.playerB);
  const config = linkConfigAddress(program).toBase58(), battle = linkBattleAddress(program, ticket.battleId).toBase58();
  const keys = (ix: ReturnType<typeof linkWagerInstruction>) => ix.keys.map((k) => `${k.pubkey.toBase58()}${k.isSigner ? ":s" : ""}${k.isWritable ? ":w" : ""}`);
  const sysvar = "Sysvar1nstructions1111111111111111111111111", system = "11111111111111111111111111111111", burn = "1nc1nerator11111111111111111111111111111111:w";
  assert.deepEqual(keys(linkWagerInstruction(program, a, ticket.battleId, { kind: "open", ticket })), [`${a.toBase58()}:s:w`, `${config}:w`, `${battle}:w`, sysvar, system]);
  assert.deepEqual(keys(linkWagerInstruction(program, b, ticket.battleId, { kind: "accept" })), [`${b.toBase58()}:s:w`, `${config}:w`, `${battle}:w`, sysvar, system]);
  assert.deepEqual(keys(linkWagerInstruction(program, a, ticket.battleId, { kind: "cancel" }, { playerA: a, playerB: b })), [`${a.toBase58()}:s`, `${config}:w`, `${battle}:w`, `${a.toBase58()}:w`, burn]);
  assert.deepEqual(keys(linkWagerInstruction(program, a, ticket.battleId, { kind: "settle", outcome: "a", keyId: 9 }, { playerA: a, playerB: b })), [`${battle}:w`, `${config}:w`, `${a.toBase58()}:w`, `${b.toBase58()}:w`, sysvar, burn]);
  assert.deepEqual(keys(linkWagerInstruction(program, a, ticket.battleId, { kind: "refund" }, { playerA: a, playerB: b })), [`${battle}:w`, `${config}:w`, `${a.toBase58()}:w`, `${b.toBase58()}:w`, burn]);
  // A payee the runtime won't credit is passed read-only; the program burns its share.
  assert.deepEqual(keys(linkWagerInstruction(program, a, ticket.battleId, { kind: "refund" }, { playerA: a, playerB: b }, [b]))[3], b.toBase58());
  assert.throws(() => linkWagerInstruction(program, a, ticket.battleId, { kind: "settle", outcome: "a", keyId: 9 }), /two players/);
});
