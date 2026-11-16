import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { assertSafe, describeTransaction, resolveInstructions, type Finished } from "highwire-core";
import { decodeEd25519, ED25519_PROGRAM_ID, INCINERATOR } from "../src/codec.ts";
import { decodeLinkBattle, decodeLinkConfig, decodeLinkWager, linkBattleAddress, linkConfigAddress, linkResultMessage, linkTicketMessage, type LinkResult, type LinkTicket } from "../src/link-codec.ts";
import { linkWagerFacts, linkWagerGuard } from "../src/link-guard.ts";
import { buildLinkAccept, buildLinkExit, buildLinkOpen, buildLinkSettle, linkStakesProgram, readLinkBattle, readLinkConfig } from "../src/link-tx.ts";
import { battleOf, DESK_KEY, fakeDevnet, LINK_CONFIG, LINK_PROGRAM, linkBattleBytes, linkConfigBytes, REFEREE_KEY, signResult, signTicket } from "./link-fake.ts";

// Link battles' stake transactions, built against a fake devnet: what each carries, and what each refuses to build.
// (The guard's own attacks are in link-guard.test.ts; the signer's side in link-agent.test.ts.)

const a = Keypair.generate().publicKey;
const b = Keypair.generate().publicKey;
const battleId = "5a".repeat(32);
const now = () => Math.floor(Date.now() / 1000);
const ticket = (over: Partial<LinkTicket> = {}): LinkTicket => ({ battleId, playerA: a.toBase58(), playerB: b.toBase58(), stake: 100_000_000n, acceptDeadline: now() + 300, expiry: now() + 600, keyId: 1, ...over });
const result = (over: Partial<LinkResult> = {}): LinkResult => ({ battleId, playerA: a.toBase58(), playerB: b.toBase58(), outcome: "a", keyId: 1, ...over });
const ixsOf = (f: Finished) => resolveInstructions(VersionedTransaction.deserialize(Buffer.from(f.envelope.transactions[0]!.base64, "base64")));
const ours = (f: Finished) => ixsOf(f).filter((ix) => ix.programId.equals(LINK_PROGRAM) || ix.programId.toBase58() === ED25519_PROGRAM_ID);

test("the test's account bytes are the layout the codec reads", () => {
  assert.deepEqual(decodeLinkConfig(linkConfigBytes()), LINK_CONFIG);
  const acc = battleOf(ticket(), "live", 1_700_000_000);
  assert.deepEqual(decodeLinkBattle(linkBattleBytes(acc)), acc);
});

test("nothing builds for a cluster the program isn't deployed on", async () => {
  const net = fakeDevnet();
  // The codec's table has no address yet (docs/link-wager.md 4.1), so only a program handed in, in code, builds.
  assert.throws(() => linkStakesProgram({ chain: net.chain }), /isn't deployed on devnet yet/);
  await assert.rejects(buildLinkOpen({ chain: net.chain }, { wallet: a, ...signTicket(ticket()) }), /isn't deployed on devnet yet/);
  assert.equal(net.calls.length, 0, "refused before anything is read");
  // A program with no config: not set up.
  net.accounts.clear();
  await assert.rejects(readLinkConfig({ chain: net.chain, program: LINK_PROGRAM }), /isn't set up yet/);
});

test("an open stakes exactly the ticket's amount on exactly the ticket's battle", async () => {
  const net = fakeDevnet();
  const s = { chain: net.chain, program: LINK_PROGRAM };
  const t = ticket();
  const built = await buildLinkOpen(s, { wallet: a, ...signTicket(t) });
  assert.equal(built.stake, 100_000_000n);
  assert.equal(built.envelope.kind, "wager");
  assert.equal(built.envelope.transactions.length, 1);
  assert.equal(built.envelope.sign_url, undefined, "a stake gets no sign link");
  const [check, open] = ours(built);
  const e = decodeEd25519(check!.data)!;
  assert.equal(e.key, DESK_KEY.toBase58());
  assert.ok(e.message.equals(linkTicketMessage(LINK_PROGRAM, t)));
  const wg = decodeLinkWager(open!.data)!;
  assert.equal(wg.kind, "open");
  assert.deepEqual(wg.kind === "open" && [wg.battleId, wg.playerB, wg.stake, wg.acceptDeadline, wg.expiry, wg.keyId], [t.battleId, t.playerB, t.stake, t.acceptDeadline, t.expiry, t.keyId]);
  assert.deepEqual(open!.keys.slice(0, 3).map((k) => k.toBase58()), [a.toBase58(), linkConfigAddress(LINK_PROGRAM).toBase58(), linkBattleAddress(LINK_PROGRAM, battleId).toBase58()]);
  assert.deepEqual(linkWagerFacts(built.envelope, LINK_PROGRAM), { kind: "open", battle: linkBattleAddress(LINK_PROGRAM, battleId).toBase58(), stake: 100_000_000n });
  // The bytes pass only for a caller expecting exactly this stake: not the sign page, not another battle's guard.
  const tx = VersionedTransaction.deserialize(Buffer.from(built.envelope.transactions[0]!.base64, "base64"));
  const safe = (guards: ReturnType<typeof linkWagerGuard>[]) => assertSafe(tx, "devnet", { wallet: a, allowLaunchLab: false, allowCpmm: false, guards });
  safe([linkWagerGuard(LINK_PROGRAM, { kind: "open", battleId, ticket: t, ticketKey: DESK_KEY })]);
  assert.throws(() => safe([]), /outside the allow-list/);
  assert.throws(() => safe([linkWagerGuard(LINK_PROGRAM)]), /only a link battle's stake or settle carries|only the local signer's stakes make/);
  assert.throws(() => safe([linkWagerGuard(LINK_PROGRAM, { kind: "open", battleId: "66".repeat(32), ticket: { ...t, battleId: "66".repeat(32) }, ticketKey: DESK_KEY })]), /isn't this battle's ticket/);
  assert.ok(describeTransaction(tx, "devnet", [], [linkWagerGuard(LINK_PROGRAM)]).instructions.some((i) => /Stake 0.1 SOL on a link battle against/.test(i.text)));
  assert.ok(net.calls.includes("simulateTransaction"), "simulated like everything Highwire builds");
});

test("an open is refused for the wrong wallet, a stale ticket, a forged one, a retired key, a tier that isn't one, a paused program", async () => {
  const net = fakeDevnet();
  const s = { chain: net.chain, program: LINK_PROGRAM };
  await assert.rejects(buildLinkOpen(s, { wallet: b, ...signTicket(ticket()) }), /opens a battle for another wallet/);
  await assert.rejects(buildLinkOpen(s, { wallet: a, ...signTicket(ticket({ expiry: now() - 1 })) }), /ticket has expired/);
  await assert.rejects(buildLinkOpen(s, { wallet: a, ...signTicket(ticket(), new Uint8Array(32).fill(8)) }), /isn't signed by the desk's key/);
  // A real signature on another ticket (a smaller stake) doesn't carry over.
  await assert.rejects(buildLinkOpen(s, { wallet: a, ticket: ticket({ stake: 250_000_000n }), signature: signTicket(ticket()).signature }), /isn't signed by the desk's key/);
  await assert.rejects(buildLinkOpen(s, { wallet: a, ticket: ticket(), signature: "zz" }), /64 bytes of hex/);
  await assert.rejects(buildLinkOpen(s, { wallet: a, ...signTicket(ticket({ keyId: 2 })) }), /retired desk key/);
  await assert.rejects(buildLinkOpen(s, { wallet: a, ...signTicket(ticket({ stake: 50_000_000n })) }), /isn't one of the program's tiers/);
  net.setConfig({ paused: true });
  await assert.rejects(buildLinkOpen(s, { wallet: a, ...signTicket(ticket()) }), /is paused/);
  assert.ok(!net.calls.includes("simulateTransaction"), "nothing refused was built");
});

test("an accept stakes only on the battle its ticket describes, as it stands on-chain", async () => {
  const net = fakeDevnet();
  const s = { chain: net.chain, program: LINK_PROGRAM };
  const t = ticket();
  await assert.rejects(buildLinkAccept(s, { wallet: b, ...signTicket(t) }), /isn't open/);
  net.setBattle(battleOf(t, "open"));
  assert.equal((await readLinkBattle(s, battleId))?.status, "open");
  const built = await buildLinkAccept(s, { wallet: b, ...signTicket(t) });
  assert.equal(built.stake, 100_000_000n);
  const [check, accept] = ours(built);
  assert.ok(decodeEd25519(check!.data)!.message.equals(linkTicketMessage(LINK_PROGRAM, t)));
  assert.equal(decodeLinkWager(accept!.data)!.kind, "accept");
  assert.equal(accept!.keys[0]!.toBase58(), b.toBase58());
  assert.deepEqual(linkWagerFacts(built.envelope, LINK_PROGRAM), { kind: "accept", battle: linkBattleAddress(LINK_PROGRAM, battleId).toBase58() });
  // Not for A, not once it has started, not when the account says something other than the ticket, not late.
  await assert.rejects(buildLinkAccept(s, { wallet: a, ...signTicket(t) }), /for another wallet to accept/);
  net.setBattle({ ...battleOf(t, "open"), stake: 250_000_000n });
  await assert.rejects(buildLinkAccept(s, { wallet: b, ...signTicket(t) }), /doesn't match the ticket/);
  net.setBattle(battleOf(t, "live"));
  await assert.rejects(buildLinkAccept(s, { wallet: b, ...signTicket(t) }), /isn't open/);
  const late = ticket({ acceptDeadline: now() - 5 });
  net.setBattle(battleOf(late, "open"));
  await assert.rejects(buildLinkAccept(s, { wallet: b, ...signTicket(late) }), /time to accept has passed/);
  // An account at the battle's address that isn't the program's is no battle.
  net.accounts.set(linkBattleAddress(LINK_PROGRAM, battleId).toBase58(), { data: linkBattleBytes(battleOf(t, "open")), owner: PublicKey.default.toBase58() });
  assert.equal(await readLinkBattle(s, battleId), null);
});

test("a settle carries the referee's result for the two wallets on-chain, and anyone may send it", async () => {
  const net = fakeDevnet();
  const s = { chain: net.chain, program: LINK_PROGRAM };
  const t = ticket();
  const sender = Keypair.generate().publicKey;
  await assert.rejects(buildLinkSettle(s, { wallet: sender, ...signResult(result()) }), /no such staked battle/);
  net.setBattle(battleOf(t, "open"));
  await assert.rejects(buildLinkSettle(s, { wallet: sender, ...signResult(result()) }), /hasn't both stakes in/);
  net.setBattle(battleOf(t, "live"));
  for (const outcome of ["a", "b", "draw", "void"] as const) {
    const r = result({ outcome });
    const built = await buildLinkSettle(s, { wallet: sender, ...signResult(r) });
    const [check, settle] = ours(built);
    const e = decodeEd25519(check!.data)!;
    assert.equal(e.key, REFEREE_KEY.toBase58());
    assert.ok(e.message.equals(linkResultMessage(LINK_PROGRAM, r)));
    const wg = decodeLinkWager(settle!.data)!;
    assert.deepEqual(wg.kind === "settle" && [wg.outcome, wg.keyId], [outcome, 1]);
    assert.deepEqual(settle!.keys.map((k) => k.toBase58()).slice(2, 4), [a.toBase58(), b.toBase58()], "the two players, as the battle records them");
    assert.equal(settle!.keys.at(-1)!.toBase58(), INCINERATOR);
    assert.equal(linkWagerFacts(built.envelope, LINK_PROGRAM)?.kind, "settle");
  }
  // A result for other wallets, by another key, or a real signature moved to another outcome.
  const stranger = Keypair.generate().publicKey.toBase58();
  await assert.rejects(buildLinkSettle(s, { wallet: sender, ...signResult(result({ playerB: stranger })) }), /names other wallets/);
  await assert.rejects(buildLinkSettle(s, { wallet: sender, ...signResult(result(), new Uint8Array(32).fill(8)) }), /isn't signed by the referee's key/);
  await assert.rejects(buildLinkSettle(s, { wallet: sender, result: result({ outcome: "b" }), signature: signResult(result()).signature }), /isn't signed by the referee's key/);
  await assert.rejects(buildLinkSettle(s, { wallet: sender, ...signResult(result({ keyId: 2 })) }), /retired referee key/);
  // The desk's key signs pairings, never results.
  await assert.rejects(buildLinkSettle(s, { wallet: sender, ...signResult(result(), new Uint8Array(32).fill(7)) }), /isn't signed by the referee's key/);
});

test("a cancel is for a battle nobody accepted, a refund for one both staked on", async () => {
  const net = fakeDevnet();
  const s = { chain: net.chain, program: LINK_PROGRAM };
  const t = ticket();
  await assert.rejects(buildLinkExit(s, { wallet: a, battleId, kind: "cancel" }), /no such staked battle/);
  net.setBattle(battleOf(t, "open"));
  const cancel = await buildLinkExit(s, { wallet: a, battleId, kind: "cancel" });
  assert.equal(decodeLinkWager(ours(cancel)[0]!.data)!.kind, "cancel");
  assert.equal(ours(cancel).length, 1, "no signature check: nothing signed is needed to take your own stake back");
  await assert.rejects(buildLinkExit(s, { wallet: a, battleId, kind: "refund" }), /cancel it instead/);
  net.setBattle(battleOf(t, "live"));
  const refund = await buildLinkExit(s, { wallet: b, battleId, kind: "refund" });
  assert.equal(decodeLinkWager(ours(refund)[0]!.data)!.kind, "refund");
  await assert.rejects(buildLinkExit(s, { wallet: a, battleId, kind: "cancel" }), /settled or refunded, not cancelled/);
  // A player whose wallet can't be credited (a program's account) is passed read-only, so the refund still lands.
  net.accounts.set(b.toBase58(), { data: Buffer.alloc(0), owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true });
  const burnt = await buildLinkExit(s, { wallet: a, battleId, kind: "refund" });
  const meta = VersionedTransaction.deserialize(Buffer.from(burnt.envelope.transactions[0]!.base64, "base64")).message;
  const idx = meta.staticAccountKeys.findIndex((k) => k.equals(b));
  assert.equal(meta.isAccountWritable(idx), false);
});
