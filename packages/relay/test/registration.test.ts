import { test } from "node:test";
import assert from "node:assert/strict";
import { MAINNET } from "highwire-core/arena";
import { randomHex, sha256Hex } from "../src/registration.ts";
import { launchTx, memoTx, MINT, MINT2, OTHER, rig, WALLET } from "./fakes.ts";

// The shared registration (docs/x-posting.md 5), every case: what a launch must show, one challenge at a time, the
// secret that stops a stranger registering with a memo they saw on-chain, and tokens that a new registration replaces.

async function challenge(r: ReturnType<typeof rig>, over: Record<string, unknown> = {}, tx = launchTx()) {
  const secret = randomHex();
  const launchSignature = r.rpc.add(tx);
  const res = await r.call("POST", "/api/agents/challenge", { wallet: WALLET, mint: MINT, launchSignature, secretHash: sha256Hex(secret), ...over });
  return { res, secret };
}

test("a Highwire launch paid for by the wallet registers, and the token works", async () => {
  const r = rig();
  const { res, secret } = await challenge(r);
  assert.equal(res.status, 200, res.text);
  assert.match(res.body.code, /^[a-z2-7]{16}$/);
  assert.equal(res.body.memo, `highwire agent ${res.body.code}`);
  const memo = r.rpc.add(memoTx(WALLET, res.body.memo, r.clock.now() + 20_000));
  const reg = await r.call("POST", "/api/agents/register", { code: res.body.code, signature: memo, secret, adult: true });
  assert.equal(reg.status, 200, reg.text);
  assert.match(reg.body.arenaToken, /^[0-9a-f]{64}$/);
  assert.equal(reg.body.fighter.name, "Wire Cat");
  assert.equal(reg.body.fighter.provisional, true);
  // The token is stored only as a hash.
  assert.ok(!JSON.stringify(r.store.dump()).includes(reg.body.arenaToken));
  const join = await r.call("POST", "/api/arena/join", { fallback: "zero" }, reg.body.arenaToken);
  assert.equal(join.status, 200, join.text);
  // The code is used up.
  const again = await r.call("POST", "/api/agents/register", { code: res.body.code, signature: memo, secret, adult: true });
  assert.equal(again.body.code, "expired");
});

test("launches that don't qualify are refused, each with its reason", async () => {
  const cases: [string, Parameters<typeof launchTx>[0], RegExp][] = [
    ["paid for by someone else", { payer: OTHER }, /paid for by another wallet/],
    ["failed", { failed: true }, /failed/],
    ["no highwire memo", { memo: null }, /no highwire memo/],
    ["another memo", { memo: "highwire " }, /no highwire memo/],
    ["another platform", { platform: OTHER }, /doesn't create this coin on higher\.fun/],
    ["another coin", { mint: MINT2 }, /doesn't create this coin/],
    ["not initialize_v2", { discriminator: "faea0d7bd59c13ec" }, /doesn't create this coin/],
  ];
  for (const [name, opts, why] of cases) {
    const r = rig();
    const { res } = await challenge(r, {}, launchTx(opts));
    assert.equal(res.status, 403, `${name}: ${res.text}`);
    assert.match(res.body.error, why, name);
  }
  // Old school launches qualify too.
  const r = rig();
  assert.equal((await challenge(r, {}, launchTx({ platform: MAINNET.classicPlatform }))).res.status, 200);
  // An unknown signature, and a devnet RPC.
  const unknown = await r.call("POST", "/api/agents/challenge", { wallet: WALLET, mint: MINT2, launchSignature: "5".repeat(88), secretHash: "a".repeat(64) });
  assert.match(unknown.body.error, /doesn't know that launch signature/);
  const dev = rig();
  dev.rpc.genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  assert.equal((await challenge(dev)).res.body.code, "refused");
  // Malformed input never reaches the RPC.
  const bad = await r.call("POST", "/api/agents/challenge", { wallet: "nope", mint: MINT, launchSignature: "x", secretHash: "y" });
  assert.equal(bad.status, 400);
});

test("one challenge per wallet and coin at a time, so nobody can overwrite another's", async () => {
  const r = rig();
  assert.equal((await challenge(r)).res.status, 200);
  const second = await challenge(r);
  assert.equal(second.res.status, 409);
  r.clock.advance(601_000);
  assert.equal((await challenge(r)).res.status, 200, "after the first expires");
});

test("a stranger who sees the memo on-chain can't register with it: the secret stays with the signer", async () => {
  const r = rig();
  const { res, secret } = await challenge(r);
  const memo = r.rpc.add(memoTx(WALLET, res.body.memo, r.clock.now() + 10_000));
  const stolen = await r.call("POST", "/api/agents/register", { code: res.body.code, signature: memo, secret: randomHex(), adult: true });
  assert.equal(stolen.status, 401);
  // The real signer still can.
  assert.equal((await r.call("POST", "/api/agents/register", { code: res.body.code, signature: memo, secret, adult: true })).status, 200);
});

test("the memo must come from the wallet, carry this code, and land within 10 minutes", async () => {
  const cases: [string, (code: string, now: number) => ReturnType<typeof memoTx>, RegExp][] = [
    ["from another wallet", (c, now) => memoTx(OTHER, `highwire agent ${c}`, now), /another wallet/],
    ["another code", (_c, now) => memoTx(WALLET, "highwire agent aaaaaaaaaaaaaaaa", now), /doesn't carry this code/],
    ["failed", (c, now) => memoTx(WALLET, `highwire agent ${c}`, now, true), /failed/],
    ["too late", (c, now) => memoTx(WALLET, `highwire agent ${c}`, now + 11 * 60_000), /within 10 minutes/],
    ["before the challenge", (c, now) => memoTx(WALLET, `highwire agent ${c}`, now - 5 * 60_000), /within 10 minutes/],
  ];
  for (const [name, make, why] of cases) {
    const r = rig();
    const { res, secret } = await challenge(r);
    const memo = r.rpc.add(make(res.body.code, r.clock.now()));
    const reg = await r.call("POST", "/api/agents/register", { code: res.body.code, signature: memo, secret, adult: true });
    assert.equal(reg.status, 403, `${name}: ${reg.text}`);
    assert.match(reg.body.error, why, name);
  }
  // A memo the RPC doesn't have yet: try again later.
  const r = rig();
  const { res, secret } = await challenge(r);
  const notYet = await r.call("POST", "/api/agents/register", { code: res.body.code, signature: "4".repeat(88), secret, adult: true });
  assert.equal(notYet.status, 404);
  // An expired code.
  r.clock.advance(601_000);
  const memo = r.rpc.add(memoTx(WALLET, res.body.memo, r.clock.now()));
  assert.equal((await r.call("POST", "/api/agents/register", { code: res.body.code, signature: memo, secret, adult: true })).body.code, "expired");
});

test("registering again replaces the token at once, keeping the fighter's record", async () => {
  const r = rig();
  const first = await r.register();
  await r.call("POST", "/api/arena/join", { fallback: "zero" }, first);
  await r.call("POST", "/api/arena/retire", {}, first);
  const second = await r.register();
  assert.notEqual(first, second);
  assert.equal((await r.call("POST", "/api/arena/join", { fallback: "zero" }, first)).status, 401, "the old token is dead");
  const me = await r.call("GET", `/api/arena/fighter/${MINT}`);
  assert.equal(me.body.record.house.loss, 1, "the record survives");
  assert.equal((await r.call("POST", "/api/arena/join", { fallback: "zero" }, second)).status, 200);
});

test("the owner confirms they're 18 or older, and names can't pose as Highwire or the house", async () => {
  const r = rig();
  const { res, secret } = await challenge(r);
  const memo = r.rpc.add(memoTx(WALLET, res.body.memo, r.clock.now()));
  assert.equal((await r.call("POST", "/api/agents/register", { code: res.body.code, signature: memo, secret })).status, 400);
  for (const name of ["Highwire Official", "The Reader", "even"]) {
    const s = rig();
    s.coins.coins.get(MINT)!.name = name;
    await assert.rejects(s.register(), /house fighter's name|Highwire/, name);
  }
  const fine = rig();
  fine.coins.coins.get(MINT)!.name = "Seven Readers";
  assert.ok(await fine.register(), "names that merely contain the letters are fine");
});

test("an RPC or store that doesn't answer pauses registration rather than guessing", async () => {
  const r = rig();
  r.rpc.down = true;
  assert.equal((await challenge(r)).res.body.code, "paused");
  r.rpc.down = false;
  r.store.down = true;
  assert.equal((await challenge(r)).res.status, 503);
});
