import { Buffer } from "buffer";
import { ed25519 } from "@noble/curves/ed25519";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { Attestation, Envelope } from "./format.ts";

// A sign link can be edited by anyone, its builtAt included, so the sign page can't tell an old link from a new one by
// what the link says. The hosted server signs each envelope it builds: its cluster, wallet, kind, builtAt and the
// exact bytes of each transaction's message. The sign page knows the hosted server's public key (it's baked in at
// build time), so it can tell a link highwire.fun built, unchanged, from one built elsewhere or edited.
//
// Browser-safe: web3.js and @noble only.

const LABEL = "highwire sign-link attestation v1";

/**
 * The signing key's 32-byte seed, derived from a server secret (HIGHWIRE_LAUNCH_SECRET), so no new secret is needed.
 * apps/web/next.config.ts derives the public half the same way at build time: keep the two in step.
 */
export function attestationSeed(secret: string): Uint8Array {
  return hmac(sha256, new TextEncoder().encode(secret), new TextEncoder().encode(LABEL));
}

/** The public key, base58, that verifies links signed with `seed`. */
export function attestationPublicKey(seed: Uint8Array): string {
  return new PublicKey(ed25519.getPublicKey(seed)).toBase58();
}

function digest(env: Envelope): Uint8Array {
  const parts: Uint8Array[] = [new TextEncoder().encode(`${LABEL}|${env.cluster}|${env.wallet}|${env.kind}|${env.builtAt ?? ""}|${env.transactions.length}`)];
  for (const t of env.transactions) {
    const tx = VersionedTransaction.deserialize(Buffer.from(t.base64, "base64"));
    parts.push(sha256(tx.message.serialize()));
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return sha256(all);
}

/** The envelope with its attestation added. */
export function attestEnvelope(env: Envelope, seed: Uint8Array): Envelope {
  const attestation: Attestation = {
    key: attestationPublicKey(seed),
    sig: Buffer.from(ed25519.sign(digest(env), seed)).toString("base64"),
  };
  return { ...env, attestation };
}

/**
 * "verified": signed by `trustedKey` and unchanged since. "unverified": no attestation, or one by another key (a local
 * Highwire server signs with its own). "invalid": it claims the trusted key but doesn't match the envelope, so something
 * in it was changed after it was built.
 */
export function verifyAttestation(env: Envelope, trustedKey: string | undefined): "verified" | "unverified" | "invalid" {
  const a = env.attestation;
  if (!a || !trustedKey || a.key !== trustedKey) return "unverified";
  try {
    const ok = ed25519.verify(Buffer.from(a.sig, "base64"), digest(env), new PublicKey(trustedKey).toBytes());
    return ok ? "verified" : "invalid";
  } catch {
    return "invalid";
  }
}
