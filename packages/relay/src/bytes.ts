import bs58 from "bs58";
import { fail } from "./errors.ts";

// Bytes for the messages the desks sign (a ticket, a result): little-endian numbers, addresses, hex.

export const le = (n: bigint, bytes: number) => {
  const out = new Uint8Array(bytes);
  let v = BigInt.asUintN(bytes * 8, n);
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(v & 255n);
    v >>= 8n;
  }
  return out;
};
export const key32 = (k: string) => {
  const b = bs58.decode(k);
  if (b.length !== 32) fail("bad_request", "not a 32-byte address");
  return b;
};
export const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The parts of a message, end to end. */
export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
