import { CLUSTERS } from "../higher/constants.ts";
import { ValidationError } from "../lib/errors.ts";
import { ENVELOPE_FORMATS, type Envelope, type EnvelopeFormat, type UnsignedTransaction } from "./format.ts";

// Sign links: https://highwire.fun/sign#<payload>, where the payload is the
// unsigned-transaction envelope as compact JSON, then base64url. A payload
// that would push the URL past SIGN_URL_GZIP_THRESHOLD characters is gzipped
// first and marked with the "gz." prefix. The envelope rides in the fragment,
// which browsers never send to the server.
//
// Browser-safe: web APIs only (TextEncoder, btoa/atob, CompressionStream), which
// Node 20 has too.

export const DEFAULT_SITE_URL = "https://highwire.fun";
export const SIGN_PATH = "/sign";
/** Marks a gzipped payload. Base64url never contains ".", so a plain payload can't start with it. */
export const GZIP_PREFIX = "gz.";
/** Sign URLs longer than this (about 8 KB) carry a gzipped payload instead. */
export const SIGN_URL_GZIP_THRESHOLD = 8000;
/** Larger payloads are refused before decoding, and larger envelopes after decompressing. */
export const MAX_PAYLOAD_CHARS = 64 * 1024;
export const MAX_ENVELOPE_BYTES = 256 * 1024;
/** The most transactions one envelope may carry. */
export const MAX_ENVELOPE_TRANSACTIONS = 8;

const utf8 = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new ValidationError("the sign link's payload isn't base64url");
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new ValidationError("the sign link's payload isn't base64url");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new ValidationError("the sign link's envelope is too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export const gzip = (bytes: Uint8Array) => pipe(bytes, new CompressionStream("gzip"));
export const gunzip = (bytes: Uint8Array, limit = MAX_ENVELOPE_BYTES) => pipe(bytes, new DecompressionStream("gzip"), limit);

/** The URL fragment for an envelope: plain base64url, or gzipped when `compress` is set. */
export async function encodeSignPayload(env: Envelope, opts: { compress?: boolean } = {}): Promise<string> {
  const json = utf8.encode(JSON.stringify(env));
  return opts.compress ? GZIP_PREFIX + toBase64Url(await gzip(json)) : toBase64Url(json);
}

/** The sign page's origin with no trailing slash. */
export function siteOrigin(siteUrl: string = DEFAULT_SITE_URL): string {
  return siteUrl.replace(/\/+$/, "");
}

/**
 * `https://highwire.fun/sign#<payload>` for an envelope. The payload is gzipped only when the plain one would make the
 * URL longer than SIGN_URL_GZIP_THRESHOLD.
 */
export async function signUrl(env: Envelope, siteUrl: string = DEFAULT_SITE_URL): Promise<string> {
  if (env.kind === "transfer") throw new Error("transfers to other wallets get no sign link");
  const base = `${siteOrigin(siteUrl)}${SIGN_PATH}#`;
  const plain = await encodeSignPayload(env);
  if (base.length + plain.length <= SIGN_URL_GZIP_THRESHOLD) return base + plain;
  return base + (await encodeSignPayload(env, { compress: true }));
}

/** Reads an envelope back from a sign link's fragment (with or without the leading "#"), and checks its shape. */
export async function decodeSignPayload(fragment: string): Promise<Envelope> {
  const payload = fragment.replace(/^#/, "").trim();
  if (!payload) throw new ValidationError("the sign link has no transaction in it");
  if (payload.length > MAX_PAYLOAD_CHARS) throw new ValidationError("the sign link is too long");
  const compressed = payload.startsWith(GZIP_PREFIX);
  let bytes = fromBase64Url(compressed ? payload.slice(GZIP_PREFIX.length) : payload);
  if (compressed) {
    try {
      bytes = await gunzip(bytes);
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError("the sign link's payload doesn't decompress");
    }
  } else if (bytes.length > MAX_ENVELOPE_BYTES) throw new ValidationError("the sign link's envelope is too large");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ValidationError("the sign link's payload isn't a JSON envelope");
  }
  return parseEnvelope(json);
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Checks an untrusted value is a well-formed envelope. It says nothing about whether the transactions are safe. */
export function parseEnvelope(v: unknown): Envelope {
  const bad = (what: string): never => {
    throw new ValidationError(`not a Highwire envelope: ${what}`);
  };
  const obj = (x: unknown, what: string) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : bad(what));
  const str = (x: unknown, what: string, max = 200) => (typeof x === "string" && x.length <= max ? x : bad(what));
  const int = (x: unknown, what: string) => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : bad(what));
  const addr = (x: unknown, what: string) => (typeof x === "string" && BASE58.test(x) ? x : bad(what));
  const list = <T>(x: unknown, what: string, each: (y: unknown) => T, max = 64): T[] =>
    Array.isArray(x) && x.length <= max ? x.map(each) : bad(what);

  const e = obj(v, "expected an object");
  if (!(ENVELOPE_FORMATS as readonly unknown[]).includes(e.format)) bad(`format must be one of ${ENVELOPE_FORMATS.join(", ")}`);
  const v1 = e.format === ENVELOPE_FORMATS[0];
  if (!(CLUSTERS as readonly unknown[]).includes(e.cluster)) bad("unknown cluster");
  // Transfers to other wallets are only ever signed by the user's local signer, inside their allowlist: a sign link
  // anyone can send is no place for one.
  if (e.kind === "transfer") bad("this page never signs transfers to other wallets");
  if (!["trade", "launch", "claim"].includes(e.kind as string)) bad("unknown kind");
  const wallet = addr(e.wallet, "wallet");
  const txs = list(e.transactions, "transactions", (t) => t, MAX_ENVELOPE_TRANSACTIONS);
  if (txs.length === 0) bad("no transactions");
  const transactions: UnsignedTransaction[] = txs.map((raw, i) => {
    const t = obj(raw, `transaction ${i + 1}`);
    if (t.index !== i) bad(`transaction ${i + 1} is out of order`);
    const base64 = str(t.base64, `transaction ${i + 1} bytes`, 4096);
    if (!BASE64.test(base64)) bad(`transaction ${i + 1} bytes aren't base64`);
    if (t.encoding !== "base64" || t.version !== 0) bad(`transaction ${i + 1} must be a base64 v0 transaction`);
    const sim = obj(t.simulation, `transaction ${i + 1} simulation`);
    return {
      index: i,
      label: str(t.label, `transaction ${i + 1} label`),
      base64,
      encoding: "base64",
      version: 0,
      feePayer: addr(t.feePayer, `transaction ${i + 1} fee payer`),
      signers: list(t.signers, `transaction ${i + 1} signers`, (s) => addr(s, "signer")),
      presigned: list(t.presigned, `transaction ${i + 1} presigned`, (s) => addr(s, "presigned signer")),
      walletSigner: addr(t.walletSigner, `transaction ${i + 1} wallet signer`),
      recentBlockhash: addr(t.recentBlockhash, `transaction ${i + 1} blockhash`),
      lastValidBlockHeight: int(t.lastValidBlockHeight, `transaction ${i + 1} expiry`),
      dependsOn: list(t.dependsOn, `transaction ${i + 1} dependsOn`, (d) => {
        const n = int(d, "dependsOn");
        return n < i ? n : bad(`transaction ${i + 1} depends on a later one`);
      }),
      summary: list(t.summary, `transaction ${i + 1} summary`, (s) => str(s, "summary line", 1000)),
      fullyDecoded: t.fullyDecoded === true,
      simulation: {
        ok: sim.ok === true,
        ...(typeof sim.skipped === "string" ? { skipped: sim.skipped.slice(0, 200) } : {}),
        ...(typeof sim.unitsConsumed === "number" ? { unitsConsumed: sim.unitsConsumed } : {}),
        ...(typeof sim.error === "string" ? { error: sim.error.slice(0, 300) } : {}),
      },
    };
  });
  return {
    format: e.format as EnvelopeFormat,
    cluster: e.cluster as Envelope["cluster"],
    wallet,
    kind: e.kind as Envelope["kind"],
    transactions,
    expiresAfterBlockHeight: int(e.expiresAfterBlockHeight, "expiresAfterBlockHeight"),
    // v1 has no builtAt, which keeps its transactions strict.
    ...(v1 ? {} : { builtAt: int(e.builtAt, "builtAt") }),
    howToSign: typeof e.howToSign === "string" ? e.howToSign.slice(0, 1000) : "",
  };
}
