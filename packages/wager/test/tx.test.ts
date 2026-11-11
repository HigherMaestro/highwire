import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { WAGER_PROGRAM_IDS } from "../src/codec.ts";
import { closingEvent, seriesOutcome } from "../src/tx.ts";

// Reading a closed series from the chain (the builders and the signer's side are in agent.test.ts and tools.test.ts).

const file = JSON.parse(readFileSync(new URL("../../core/test/fixtures/wager-codec.json", import.meta.url), "utf8"));
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const h = (b: number) => b.toString(16).padStart(2, "0").repeat(32);

test("a series' outcome is the program's own closing event for it, and nothing else", async () => {
  const P = WAGER_PROGRAM_IDS.devnet!;
  const id = h(0x11);
  const b64 = (b: Uint8Array | string) => Buffer.from(b).toString("base64");
  const data = (kind: number, series: string, outcome: number) => `Program data: ${b64("line-wager")} ${b64(Uint8Array.of(kind))} ${b64(Buffer.from(series, "hex"))} ${b64(Uint8Array.of(outcome))}`;
  const frame = (program: string, inner: string[], depth = 1) => [`Program ${program} invoke [${depth}]`, ...inner, `Program ${program} consumed 5000 of 200000 compute units`, `Program ${program} success`];
  const other = "Evi1Program11111111111111111111111111111111";
  // A settle to B, as the program logs it.
  assert.deepEqual(closingEvent(frame(P, [data(1, id, 1)]), P, id), { state: "closed", how: "settled", winner: "B" });
  assert.deepEqual(closingEvent(frame(P, [data(1, id, 2)]), P, id), { state: "closed", how: "settled", winner: null });
  assert.deepEqual(closingEvent(frame(P, [data(2, id, 255)]), P, id), { state: "closed", how: "cancelled" });
  assert.deepEqual(closingEvent(frame(P, [data(3, id, 255)]), P, id), { state: "closed", how: "refunded" });
  // Made through another program: the program's own frame, one level down, still counts.
  assert.deepEqual(closingEvent(frame(other, frame(P, [data(1, id, 0)], 2)), P, id), { state: "closed", how: "settled", winner: "A" });
  // Forged by another program (its frame, even after the real program's frame closed), or for another series: ignored.
  assert.equal(closingEvent(frame(other, [data(1, id, 0)]), P, id), null);
  assert.equal(closingEvent([...frame(P, []), data(1, id, 0)], P, id), null);
  assert.equal(closingEvent(frame(P, [data(1, h(0x22), 0)]), P, id), null);
  assert.equal(closingEvent(frame(P, [`Program log: ${data(1, id, 0)}`]), P, id), null);
  // A truncated log reads as nothing found, never as a guess.
  assert.equal(closingEvent(["Log truncated", ...frame(P, [data(1, id, 0)])], P, id), null);

  // seriesOutcome: the account while it plays; then the event, past unrelated transactions that name the address.
  const chain = (opts: { account?: Buffer; history?: string[][] }) =>
    ({
      cluster: "devnet",
      connection: {
        getAccountInfo: async () => (opts.account ? { data: opts.account, owner: new PublicKey(P) } : null),
        getSignaturesForAddress: async () => (opts.history ?? []).map((_, i) => ({ signature: `s${i}`, err: null })),
        getTransaction: async (sig: string) => ({ meta: { logMessages: opts.history![Number(sig.slice(1))] } }),
      },
    }) as never;
  assert.deepEqual(await seriesOutcome(chain({ account: Buffer.from(file.seriesAccount, "hex") }), id), { state: "live" });
  const noise = Array.from({ length: 30 }, () => frame("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", ["Program log: Memo"]));
  assert.deepEqual(await seriesOutcome(chain({ history: [...noise, frame(P, [data(1, id, 0)])] }), id), { state: "closed", how: "settled", winner: "A" });
  assert.deepEqual(await seriesOutcome(chain({ history: noise }), id), { state: "none" });
  assert.deepEqual(await seriesOutcome(chain({}), id), { state: "none" });
});
