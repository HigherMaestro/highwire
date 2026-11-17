import { Buffer } from "buffer";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { formatLamports, PROGRAMS, resolveInstructions, UnsafeTransactionError, type CompiledIx, type Envelope, type ProgramGuard } from "highwire-core";
import { decodeEd25519, ED25519_PROGRAM_ID, INCINERATOR } from "./codec.ts";
import { decodeLinkWager, LINK_TICKET_DOMAIN, linkBattleAddress, linkConfigAddress, linkResultMessage, linkTicketMessage, type LinkResult, type LinkTicket, type LinkWagerKind } from "./link-codec.ts";

// Link battles' practice-stake program's safety checks and plain-language decoding, as a guard for highwire-core's
// assertSafe and describeTransaction (docs/boundaries.md 5.2, docs/link-wager.md 4). Core knows nothing of the
// program: without this guard its instructions, and the Ed25519 check a stake or a settle carries, are outside the
// allow-list and refused. With it, a transaction may carry exactly one of the program's instructions, of the expected
// kind, for the expected battle, with exactly the accounts Highwire builds; a stake immediately after the Ed25519 check
// of exactly this ticket by the desk's key, a settle immediately after the check of exactly this result by the
// referee's.
//
// The program's address is handed in, in code, by whoever builds the transaction (link-tx.ts takes it from the codec's
// table; tests and the local rehearsal pass their own). Nothing reads one from the environment.

/** What a link-wager transaction must be: this instruction, for this battle, with this ticket or this result. */
export interface LinkWagerExpectation {
  kind: Extract<LinkWagerKind, "open" | "accept" | "cancel" | "settle" | "refund">;
  battleId: string;
  /** For open and accept: the desk's ticket and its key. */
  ticket?: LinkTicket;
  ticketKey?: PublicKey;
  /** For settle: the referee's result and its key. */
  result?: LinkResult;
  resultKey?: PublicKey;
  /** For settle, cancel and refund: the battle's two wallets, as the chain records them: the only accounts it pays. */
  parties?: { playerA: PublicKey; playerB: PublicKey };
}

/** Which of an instruction's accounts is the battle, by its kind. */
const battleIndex = (kind: string) => (kind === "open" || kind === "accept" || kind === "cancel" || kind === "freezeAndRefund" ? 2 : 0);

const OUTCOME_TEXT = { a: "paying player A both stakes", b: "paying player B both stakes", draw: "a draw, refunding both", void: "a void, refunding both" } as const;

/** One of the program's instructions, or the Ed25519 check it carries, in plain language; null for anything else. */
export function describeLinkWager(program: PublicKey, ix: CompiledIx): string | null {
  const p = ix.programId.toBase58();
  if (p === ED25519_PROGRAM_ID) {
    const e = decodeEd25519(ix.data);
    return e ? `Check a signature (key ${e.key}) on a link battle's stake ticket or result` : null;
  }
  if (p !== program.toBase58()) return null;
  const wg = decodeLinkWager(ix.data);
  if (!wg) return null;
  const battle = ix.keys[battleIndex(wg.kind)]?.toBase58() ?? "?";
  switch (wg.kind) {
    case "open":
      return `Stake ${formatLamports(wg.stake)} SOL on a link battle against ${wg.playerB} (battle account ${battle})`;
    case "accept":
      return `Stake the battle's amount and accept staked link battle ${battle}`;
    case "cancel":
      return `Cancel staked link battle ${battle}, which was never accepted, refunding its opener`;
    case "settle":
      return `Settle staked link battle ${battle} on the referee's result: ${OUTCOME_TEXT[wg.outcome]}`;
    case "refund":
      return `Refund both stakes of link battle ${battle}, which has had no result`;
    default:
      return null;
  }
}

/**
 * The guard for one link-wager transaction. With no expectation it only describes: every instruction of the program,
 * and every Ed25519 check, is refused, which is what a caller that didn't build the transaction should get.
 */
export function linkWagerGuard(program: PublicKey, wx?: LinkWagerExpectation): ProgramGuard {
  const id = program.toBase58();
  return {
    programs: () => [ED25519_PROGRAM_ID, id],
    describe: (ix) => describeLinkWager(program, ix),
    check({ wallet, required, instructions: ixs, fail }) {
      const w = wallet.toBase58();
      let wagers = 0;
      let checks = 0;
      const stake = wx?.kind === "open" || wx?.kind === "accept";
      return {
        instruction(i, ix) {
          const p = ix.programId.toBase58();
          const key = (n: number) => ix.keys[n] ?? fail(`instruction ${i + 1} is missing account ${n}`);
          if (p === ED25519_PROGRAM_ID) {
            const e = decodeEd25519(ix.data);
            if (!e) return fail(`instruction ${i + 1}: an Ed25519 check that isn't exactly one signature inside itself`);
            if (ix.keys.length !== 0) fail(`instruction ${i + 1}: an Ed25519 check takes no accounts`);
            if (stake && wx?.ticket && wx.ticketKey) {
              if (e.key !== wx.ticketKey.toBase58()) fail(`instruction ${i + 1}: the ticket isn't signed by the desk's key`);
              if (!e.message.equals(linkTicketMessage(program, wx.ticket))) fail(`instruction ${i + 1}: the ticket isn't this battle's ticket`);
            } else if (wx?.kind === "settle" && wx.result && wx.resultKey) {
              if (e.key !== wx.resultKey.toBase58()) fail(`instruction ${i + 1}: the result isn't signed by the referee's key`);
              if (!e.message.equals(linkResultMessage(program, wx.result))) fail(`instruction ${i + 1}: the result isn't this battle's result`);
            } else {
              return fail(`instruction ${i + 1}: an Ed25519 check, which only a link battle's stake or settle carries`);
            }
            if (ixs[i + 1]?.programId.equals(program) !== true) fail(`instruction ${i + 1}: the signature check isn't immediately before the instruction it's for`);
            if (++checks > 1) fail(`instruction ${i + 1}: more than one signature check`);
            return;
          }
          if (p !== id) return fail(`instruction ${i + 1} calls a program outside the allow-list: ${p}`);
          if (!wx) return fail(`instruction ${i + 1}: a stake on a link battle, which only the local signer's stakes make`);
          const wg = decodeLinkWager(ix.data);
          if (!wg || wg.kind !== wx.kind) return fail(`instruction ${i + 1}: not the link-wager instruction this flow builds`);
          const battle = linkBattleAddress(program, wx.battleId);
          const config = linkConfigAddress(program);
          const at = (n: number, want: PublicKey, what: string) => {
            if (!key(n).equals(want)) fail(`instruction ${i + 1}: the ${what} isn't the expected one`);
          };
          const signedByWallet = (n: number) => {
            at(n, wallet, "player");
            if (!required.some((s) => s.equals(wallet))) fail(`instruction ${i + 1}: the wallet doesn't sign the stake`);
          };
          const burns = () => at(ix.keys.length - 1, new PublicKey(INCINERATOR), "burn account");
          const sysvar = new PublicKey("Sysvar1nstructions1111111111111111111111111");
          switch (wg.kind) {
            case "open":
            case "accept": {
              signedByWallet(0);
              at(1, config, "config");
              at(2, battle, "battle account");
              at(3, sysvar, "instructions sysvar");
              at(4, new PublicKey(PROGRAMS.system), "system program");
              if (ix.keys.length !== 5) fail(`instruction ${i + 1}: a stake with unexpected accounts`);
              if (checks !== 1) fail(`instruction ${i + 1}: a stake without its ticket check just before it`);
              const t = wx.ticket;
              if (!t) return fail(`instruction ${i + 1}: a stake without its ticket`);
              if (t.battleId !== wx.battleId) fail(`instruction ${i + 1}: the ticket is for another battle`);
              if (wg.kind === "open") {
                if (wg.battleId !== t.battleId || wg.playerB !== t.playerB || wg.stake !== t.stake || wg.acceptDeadline !== t.acceptDeadline || wg.expiry !== t.expiry || wg.keyId !== t.keyId) fail(`instruction ${i + 1}: the open doesn't match its ticket`);
                if (t.playerA !== w || t.playerB === w) fail(`instruction ${i + 1}: the ticket isn't for this wallet against another`);
              } else if (t.playerB !== w || t.playerA === w) fail(`instruction ${i + 1}: the ticket isn't for this wallet to accept`);
              break;
            }
            case "cancel":
              signedByWallet(0);
              at(1, config, "config");
              at(2, battle, "battle account");
              if (ix.keys.length !== 5) fail(`instruction ${i + 1}: a cancel with unexpected accounts`);
              if (!wx.parties) return fail(`instruction ${i + 1}: a cancel without the battle's wallets`);
              at(3, wx.parties.playerA, "opener's wallet");
              burns();
              break;
            case "settle": {
              // The program pays only the two wallets recorded when the battle was staked; these are just where it looks.
              at(0, battle, "battle account");
              at(1, config, "config");
              at(4, sysvar, "instructions sysvar");
              if (ix.keys.length !== 6) fail(`instruction ${i + 1}: a settle with unexpected accounts`);
              burns();
              if (checks !== 1) fail(`instruction ${i + 1}: a settle without its result check just before it`);
              const r = wx.result;
              if (!r) return fail(`instruction ${i + 1}: a settle without its result`);
              if (r.battleId !== wx.battleId) fail(`instruction ${i + 1}: the result is for another battle`);
              if (wg.outcome !== r.outcome || wg.keyId !== r.keyId) fail(`instruction ${i + 1}: the settle doesn't match its result`);
              if (!key(2).equals(new PublicKey(r.playerA)) || !key(3).equals(new PublicKey(r.playerB))) fail(`instruction ${i + 1}: the settle names other players than its result`);
              if (wx.parties && (!key(2).equals(wx.parties.playerA) || !key(3).equals(wx.parties.playerB))) fail(`instruction ${i + 1}: the settle names other players than the battle's`);
              break;
            }
            case "refund":
              at(0, battle, "battle account");
              at(1, config, "config");
              if (ix.keys.length !== 5) fail(`instruction ${i + 1}: a refund with unexpected accounts`);
              if (!wx.parties) return fail(`instruction ${i + 1}: a refund without the battle's wallets`);
              at(2, wx.parties.playerA, "opener's wallet");
              at(3, wx.parties.playerB, "second wallet");
              burns();
              break;
            default:
              fail(`instruction ${i + 1}: a link-wager instruction Highwire never builds`);
          }
          if (++wagers > 1) fail(`instruction ${i + 1}: more than one link-wager instruction`);
        },
        finish() {
          if (wx && wagers !== 1) fail("a stake on a link battle must carry its instruction exactly once");
          if (wx && checks !== (stake || wx.kind === "settle" ? 1 : 0)) fail("a signature check with no instruction to carry it for");
        },
      };
    },
  };
}

/** Where the stake sits in a ticket's message: after the domain, the program and the battle's id and two wallets. */
const TICKET_STAKE_OFFSET = LINK_TICKET_DOMAIN.length + 32 * 4;
const TICKET_LENGTH = TICKET_STAKE_OFFSET + 8 + 8 + 8 + 2;

/**
 * What a link-wager envelope does, read from its bytes: one transaction, one of the program's instructions. A stake's
 * amount comes from the bytes too: an open's from its own data, an accept's from the ticket in the Ed25519 check just
 * before it, which the program requires to be the battle's own ticket (so the amount it names is the amount that
 * moves). Nothing here asks an RPC.
 */
export function linkWagerFacts(env: Envelope, program: PublicKey): { kind: string; battle: string; stake?: bigint } | null {
  if (env.transactions.length !== 1) throw new UnsafeTransactionError("a stake on a link battle is exactly one transaction");
  const found: { kind: string; battle: string; stake?: bigint }[] = [];
  const ixs = resolveInstructions(VersionedTransaction.deserialize(Buffer.from(env.transactions[0]!.base64, "base64")));
  for (const [i, ix] of ixs.entries()) {
    if (!ix.programId.equals(program)) continue;
    const wg = decodeLinkWager(ix.data);
    if (!wg) continue;
    let stake: bigint | undefined;
    if (wg.kind === "open") stake = wg.stake;
    else if (wg.kind === "accept") {
      const before = ixs[i - 1];
      const ticket = before && before.programId.toBase58() === ED25519_PROGRAM_ID ? decodeEd25519(before.data)?.message : undefined;
      const head = Buffer.concat([Buffer.from(LINK_TICKET_DOMAIN, "utf8"), program.toBuffer()]);
      if (!ticket || ticket.length !== TICKET_LENGTH || !ticket.subarray(0, head.length).equals(head)) throw new UnsafeTransactionError("an accept without its ticket just before it");
      stake = ticket.readBigUInt64LE(TICKET_STAKE_OFFSET);
    }
    found.push({ kind: wg.kind, battle: ix.keys[battleIndex(wg.kind)]?.toBase58() ?? "?", ...(stake !== undefined ? { stake } : {}) });
  }
  if (found.length > 1) throw new UnsafeTransactionError("the transaction carries more than one link-wager instruction");
  return found[0] ?? null;
}
