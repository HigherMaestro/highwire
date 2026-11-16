import { Buffer } from "buffer";
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { COMPUTE_UNITS, finish, priorityFee, ValidationError, type Chain, type Finished } from "highwire-core";
import {
  decodeLinkBattle,
  decodeLinkConfig,
  linkBattleAddress,
  linkConfigAddress,
  linkResultMessage,
  linkSignedCheck,
  linkTicketMessage,
  linkWagerInstruction,
  linkWagerProgram,
  type LinkBattleAccount,
  type LinkResult,
  type LinkTicket,
  type LinkWagerConfig,
} from "./link-codec.ts";
import { linkWagerGuard } from "./link-guard.ts";
import { uncreditable } from "./tx.ts";

// Link battles' practice-stake transactions (docs/link-wager.md 3, 4). Only the local signer sends them: the sign page
// refuses every instruction of the program (assertSafe allows one only when the caller expects exactly it) and stakes
// get no sign link. Each goes through finish(), like everything Highwire builds.

/** The chain to build on, and the program to build for: the codec's for the chain's cluster, unless one is handed in (tests, the local rehearsal). */
export interface LinkStakes {
  chain: Chain;
  program?: PublicKey;
}

export function linkStakesProgram(s: LinkStakes): PublicKey {
  const p = s.program ?? linkWagerProgram(s.chain.cluster);
  if (!p) throw new ValidationError(`Staking on link battles isn't deployed on ${s.chain.cluster} yet.`);
  return p;
}

export async function readLinkConfig(s: LinkStakes): Promise<LinkWagerConfig> {
  const acc = await s.chain.connection.getAccountInfo(linkConfigAddress(linkStakesProgram(s)), "confirmed");
  if (!acc) throw new ValidationError(`The link-wager program on ${s.chain.cluster} isn't set up yet.`);
  return decodeLinkConfig(acc.data);
}

/** A staked battle by id, or null when there's no account (never opened, or closed). */
export async function readLinkBattle(s: LinkStakes, battleId: string): Promise<LinkBattleAccount | null> {
  const p = linkStakesProgram(s);
  const acc = await s.chain.connection.getAccountInfo(linkBattleAddress(p, battleId), "confirmed");
  if (!acc || !acc.owner.equals(p) || acc.data.length === 0) return null;
  return decodeLinkBattle(acc.data);
}

function compose(wallet: PublicKey, microLamports: number, ixs: TransactionInstruction[]): VersionedTransaction {
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: wallet,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.wager }), ...ixs],
    }).compileToV0Message(),
  );
}

/** A ticket from the desk and its Ed25519 signature (64 bytes, hex). */
export interface SignedLinkTicket {
  ticket: LinkTicket;
  signature: string;
}

/** A result from the referee and its Ed25519 signature (64 bytes, hex). */
export interface SignedLinkResult {
  result: LinkResult;
  signature: string;
}

export interface LinkStakeRequest extends SignedLinkTicket {
  wallet: PublicKey;
  simulate?: boolean;
}

export interface BuiltLinkStake extends Finished {
  /** Lamports this wallet stakes. */
  stake: bigint;
}

const sigBytes = (hex: string, what: string): Uint8Array => {
  if (!/^[0-9a-f]{128}$/.test(hex)) throw new ValidationError(`${what}'s signature is 64 bytes of hex.`);
  return Uint8Array.from(Buffer.from(hex, "hex"));
};

/** The checks both sides make of a ticket before staking: the program's config, the key, the tier, the signature. */
function checkTicket(program: PublicKey, config: LinkWagerConfig, s: SignedLinkTicket): Uint8Array {
  const t = s.ticket;
  if (config.paused) throw new ValidationError("Staking on link battles is paused: no new battles open or start.");
  if (t.keyId !== config.ticketKeyId) throw new ValidationError("The ticket was signed with a retired desk key; ask for a new pairing.");
  if (!config.tiers.includes(t.stake)) throw new ValidationError("The ticket's stake isn't one of the program's tiers.");
  const sig = sigBytes(s.signature, "The ticket");
  if (!ed25519.verify(sig, linkTicketMessage(program, t), new PublicKey(config.ticketKey).toBytes())) throw new ValidationError("The ticket isn't signed by the desk's key.");
  return sig;
}

const expect = (wallet: PublicKey, guard: ReturnType<typeof linkWagerGuard>) => ({ wallet, allowLaunchLab: false, allowCpmm: false, guards: [guard] });

/** Player A: stake and open the battle the desk paired. */
export async function buildLinkOpen(s: LinkStakes, req: LinkStakeRequest): Promise<BuiltLinkStake> {
  const p = linkStakesProgram(s);
  const t = req.ticket;
  if (t.playerA !== req.wallet.toBase58()) throw new ValidationError("This ticket opens a battle for another wallet.");
  if (Math.floor(Date.now() / 1000) > t.expiry) throw new ValidationError("The ticket has expired; ask for a new pairing.");
  const config = await readLinkConfig(s);
  const sig = checkTicket(p, config, req);
  const ticketKey = new PublicKey(config.ticketKey);
  const microLamports = await priorityFee(s.chain, [req.wallet, linkBattleAddress(p, t.battleId)]);
  const tx = compose(req.wallet, microLamports, [linkSignedCheck(linkTicketMessage(p, t), ticketKey, sig), linkWagerInstruction(p, req.wallet, t.battleId, { kind: "open", ticket: t })]);
  const built = await finish({
    chain: s.chain,
    wallet: req.wallet,
    kind: "wager",
    simulate: req.simulate,
    txs: [{ tx, label: `stake on link battle ${t.battleId.slice(0, 8)} and open it`, expect: expect(req.wallet, linkWagerGuard(p, { kind: "open", battleId: t.battleId, ticket: t, ticketKey })) }],
  });
  return { ...built, stake: t.stake };
}

/** Player B: stake on the battle A opened. */
export async function buildLinkAccept(s: LinkStakes, req: LinkStakeRequest): Promise<BuiltLinkStake> {
  const p = linkStakesProgram(s);
  const t = req.ticket;
  if (t.playerB !== req.wallet.toBase58()) throw new ValidationError("This ticket is for another wallet to accept.");
  const [config, battle] = await Promise.all([readLinkConfig(s), readLinkBattle(s, t.battleId)]);
  if (!battle || battle.status !== "open") throw new ValidationError("That battle isn't open: its opener hasn't staked yet, or it has started or closed.");
  if (battle.playerA !== t.playerA || battle.playerB !== t.playerB || battle.stake !== t.stake || battle.acceptDeadline !== t.acceptDeadline || battle.ticketKeyId !== t.keyId) {
    throw new ValidationError("The battle on-chain doesn't match the ticket.");
  }
  if (Math.floor(Date.now() / 1000) > t.acceptDeadline) throw new ValidationError("The time to accept has passed.");
  const sig = checkTicket(p, config, req);
  const ticketKey = new PublicKey(config.ticketKey);
  const microLamports = await priorityFee(s.chain, [req.wallet, linkBattleAddress(p, t.battleId)]);
  const tx = compose(req.wallet, microLamports, [linkSignedCheck(linkTicketMessage(p, t), ticketKey, sig), linkWagerInstruction(p, req.wallet, t.battleId, { kind: "accept" })]);
  const built = await finish({
    chain: s.chain,
    wallet: req.wallet,
    kind: "wager",
    simulate: req.simulate,
    txs: [{ tx, label: `stake on link battle ${t.battleId.slice(0, 8)} and accept it`, expect: expect(req.wallet, linkWagerGuard(p, { kind: "accept", battleId: t.battleId, ticket: t, ticketKey })) }],
  });
  return { ...built, stake: t.stake };
}

async function parties(s: LinkStakes, battleId: string) {
  const battle = await readLinkBattle(s, battleId);
  if (!battle) throw new ValidationError("There's no such staked battle open: it was never opened, or it has closed.");
  const both = { playerA: new PublicKey(battle.playerA), playerB: new PublicKey(battle.playerB) };
  return { battle, both, readOnly: await uncreditable(s.chain, [both.playerA, both.playerB]) };
}

/** Pays a staked battle on the referee's signed result. Anyone may send it; the program pays only the two players. */
export async function buildLinkSettle(s: LinkStakes, req: SignedLinkResult & { wallet: PublicKey; simulate?: boolean }): Promise<Finished> {
  const p = linkStakesProgram(s);
  const r = req.result;
  const [config, { battle, both, readOnly }] = await Promise.all([readLinkConfig(s), parties(s, r.battleId)]);
  if (battle.status !== "live") throw new ValidationError("That battle hasn't both stakes in: there's nothing to settle.");
  if (battle.playerA !== r.playerA || battle.playerB !== r.playerB) throw new ValidationError("The result names other wallets than the battle on-chain.");
  if (r.keyId !== config.resultKeyId) throw new ValidationError("The result was signed with a retired referee key; ask the referee for it again.");
  const sig = sigBytes(req.signature, "The result");
  const resultKey = new PublicKey(config.resultKey);
  if (!ed25519.verify(sig, linkResultMessage(p, r), resultKey.toBytes())) throw new ValidationError("The result isn't signed by the referee's key.");
  const microLamports = await priorityFee(s.chain, [req.wallet, linkBattleAddress(p, r.battleId)]);
  const tx = compose(req.wallet, microLamports, [linkSignedCheck(linkResultMessage(p, r), resultKey, sig), linkWagerInstruction(p, req.wallet, r.battleId, { kind: "settle", outcome: r.outcome, keyId: r.keyId }, both, readOnly)]);
  return finish({
    chain: s.chain,
    wallet: req.wallet,
    kind: "wager",
    simulate: req.simulate,
    txs: [{ tx, label: `settle link battle ${r.battleId.slice(0, 8)} on the referee's result`, expect: expect(req.wallet, linkWagerGuard(p, { kind: "settle", battleId: r.battleId, result: r, resultKey })) }],
  });
}

/** Cancels a battle this wallet opened and nobody accepted, or refunds both stakes of one that has had no result. */
export async function buildLinkExit(s: LinkStakes, req: { wallet: PublicKey; battleId: string; kind: "cancel" | "refund"; simulate?: boolean }): Promise<Finished> {
  const p = linkStakesProgram(s);
  const { battle, both, readOnly } = await parties(s, req.battleId);
  if (req.kind === "cancel" && battle.status !== "open") throw new ValidationError("Both have staked on that battle: it's settled or refunded, not cancelled.");
  if (req.kind === "refund" && battle.status !== "live") throw new ValidationError("Only its opener has staked on that battle: cancel it instead.");
  const microLamports = await priorityFee(s.chain, [req.wallet, linkBattleAddress(p, req.battleId)]);
  const tx = compose(req.wallet, microLamports, [linkWagerInstruction(p, req.wallet, req.battleId, { kind: req.kind }, both, readOnly)]);
  return finish({
    chain: s.chain,
    wallet: req.wallet,
    kind: "wager",
    simulate: req.simulate,
    txs: [{ tx, label: `${req.kind === "cancel" ? "cancel the unaccepted" : "refund the unsettled"} link battle ${req.battleId.slice(0, 8)}`, expect: expect(req.wallet, linkWagerGuard(p, { kind: req.kind, battleId: req.battleId })) }],
  });
}

/** How a staked battle that's gone from the chain closed, from the program's own closing event in a transaction's log. */
export type LinkClosing = { how: "settled"; outcome: LinkResult["outcome"] } | { how: "cancelled" | "refunded" };

const EVENT_TAG = "link-wager";

/**
 * The program's closing event for this battle in a transaction's log, if there is one (processor.rs `announce`): a
 * `Program data:` line inside one of the program's own frames, so no other program can forge one, naming this battle,
 * so no other battle's transaction can stand in for it.
 */
export function linkClosingEvent(logs: readonly string[], programId: string, battleId: string): LinkClosing | null {
  const stack: string[] = [];
  for (const line of logs) {
    if (line.startsWith("Log truncated")) return null;
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    if (/^Program \S+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (!line.startsWith("Program data: ") || stack[stack.length - 1] !== programId) continue;
    const parts = line.slice("Program data: ".length).split(" ").map((x) => Buffer.from(x, "base64"));
    if (parts.length !== 4 || parts[0]!.toString("utf8") !== EVENT_TAG || parts[1]!.length !== 1 || parts[3]!.length !== 1) continue;
    if (parts[2]!.toString("hex") !== battleId) continue;
    const kind = parts[1]![0];
    const outcome = (["a", "b", "draw", "void"] as const)[parts[3]![0]!];
    if (kind === 1 && outcome) return { how: "settled", outcome };
    if (kind === 2) return { how: "cancelled" };
    if (kind === 3) return { how: "refunded" };
  }
  return null;
}
