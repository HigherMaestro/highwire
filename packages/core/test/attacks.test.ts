import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LaunchpadPool } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { buildLaunch } from "../src/tx/launch.ts";
import { ADDRESSES, HIGHWIRE_WALLET, highwireFeeLamports } from "../src/higher/constants.ts";
import { Chain } from "../src/tx/chain.ts";
import { assertSafe, associatedTokenAddress, describeTransaction, NATIVE_MINT_ADDRESS, PROGRAMS } from "../src/tx/decode.ts";
import { replayFetch, type Recording } from "./replay.ts";
import { runScenario } from "./run-scenario.ts";
import { LAUNCH_FOR, LAUNCH_MINT, TRADER } from "./scenarios.ts";
import { highwireFeeBound, reviewEnvelope } from "../src/tx/review.ts";

// Hand-made transactions an attacker could put in a sign link, from the pre-launch audit. Each must be refused by the
// same check the builders and the sign page run.

const wallet = TRADER;
const attacker = Keypair.generate().publicKey;
const memo = new TransactionInstruction({ programId: new PublicKey(PROGRAMS.memo), keys: [], data: Buffer.from("highwire") });
const tx = (...ixs: TransactionInstruction[]) =>
  new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: PublicKey.default.toBase58(), instructions: [...ixs, memo] }).compileToV0Message());
const refused = (t: VersionedTransaction, why: RegExp) => assert.throws(() => assertSafe(t, "mainnet", { wallet, platformId: new PublicKey(ADDRESSES.mainnet.rewardsPlatform) }), why);
const meta = (pubkey: PublicKey, isWritable = true) => ({ pubkey, isSigner: false, isWritable });

test("an associated-token account under an attacker's program, then SOL into it, is refused", () => {
  const fakeProgram = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const ata = associatedTokenAddress(mint, wallet, fakeProgram);
  const open = new TransactionInstruction({
    programId: new PublicKey(PROGRAMS.associatedToken),
    keys: [{ pubkey: wallet, isSigner: true, isWritable: true }, meta(ata), meta(wallet, false), meta(mint, false), meta(SystemProgram.programId, false), meta(fakeProgram, false)],
    data: Buffer.from([1]),
  });
  refused(tx(open, SystemProgram.transfer({ fromPubkey: wallet, toPubkey: ata, lamports: 40e9 })), /isn't a token program/);
  refused(tx(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: ata, lamports: 40e9 })), /not the wallet's own wrapped-SOL account/);
});

test("SOL parked in a token account for a mint someone else controls is refused", () => {
  const mint = Keypair.generate().publicKey;
  const acct = PublicKey.createWithSeed(wallet, "x", new PublicKey(PROGRAMS.token2022));
  return acct.then((account) => {
    const create = SystemProgram.createAccountWithSeed({ fromPubkey: wallet, newAccountPubkey: account, basePubkey: wallet, seed: "x", lamports: 50e9, space: 165, programId: new PublicKey(PROGRAMS.token2022) });
    const init = new TransactionInstruction({
      programId: new PublicKey(PROGRAMS.token2022),
      keys: [meta(account), meta(mint, false)],
      data: Buffer.concat([Buffer.from([18]), wallet.toBuffer()]),
    });
    refused(tx(create, init), /isn't initialised as the wallet's own wrapped SOL/);
    // An account owned by some other program, or left uninitialised for anyone to claim, is refused too.
    const other = SystemProgram.createAccountWithSeed({ fromPubkey: wallet, newAccountPubkey: account, basePubkey: wallet, seed: "x", lamports: 50e9, space: 165, programId: attacker });
    refused(tx(other), /not a token program/);
  });
});

test("a curve trade that names someone else's accounts, pays a share fee or has no minimum out is refused", async () => {
  const recording: Recording = JSON.parse(readFileSync(new URL("./fixtures/buy-curve.json", import.meta.url), "utf8"));
  const built = await runScenario("buy-curve", replayFetch(recording));
  assert.ok(built && "envelope" in built && built.envelope);
  const real = VersionedTransaction.deserialize(Buffer.from(built.envelope.transactions[0]!.base64, "base64"));
  const ixs = TransactionMessage.decompile(real.message).instructions;
  const i = ixs.findIndex((ix) => ix.programId.toBase58() === ADDRESSES.mainnet.launchLabProgram);
  // The genuine build passes, with its Highwire fee bounded as the sign page bounds it: from the trade in the bytes.
  const exp = { wallet, platformId: new PublicKey(ADDRESSES.mainnet.rewardsPlatform), highwireFee: { maxLamports: highwireFeeBound(describeTransaction(real, "mainnet"))! } };
  assertSafe(real, "mainnet", exp);
  const tamper = (f: (ix: TransactionInstruction) => void) => {
    const copy = ixs.map((ix) => new TransactionInstruction({ programId: ix.programId, keys: ix.keys.map((k) => ({ ...k })), data: Buffer.from(ix.data) }));
    f(copy[i]!);
    return new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: real.message.recentBlockhash, instructions: copy }).compileToV0Message());
  };
  assert.throws(() => assertSafe(tamper((ix) => (ix.keys[5]!.pubkey = attacker)), "mainnet", exp), /coin account that isn't the wallet's/);
  assert.throws(() => assertSafe(tamper((ix) => ix.data.writeBigUInt64LE(1_000_000n, 24)), "mainnet", exp), /share fee/);
  assert.throws(() => assertSafe(tamper((ix) => ix.data.writeBigUInt64LE(0n, 16)), "mainnet", exp), /no minimum-out guard/);
  assert.throws(() => assertSafe(tamper((ix) => ix.keys.push(meta(attacker))), "mainnet", exp), /unexpected layout/);
  assert.throws(() => assertSafe(tamper((ix) => (ix.keys[16]!.pubkey = attacker)), "mainnet", exp), /platform fee vault/);
});

test("a launch for another account names them as creator and funds them, and only the local signer may build one", async () => {
  const recording: Recording = JSON.parse(readFileSync(new URL("./fixtures/launch-for.json", import.meta.url), "utf8"));
  const built = await runScenario("launch-for", replayFetch(recording));
  assert.ok(built && "status" in built && built.status === "built");
  const d = built.envelope.transactions[0]!;
  assert.equal(d.simulation.ok, true, d.simulation.error);
  const tx = VersionedTransaction.deserialize(Buffer.from(d.base64, "base64"));
  const tables = await new Chain({ cluster: "mainnet", fetch: replayFetch(recording) }).lookupTables([tx]);
  // The creator is the other account, and they get exactly the top-up; the payer still signs and pays.
  assert.ok(d.summary.some((l) => l.includes(`creator ${LAUNCH_FOR.toBase58()}`)), d.summary.join("\n"));
  assert.ok(d.summary.some((l) => l.includes(`Send 0.005 SOL from ${TRADER.toBase58()} to ${LAUNCH_FOR.toBase58()}`)));
  // Without the launch-for expectation, the same bytes are refused: nobody else gets to slip in a creator.
  assert.throws(() => assertSafe(tx, "mainnet", { wallet, platformId: new PublicKey(ADDRESSES.mainnet.rewardsPlatform), extraSigners: [LAUNCH_MINT.publicKey] }, tables));
  // And the sign page never signs one.
  const problems = reviewEnvelope(built.envelope, { lookupTables: tables }).problems;
  assert.ok(problems.some((p) => /creates a coin for someone else/.test(p)), problems.join("; "));
});

test("a launch whose creator lock never got assigned can be resumed: a retry builds just the assignment", async () => {
  const { owner, data } = JSON.parse(readFileSync(new URL("./fixtures/lgtm-pool.json", import.meta.url), "utf8")) as { owner: string; data: string };
  const pool = LaunchpadPool.decode(Buffer.from(data, "base64"));
  const supply = BigInt(pool.supply.toString());
  // $LGTM's real pool, as if its creator had asked for a 5% lock whose assignment expired before it was sent.
  pool.vestingSchedule.totalLockedAmount = new BN(((supply * 5n) / 100n).toString());
  pool.vestingSchedule.totalAllocatedShare = new BN(0);
  const buf = Buffer.alloc(Buffer.from(data, "base64").length);
  LaunchpadPool.encode(pool, buf);
  const creator = pool.creator;
  const mint = pool.mintA;
  const poolId = new PublicKey("HiqFQ4pxYspnFKPKQXGRbRsDucSvkRvY3f46Ly7Dtf5T");
  const fetch = (async (_u: string | URL, init?: RequestInit) => {
    const { method, params, id } = JSON.parse(String(init?.body));
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });
    if (method === "getAccountInfo") {
      const value = params[0] === poolId.toBase58() ? { data: [buf.toString("base64"), "base64"], executable: false, lamports: 1, owner, rentEpoch: 0, space: buf.length } : null;
      return ok({ context: { slot: 1 }, value });
    }
    if (method === "getLatestBlockhash") return ok({ context: { slot: 1 }, value: { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 } });
    throw new Error(`unexpected ${method}`);
  }) as typeof globalThis.fetch;
  const chain = new Chain({ cluster: "mainnet", fetch });
  const keys = { get: () => ({ publicKey: mint }) as unknown as Keypair };
  const r = await buildLaunch(chain, null, {
    wallet: creator, name: "Looks Good To Me", ticker: "LGTM", metadataUri: "https://example.com/m.json", mode: "rewards", slippageBps: 500,
    mint: keys.get() as Keypair, simulate: false,
  });
  assert.ok(r.status === "built" && r.resumed, r.status);
  assert.equal(r.envelope.transactions.length, 1);
  assert.equal(r.creatorLock?.pct, 5);
  assert.ok(r.envelope.transactions[0]!.summary.some((l) => /Assign .* locked tokens of pool HiqFQ4/.test(l)));
  // The sign page reviews it cleanly: the wallet assigns its own coin's lock to itself.
  assert.deepEqual(reviewEnvelope(r.envelope).problems, []);
  // Someone else's wallet gets no resume: only the coin's creator can assign its lock.
  const other = await buildLaunch(chain, null, { wallet: Keypair.generate().publicKey, name: "x", ticker: "X", metadataUri: "https://example.com/m.json", mode: "rewards", slippageBps: 500, mint: keys.get() as Keypair, simulate: false });
  assert.equal(other.status, "already_launched");
});

test("Highwire's trade fee: exactly one transfer, on a trade only, of at most 0.3% of the trade's SOL side", async () => {
  const recording: Recording = JSON.parse(readFileSync(new URL("./fixtures/buy-curve.json", import.meta.url), "utf8"));
  const built = await runScenario("buy-curve", replayFetch(recording));
  assert.ok(built && "envelope" in built && built.envelope);
  const env = built.envelope;
  const real = VersionedTransaction.deserialize(Buffer.from(env.transactions[0]!.base64, "base64"));
  const d = describeTransaction(real, "mainnet");
  // The build pays it once, 0.3% of the SOL in, and the sign page's review accepts it and shows it.
  assert.equal(d.highwireFees.length, 1);
  assert.equal(d.highwireFees[0], highwireFeeLamports(d.trades[0]!.amountIn));
  assert.ok(d.instructions.some((ix) => ix.text.startsWith("Pay Highwire's 0.3% trade fee")));
  const ok = reviewEnvelope(env);
  assert.deepEqual(ok.problems, []);
  assert.ok(ok.transactions[0]!.effects.some((e) => e.kind === "spend" && /Highwire trade fee \(0\.3%\)/.test(e.text)));

  // Tampered copies of the same link, each reviewed as the sign page would.
  const ixs = TransactionMessage.decompile(real.message).instructions;
  const feeAt = ixs.findIndex((ix) => ix.programId.equals(SystemProgram.programId) && ix.keys[1]?.pubkey.toBase58() === HIGHWIRE_WALLET);
  assert.ok(feeAt >= 0);
  const fee = SystemProgram.transfer({ fromPubkey: wallet, toPubkey: new PublicKey(HIGHWIRE_WALLET), lamports: 1 });
  const relink = (instructions: TransactionInstruction[]) => {
    const t = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: real.message.recentBlockhash, instructions }).compileToV0Message());
    return reviewEnvelope({ ...env, transactions: [{ ...env.transactions[0]!, base64: Buffer.from(t.serialize()).toString("base64"), recentBlockhash: real.message.recentBlockhash }] }).problems.join(" ");
  };
  const greedy = ixs.map((ix, j) => (j === feeAt ? SystemProgram.transfer({ fromPubkey: wallet, toPubkey: new PublicKey(HIGHWIRE_WALLET), lamports: Number(d.highwireFees[0]! * 2n) }) : ix));
  assert.match(relink(greedy), /more than 0\.3% of the trade/);
  assert.match(relink([...ixs.slice(0, feeAt), fee, ...ixs.slice(feeAt)]), /more than one payment to Highwire/);
  // With no trade at all there's nothing to take a fee on.
  assert.match(relink([fee, memo]), /isn't a single trade|never makes/);
});

test("a launch never carries Highwire's trade fee, even with a first buy", async () => {
  const recording: Recording = JSON.parse(readFileSync(new URL("./fixtures/launch-rewards.json", import.meta.url), "utf8"));
  const built = await runScenario("launch-rewards", replayFetch(recording));
  assert.ok(built && "envelope" in built && built.envelope);
  const real = VersionedTransaction.deserialize(Buffer.from(built.envelope.transactions[0]!.base64, "base64"));
  assert.deepEqual(describeTransaction(real, "mainnet").highwireFees, []);
  assert.equal(highwireFeeBound(describeTransaction(real, "mainnet")), null);
});

test("Jito tips: only the local signer's protected sends tip, once, within the cap, with the don't-front key and nothing else", async () => {
  const { JITO_DONT_FRONT, JITO_TIP_ACCOUNTS } = await import("../src/higher/constants.ts");
  const { jitoTipInstruction } = await import("../src/tx/envelope.ts");
  const { jitoTipsOf } = await import("../src/tx/decode.ts");
  const tipAccount = JITO_TIP_ACCOUNTS[2];
  const tip = (lamports = 50_000n) => jitoTipInstruction(wallet, { tipLamports: lamports, tipAccount });
  const exp = { wallet, platformId: new PublicKey(ADDRESSES.mainnet.rewardsPlatform) };
  const allowed = (t: VersionedTransaction, maxLamports = 100_000n) => assertSafe(t, "mainnet", { ...exp, jitoTip: { maxLamports } });

  // The builder's tip passes with its expectation, and reads back from the bytes alone.
  allowed(tx(tip()));
  assert.deepEqual(jitoTipsOf(tx(tip())), [50_000n]);
  assert.match(describeTransaction(tx(tip()), "mainnet").instructions[0]!.text, /Tip Jito's block engine 0\.00005 SOL .*nothing allowed in front of it/);
  // Without it (every build tool, every sign link), a tip is refused.
  refused(tx(tip()), /only the local signer's protected sends make/);
  // Exactly one, within the cap and Jito's minimum.
  assert.throws(() => allowed(tx(tip(), tip())), /more than one tip/);
  assert.throws(() => allowed(tx(tip(200_000n))), /outside its bounds/);
  assert.throws(() => allowed(tx()), /must tip exactly once/);
  const small = SystemProgram.transfer({ fromPubkey: wallet, toPubkey: new PublicKey(tipAccount), lamports: 500 });
  assert.throws(() => allowed(tx(small)), /outside its bounds/);
  // The don't-front key: read-only, on the tip only, and nothing else rides along.
  const writableKey = SystemProgram.transfer({ fromPubkey: wallet, toPubkey: new PublicKey(tipAccount), lamports: 50_000 });
  writableKey.keys.push(meta(new PublicKey(JITO_DONT_FRONT), true));
  assert.throws(() => allowed(tx(writableKey)), /unexpected accounts/);
  const extra = tip();
  extra.keys.push(meta(attacker, false));
  assert.throws(() => allowed(tx(extra)), /unexpected accounts/);
  const onFee = SystemProgram.transfer({ fromPubkey: wallet, toPubkey: new PublicKey(HIGHWIRE_WALLET), lamports: 1000 });
  onFee.keys.push(meta(new PublicKey(JITO_DONT_FRONT), false));
  assert.throws(() => allowed(tx(onFee, tip())), /"don't front" key, which only a tip may/);
  // A plain transfer with extra accounts is refused too, tip or not.
  const sneaky = SystemProgram.transfer({ fromPubkey: wallet, toPubkey: new PublicKey(HIGHWIRE_WALLET), lamports: 1000 });
  sneaky.keys.push(meta(attacker, false));
  assert.throws(() => assertSafe(tx(sneaky), "mainnet", { ...exp, highwireFee: { maxLamports: 1000n } }), /unexpected accounts/);
  // The builder only tips Jito's own accounts, within 0.000001 to 0.01 SOL.
  assert.throws(() => jitoTipInstruction(wallet, { tipLamports: 50_000n, tipAccount: attacker.toBase58() }), /isn't one of Jito's tip accounts/);
  assert.throws(() => jitoTipInstruction(wallet, { tipLamports: 20_000_000n, tipAccount }), /outside/);
});

test("registration memos: only with the exact code the local signer expects, once, never on a sign link", async () => {
  const code = "abcdefghijklmnop";
  const agentMemo = (text: string, keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = []) =>
    new TransactionInstruction({ programId: new PublicKey(PROGRAMS.memo), keys, data: Buffer.from(text) });
  const reg = tx(agentMemo(`highwire agent ${code}`));
  const ok = (t: VersionedTransaction, c = code) => assertSafe(t, "mainnet", { wallet, allowLaunchLab: false, allowCpmm: false, agentCode: c });
  ok(reg);
  assert.ok(describeTransaction(reg, "mainnet").instructions.some((i) => i.known && /Registers this wallet with Highwire's relay/.test(i.text)));
  // Without the expectation (as on the sign page), the same bytes are refused.
  refused(reg, /a memo other than Highwire's/);
  // Another code, two of them, a lookalike, one with an account, or a registration without its memo: refused.
  assert.throws(() => ok(reg, "ponmlkjihgfedcba"), /a memo other than Highwire's/);
  assert.throws(() => ok(tx(agentMemo(`highwire agent ${code}`), agentMemo(`highwire agent ${code}`))), /more than one registration memo/);
  assert.throws(() => ok(tx(agentMemo(`highwire agent ${code} `))), /a memo other than Highwire's/);
  assert.throws(() => ok(tx(agentMemo(`highwire agent ${code}`, [meta(attacker, false)]))), /a memo other than Highwire's/);
  assert.throws(() => ok(tx()), /must carry its memo exactly once/);
  // Nothing may ride along: a transfer in a registration is refused like any other.
  assert.throws(() => ok(tx(agentMemo(`highwire agent ${code}`), SystemProgram.transfer({ fromPubkey: wallet, toPubkey: attacker, lamports: 1e9 }))), /./);
  // A sign link can't carry a registration at all, whatever its bytes.
  const { decodeSignPayload, encodeSignPayload, signUrl } = await import("../src/tx/sign-link.ts");
  const env = { format: "highwire.unsigned-tx/v2", cluster: "mainnet", wallet: wallet.toBase58(), kind: "register", transactions: [], expiresAfterBlockHeight: 1, builtAt: 1, howToSign: "" } as never;
  await assert.rejects(signUrl(env), /registrations get no sign link/);
  await assert.rejects(async () => decodeSignPayload(await encodeSignPayload(env)), /never signs registrations/);
});

test("wagers: only the local signer's, exactly as expected; never on the sign page or a sign link", async () => {
  const { ed25519 } = await import("@noble/curves/ed25519");
  const { ComputeBudgetProgram } = await import("@solana/web3.js");
  const w = await import("../src/tx/wager-codec.ts");
  const program = new PublicKey(w.WAGER_PROGRAM_IDS.devnet!);
  const secret = new Uint8Array(32).fill(7);
  const ticketKey = new PublicKey(ed25519.getPublicKey(secret));
  const ticket = { seriesId: "55".repeat(32), playerA: wallet.toBase58(), playerB: attacker.toBase58(), stake: 100_000_000n, acceptDeadline: 1_300, expiry: 1_600, keyId: 1 };
  const check = (t = ticket, key = secret) => w.ticketCheck(program, t, new PublicKey(ed25519.getPublicKey(key)), ed25519.sign(w.ticketMessage(program, t), key));
  const open = (t = ticket, signer = wallet) => w.wagerInstruction(program, signer, t.seriesId, { kind: "open", ticket: t, fallbackHash: "44".repeat(32) });
  const expectOpen = { wallet, allowLaunchLab: false, allowCpmm: false, wager: { kind: "open" as const, seriesId: ticket.seriesId, ticket, ticketKey } };
  const ok = (t: VersionedTransaction, exp: object = expectOpen) => assertSafe(t, "devnet", { wallet, ...exp } as never);
  const no = (t: VersionedTransaction, why: RegExp, exp: object = expectOpen) => assert.throws(() => ok(t, exp), why);

  ok(tx(check(), open()));
  assert.ok(describeTransaction(tx(check(), open()), "devnet").instructions.some((i) => i.known && /Stake 0.1 SOL and open a best-of-5 wager series/.test(i.text)));
  // The sign page never expects a wager, so it refuses the ticket check and the wager alike.
  no(tx(check(), open()), /an Ed25519 check, which only a wager's open or accept carries/, {});
  no(tx(open()), /a wager on The Line, which only the local signer's wagers make/, {});
  // A ticket signed by another key, for another stake or series, or not immediately before the open.
  no(tx(check(ticket, new Uint8Array(32).fill(9)), open()), /isn't signed by the matchmaker's key/);
  no(tx(check({ ...ticket, stake: 1_000_000_000n }), open()), /isn't this series' ticket/);
  no(tx(check(), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), open()), /isn't immediately before the wager/);
  no(tx(open()), /without its ticket check/);
  // An open whose data disagrees with its ticket (a bigger stake than the ticket's), or for another wallet.
  no(tx(check(), open({ ...ticket, stake: 1_000_000_000n })), /doesn't match its ticket/);
  no(tx(check(), open(ticket, attacker)), /player isn't the expected one|unexpected signer/);
  // Another kind than the flow builds, two wager instructions, or another series' account.
  const retire = (id = ticket.seriesId) => w.wagerInstruction(program, wallet, id, { kind: "retire" });
  const expectCommit = { wager: { kind: "commit", seriesId: ticket.seriesId, commit: { match: 0, round: 1 } } };
  no(tx(retire()), /not the wager instruction this flow builds/, expectCommit);
  const commit = (id = ticket.seriesId, match = 0, round = 1) => w.wagerInstruction(program, wallet, id, { kind: "commit", match, round, hash: "66".repeat(32) });
  ok(tx(commit()), expectCommit);
  assert.ok(describeTransaction(tx(commit(ticket.seriesId, 1, 3)), "devnet").instructions.some((i) => i.known && /Commit a hidden move for match 2, round 3 of wager series/.test(i.text)));
  // A commit names its match and round, and they must be the ones it was made for: the program takes it in no other,
  // and one naming another would stand (or be refused) where its hidden move can't be opened.
  no(tx(commit(ticket.seriesId, 1, 1)), /the commit names match 2, round 1, not the match 1, round 1 it was made for/, expectCommit);
  no(tx(commit(ticket.seriesId, 0, 2)), /the commit names match 1, round 2, not the match 1, round 1 it was made for/, expectCommit);
  no(tx(commit()), /a commit without the match and round it's for/, { wager: { kind: "commit", seriesId: ticket.seriesId } });
  // A commit as it was before it named its match (the tag, the round, the hash: 34 bytes) isn't a wager instruction now.
  const oldCommit = new TransactionInstruction({ programId: program, keys: commit().keys, data: Buffer.concat([Buffer.from([5, 1]), Buffer.alloc(32, 0x66)]) });
  no(tx(oldCommit), /not the wager instruction this flow builds/, expectCommit);
  assert.ok(describeTransaction(tx(oldCommit), "devnet").instructions.some((i) => !i.known && /UNKNOWN wager instruction/.test(i.text)));
  no(tx(commit(), commit()), /more than one wager instruction/, expectCommit);
  no(tx(commit("77".repeat(32))), /series account isn't the expected one/, expectCommit);
  // A payout must name the incinerator as its burn account, not someone's wallet.
  const parties = { playerA: wallet, playerB: attacker, feeAccount: attacker };
  const settle = w.wagerInstruction(program, wallet, ticket.seriesId, { kind: "settle" }, parties);
  const expectSettle = { wager: { kind: "settle", seriesId: ticket.seriesId } };
  ok(tx(settle), expectSettle);
  const swapped = new TransactionInstruction({ programId: program, keys: settle.keys.map((k, i) => (i === settle.keys.length - 1 ? meta(attacker) : k)), data: settle.data });
  no(tx(swapped), /burn account isn't the expected one/, expectSettle);
  // A payout with an extra account, or an accept of a ticket naming another wallet as B.
  const padded = new TransactionInstruction({ programId: program, keys: [...settle.keys, meta(attacker)], data: settle.data });
  no(tx(padded), /settle with unexpected accounts/, expectSettle);
  const accept = w.wagerInstruction(program, wallet, ticket.seriesId, { kind: "accept", fallbackHash: "44".repeat(32) });
  no(tx(check(), accept), /isn't for this wallet to accept/, { wager: { kind: "accept", seriesId: ticket.seriesId, ticket, ticketKey } });
  // The admin instructions are never built, whatever the expectation says.
  const freeze = new TransactionInstruction({ programId: program, keys: [], data: Buffer.from([w.WAGER_TAGS.freezeAndRefund]) });
  no(tx(freeze), /Highwire never builds/, { wager: { kind: "freezeAndRefund", seriesId: ticket.seriesId } });
  // A sign link can't carry a wager at all.
  const { decodeSignPayload, encodeSignPayload, signUrl } = await import("../src/tx/sign-link.ts");
  const env = { format: "highwire.unsigned-tx/v2", cluster: "devnet", wallet: wallet.toBase58(), kind: "wager", transactions: [], expiresAfterBlockHeight: 1, builtAt: 1, howToSign: "" } as never;
  await assert.rejects(signUrl(env), /wagers get no sign link/);
  await assert.rejects(async () => decodeSignPayload(await encodeSignPayload(env)), /never signs wagers/);
});
