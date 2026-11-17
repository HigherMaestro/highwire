import { writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { PublicKey } from "@solana/web3.js";
import { encodeLinkConfigInit, encodeLinkConfigUpdate, encodeLinkWager, LINK_WAGER_TAGS, linkBattleAddress, linkConfigAddress, linkResultMessage, linkTicketMessage, type LinkConfigInit, type LinkResult, type LinkTicket } from "../src/link-codec.ts";

// Writes test/fixtures/link-codec.json: the link-wager program's byte formats for fixed inputs, as highwire-wager
// encodes them. The package's tests check the codec against it, and the program's own tests (programs/link-wager/
// tests/codec.rs) check that the Rust encodes the same bytes, so neither side can drift. Run it only when the format
// changes, and commit the result:
//   npm run link-codec-fixture -w highwire-wager

const k = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const program = new PublicKey(Buffer.alloc(32, 0x50));
const battleId = "ab".repeat(32);
const ticket: LinkTicket = { battleId, playerA: k(1), playerB: k(2), stake: 100_000_000n, acceptDeadline: 1_800_000_300, expiry: 1_800_000_600, keyId: 7 };
const result: LinkResult = { battleId, playerA: k(1), playerB: k(2), outcome: "b", keyId: 9 };
const init: LinkConfigInit = { authority: k(3), ticketKey: k(4), ticketKeyId: 7, resultKey: k(5), resultKeyId: 9, tiers: [100_000_000n, 250_000_000n], maxStake: 250_000_000n, openStakeCap: 10_000_000_000n, refundAfterSeconds: 21_600 };

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const key = (s: string) => new PublicKey(s).toBuffer();

// The accounts, laid out by hand as state.rs has them: the Rust test checks Borsh writes exactly these.
const config = Buffer.concat([
  Buffer.from([1]), key(init.authority), key(init.ticketKey), u16(init.ticketKeyId), key(init.resultKey), u16(init.resultKeyId), Buffer.from([1]),
  u64(100_000_000n), u64(250_000_000n), u64(0n), u64(0n), u64(init.maxStake), u64(init.openStakeCap), u64(200_000_000n), u32(init.refundAfterSeconds),
]);
const battle = Buffer.concat([Buffer.from([1, 2]), Buffer.from(battleId, "hex"), key(ticket.playerA), key(ticket.playerB), u64(ticket.stake), u16(ticket.keyId), i64(ticket.acceptDeadline), i64(ticket.expiry), i64(1_800_000_010), i64(1_800_000_020), i64(1_800_003_620)]);

const out = {
  note: "Written by packages/wager/scripts/link-codec-fixture.ts. Checked by packages/wager/test/link-codec.test.ts and programs/link-wager/tests/codec.rs.",
  program: program.toBase58(),
  configAddress: linkConfigAddress(program).toBase58(),
  battleAddress: linkBattleAddress(program, battleId).toBase58(),
  ticket: { ...ticket, stake: ticket.stake.toString(), message: linkTicketMessage(program, ticket).toString("hex") },
  result: { ...result, outcomeByte: 1, message: linkResultMessage(program, result).toString("hex") },
  init: { ...init, tiers: init.tiers.map(String), maxStake: init.maxStake.toString(), openStakeCap: init.openStakeCap.toString() },
  instructions: {
    initConfig: encodeLinkConfigInit(init).toString("hex"),
    // One update with every field set, one with none.
    updateConfigAll: encodeLinkConfigUpdate({ authority: k(6), ticketKey: { key: k(4), id: 8 }, resultKey: { key: k(5), id: 10 }, paused: true, tiers: [100_000_000n], maxStake: 100_000_000n, openStakeCap: 1_000_000_000n, refundAfterSeconds: 3_600 }).toString("hex"),
    updateConfigNone: encodeLinkConfigUpdate({}).toString("hex"),
    open: encodeLinkWager({ kind: "open", ticket }).toString("hex"),
    accept: encodeLinkWager({ kind: "accept" }).toString("hex"),
    cancel: encodeLinkWager({ kind: "cancel" }).toString("hex"),
    settle: encodeLinkWager({ kind: "settle", outcome: "b", keyId: 9 }).toString("hex"),
    refund: encodeLinkWager({ kind: "refund" }).toString("hex"),
    freezeAndRefund: Buffer.from([LINK_WAGER_TAGS.freezeAndRefund]).toString("hex"),
  },
  accounts: { config: config.toString("hex"), battle: battle.toString("hex") },
};
writeFileSync(new URL("../test/fixtures/link-codec.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log("wrote test/fixtures/link-codec.json");
