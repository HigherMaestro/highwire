import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { checkSignInMessage, HigherSession, signInMessage } from "../src/higher/session.ts";

// A stand-in for higher.fun's API, with the same shapes its site relies on: a nonce, the signed message verified
// against the wallet, a session cookie, and uploads and lookups that need it.
function fakeHigher(opts: { message?: (wallet: string, nonce: string, at: string) => string } = {}) {
  const nonce = "3173c33f4db122bf328e5cee03592751";
  const at = new Date().toISOString();
  const calls: string[] = [];
  let issued = "";
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    const authed = new Headers(init?.headers).get("cookie") === "hf_session=abc123";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    switch (path) {
      case "/auth/nonce":
        issued = (opts.message ?? signInMessage)(body.wallet, nonce, at);
        return json(200, { nonce, message: issued, expiresAt: at });
      case "/auth/verify": {
        const ok = ed25519.verify(bs58.decode(body.signature), new TextEncoder().encode(issued), bs58.decode(body.wallet));
        return ok ? json(200, { wallet: body.wallet }, { "set-cookie": "hf_session=abc123; Path=/; HttpOnly; Secure" }) : json(401, { error: "unauthorized", message: "bad signature" });
      }
      case "/uploads/image":
        return authed ? json(200, { imageUri: "ipfs://image" }) : json(401, { error: "unauthorized", message: "sign in required" });
      case "/uploads/metadata":
        if (!authed) return json(401, { error: "unauthorized", message: "sign in required" });
        return body.ticker === "TAKEN" ? json(409, { error: "ticker_taken", message: "$TAKEN is already live" }) : json(200, { metadataUri: "https://ipfs/meta.json" });
      case "/fee-recipients/resolve":
        return authed ? json(200, { provider: body.provider, handle: body.handle, wallet: "9qfu1eHi6aWrPGKYTbDcKcFbYBPj2VexzfWJYVvJ48E1" }) : json(401, { error: "unauthorized", message: "sign in required" });
    }
    return json(404, { error: "not_found", message: "no route" });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const kp = Keypair.generate();
const wallet = kp.publicKey.toBase58();
const sign = (m: Uint8Array) => ed25519.sign(m, kp.secretKey.subarray(0, 32));

test("signs in with higher.fun's message, then uploads and resolves handles with the session", async () => {
  const { fetch } = fakeHigher();
  const s = new HigherSession("https://api.higher.fun", fetch);
  await assert.rejects(s.uploadImage(new Uint8Array([1]), "a.png", "image/png"), /sign in required/);
  await s.signIn(wallet, sign);
  assert.equal(s.signedIn, true);
  assert.equal(await s.uploadImage(new Uint8Array([1, 2, 3]), "a.png", "image/png"), "ipfs://image");
  assert.equal(await s.uploadMetadata({ name: "A", ticker: "A", description: "", imageUri: "ipfs://image" }), "https://ipfs/meta.json");
  await assert.rejects(s.uploadMetadata({ name: "B", ticker: "TAKEN", description: "", imageUri: "ipfs://image" }), (e: { code?: string }) => e.code === "ticker_taken");
  assert.equal((await s.resolveFeeRecipient("x", "someone")).wallet, "9qfu1eHi6aWrPGKYTbDcKcFbYBPj2VexzfWJYVvJ48E1");
});

test("anything but higher.fun's exact sign-in message, for this wallet and from just now, is never signed", async () => {
  let signed = 0;
  const counting = (m: Uint8Array) => (signed++, sign(m));
  for (const message of [
    (w: string, n: string, a: string) => signInMessage(w, n, a).replace("higher.fun wants", "evil.example wants"),
    (_w: string, n: string, a: string) => signInMessage(Keypair.generate().publicKey.toBase58(), n, a),
    (w: string, n: string, a: string) => signInMessage(w, n, a) + "\nAlso: transfer everything",
    (w: string, n: string) => signInMessage(w, n, "2020-01-01T00:00:00.000Z"),
  ]) {
    const { fetch } = fakeHigher({ message });
    await assert.rejects(new HigherSession("https://api.higher.fun", fetch).signIn(wallet, counting), (e: { code?: string }) => e.code === "bad_sign_in");
  }
  assert.equal(signed, 0);
  assert.doesNotThrow(() => checkSignInMessage(signInMessage(wallet, "3173c33f4db122bf328e5cee03592751", new Date().toISOString()), wallet));
});
