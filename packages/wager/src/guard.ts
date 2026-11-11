import { Buffer } from "buffer";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { formatLamports, PROGRAMS, resolveInstructions, UnsafeTransactionError, type Cluster, type CompiledIx, type Envelope, type ProgramGuard } from "highwire-core";
import { decodeEd25519, decodeWager, ED25519_PROGRAM_ID, INCINERATOR, seriesAddress, ticketMessage, wagerConfigAddress, wagerProgram, type WagerKind, type WagerTicket } from "./codec.ts";

// The wager program's safety checks and plain-language decoding, as a guard for highwire-core's assertSafe and
// describeTransaction (docs/boundaries.md 5.2). Core knows nothing of the wager program: without this guard its
// instructions, and the Ed25519 ticket check an open or accept carries, are outside the allow-list and refused. The
// checks are the ones decode.ts held, word for word: one wager instruction of the expected kind, for the expected
// series, signed by the wallet, with exactly the accounts Highwire builds; for open and accept, immediately after the
// Ed25519 check of exactly this ticket by the matchmaker's key.

/**
 * What a wager transaction must be: this instruction, for this series; for `open` and `accept`, this ticket signed by
 * this key. The builders set it (tx.ts); nothing else does.
 */
export interface WagerExpectation {
  kind: WagerKind;
  seriesId: string;
  ticket?: WagerTicket;
  ticketKey?: PublicKey;
}

/** Which of a wager instruction's accounts is the series, by its kind. */
const seriesIndex = (kind: string) => (kind === "open" || kind === "accept" || kind === "cancel" ? 2 : kind === "timeout" || kind === "settle" || kind === "emergencyRefund" ? 0 : 1);

/** A wager-program or ticket-check instruction in plain language, or null for one this doesn't recognise. */
export function describeWager(ix: CompiledIx, cluster: Cluster): string | null {
  const program = ix.programId.toBase58();
  if (program === ED25519_PROGRAM_ID) {
    const e = decodeEd25519(ix.data);
    return e ? `Check the matchmaker's signature (key ${e.key}) on a wager ticket for The Line` : null;
  }
  if (program !== wagerProgram(cluster)?.toBase58()) return null;
  const wg = decodeWager(ix.data);
  if (!wg) return null;
  const series = ix.keys[seriesIndex(wg.kind)]?.toBase58() ?? "?";
  const text: Record<string, string> = {
    open: wg.kind === "open" ? `Stake ${formatLamports(wg.stake)} SOL and open a best-of-5 wager series on The Line against ${wg.playerB} (series account ${series})` : "",
    accept: `Stake the series' amount and accept wager series ${series} on The Line`,
    cancel: `Cancel wager series ${series}, which was never accepted, refunding its opener`,
    commit: wg.kind === "commit" ? `Commit a hidden move for round ${wg.round} of wager series ${series}` : "",
    reveal: wg.kind === "reveal" ? `Reveal a pull of ${wg.pull} in wager series ${series}` : "",
    revealFallback: `Reveal this player's fallback in wager series ${series}`,
    timeout: `Apply a passed deadline in wager series ${series}`,
    settle: `Settle wager series ${series}: pay the winner (less the fee) or refund both`,
    retire: `Retire from wager series ${series}, conceding it and its stake`,
    emergencyRefund: `Refund both stakes of wager series ${series}, idle for 24 hours`,
  };
  return text[wg.kind] || null;
}

/** The programs the guard answers for: the wager program on this cluster, and the Ed25519 program its tickets use. */
const guarded = (cluster: Cluster): string[] => {
  const id = wagerProgram(cluster);
  return id ? [ED25519_PROGRAM_ID, id.toBase58()] : [];
};

/**
 * The guard for one wager transaction. With no expectation it only describes: every wager or ticket-check instruction
 * is refused, which is what a caller that didn't build the transaction should get.
 */
export function wagerGuard(wx?: WagerExpectation): ProgramGuard {
  return {
    programs: guarded,
    describe: describeWager,
    check({ cluster, wallet, required, instructions: ixs, fail }) {
      const wagerId = wagerProgram(cluster);
      const w = wallet.toBase58();
      let wagers = 0;
      let ticketChecks = 0;
      return {
        instruction(i, ix) {
          const p = ix.programId.toBase58();
          const d = ix.data;
          const key = (n: number) => ix.keys[n] ?? fail(`instruction ${i + 1} is missing account ${n}`);
          if (p === ED25519_PROGRAM_ID) {
            if (!wx || !wagerId || (wx.kind !== "open" && wx.kind !== "accept") || !wx.ticket || !wx.ticketKey) {
              return fail(`instruction ${i + 1}: an Ed25519 check, which only a wager's open or accept carries`);
            }
            const e = decodeEd25519(d);
            if (!e) return fail(`instruction ${i + 1}: an Ed25519 check that isn't exactly one signature inside itself`);
            if (e.key !== wx.ticketKey.toBase58()) fail(`instruction ${i + 1}: the ticket isn't signed by the matchmaker's key`);
            if (!e.message.equals(ticketMessage(wagerId, wx.ticket))) fail(`instruction ${i + 1}: the ticket isn't this series' ticket`);
            if (ixs[i + 1]?.programId.equals(wagerId) !== true) fail(`instruction ${i + 1}: the ticket check isn't immediately before the wager`);
            if (++ticketChecks > 1) fail(`instruction ${i + 1}: more than one ticket check`);
            return;
          }
          if (!wagerId || p !== wagerId.toBase58()) return fail(`instruction ${i + 1} calls a program outside the allow-list: ${p}`);
          if (!wx) return fail(`instruction ${i + 1}: a wager on The Line, which only the local signer's wagers make`);
          const wg = decodeWager(d);
          if (!wg || wg.kind !== wx.kind) return fail(`instruction ${i + 1}: not the wager instruction this flow builds`);
          const series = seriesAddress(wagerId, wx.seriesId);
          const config = wagerConfigAddress(wagerId);
          const at = (n: number, want: PublicKey, what: string) => {
            if (!key(n).equals(want)) fail(`instruction ${i + 1}: the wager's ${what} isn't the expected one`);
          };
          const signedByWallet = (n: number) => {
            at(n, wallet, "player");
            if (!required.some((s) => s.equals(wallet))) fail(`instruction ${i + 1}: the wallet doesn't sign the wager`);
          };
          const burns = () => at(ix.keys.length - 1, new PublicKey(INCINERATOR), "burn account");
          switch (wg.kind) {
            case "open":
            case "accept":
              signedByWallet(0);
              at(1, config, "config");
              at(2, series, "series account");
              at(3, new PublicKey("Sysvar1nstructions1111111111111111111111111"), "instructions sysvar");
              at(4, new PublicKey(PROGRAMS.system), "system program");
              if (ix.keys.length !== 5) fail(`instruction ${i + 1}: a wager with unexpected accounts`);
              if (ticketChecks !== 1) fail(`instruction ${i + 1}: an ${wg.kind} without its ticket check just before it`);
              if (wg.kind === "accept" && wx.ticket && (wx.ticket.playerB !== w || wx.ticket.playerA === w)) fail(`instruction ${i + 1}: the ticket isn't for this wallet to accept`);
              if (wg.kind === "open") {
                const t = wx.ticket;
                if (!t) return fail(`instruction ${i + 1}: an open without its ticket`);
                if (wg.seriesId !== t.seriesId || wg.playerB !== t.playerB || wg.stake !== t.stake || wg.acceptDeadline !== t.acceptDeadline || wg.expiry !== t.expiry || wg.keyId !== t.keyId) {
                  fail(`instruction ${i + 1}: the open doesn't match its ticket`);
                }
                if (t.playerA !== w || t.playerB === w) fail(`instruction ${i + 1}: the ticket isn't for this wallet against another`);
              }
              break;
            case "cancel":
              signedByWallet(0);
              at(1, config, "config");
              at(2, series, "series account");
              if (ix.keys.length !== 5) fail(`instruction ${i + 1}: a cancel with unexpected accounts`);
              burns();
              break;
            case "commit":
            case "reveal":
            case "revealFallback":
            case "retire":
              signedByWallet(0);
              at(1, series, "series account");
              if (ix.keys.length !== 2) fail(`instruction ${i + 1}: a wager move with unexpected accounts`);
              break;
            case "timeout":
              at(0, series, "series account");
              if (ix.keys.length !== 1) fail(`instruction ${i + 1}: a timeout with unexpected accounts`);
              break;
            case "settle":
            case "emergencyRefund":
              // The program pays only the players and fee account recorded at open; these are just where it looks.
              at(0, series, "series account");
              at(1, config, "config");
              if (ix.keys.length !== (wg.kind === "settle" ? 6 : 5)) fail(`instruction ${i + 1}: a ${wg.kind} with unexpected accounts`);
              burns();
              break;
            default:
              fail(`instruction ${i + 1}: a wager instruction Highwire never builds`);
          }
          if (++wagers > 1) fail(`instruction ${i + 1}: more than one wager instruction`);
        },
        finish() {
          if (wx && wagers !== 1) fail("a wager must carry its instruction exactly once");
        },
      };
    },
  };
}

/** What a wager envelope does, read from its bytes: one transaction, one wager instruction. */
export function wagerFacts(env: Envelope, cluster: Cluster): { kind: string; series: string; stake?: bigint } {
  if (env.transactions.length !== 1) throw new UnsafeTransactionError("a wager is exactly one transaction");
  const id = wagerProgram(cluster)?.toBase58();
  const found: { kind: string; series: string; stake?: bigint }[] = [];
  for (const ix of resolveInstructions(VersionedTransaction.deserialize(Buffer.from(env.transactions[0]!.base64, "base64")))) {
    if (id === undefined || ix.programId.toBase58() !== id) continue;
    const wg = decodeWager(ix.data);
    if (wg) found.push({ kind: wg.kind, series: ix.keys[seriesIndex(wg.kind)]?.toBase58() ?? "?", ...(wg.kind === "open" ? { stake: wg.stake } : {}) });
  }
  if (found.length !== 1) throw new UnsafeTransactionError("the transaction doesn't carry exactly one wager instruction");
  return found[0]!;
}
