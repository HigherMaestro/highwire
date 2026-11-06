import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ADDRESSES } from "../src/higher/constants.ts";
import { assertSafe, associatedTokenAddress, NATIVE_MINT_ADDRESS, PROGRAMS } from "../src/tx/decode.ts";
import { replayFetch, type Recording } from "./replay.ts";
import { runScenario } from "./run-scenario.ts";
import { TRADER } from "./scenarios.ts";

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
  const exp = { wallet, platformId: new PublicKey(ADDRESSES.mainnet.rewardsPlatform) };
  // The genuine build passes.
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
