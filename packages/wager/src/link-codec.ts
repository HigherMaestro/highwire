import { Buffer } from "buffer";
import { Ed25519Program, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import type { Cluster } from "highwire-core";
import { hex32, INCINERATOR } from "./codec.ts";

// Link battles' practice-stake program's wire format (programs/link-wager, docs/link-wager.md 3, 4): its address on
// each cluster, the accounts it derives, the desk's ticket and the referee's result, its Borsh-encoded instructions, and
// its accounts' layouts. Only web3.js and plain modules, as codec.ts. The encodings are pinned by
// test/fixtures/link-codec.json, which the program's own tests check byte for byte (programs/link-wager/tests/codec.rs).

/**
 * Where the program is deployed: devnet, and never mainnet (practice stakes are devnet's alone, docs/link-wager.md 5).
 * The address is the one the Rust declares (`declare_id!` in programs/link-wager/src/lib.rs); a test fails unless they
 * agree. Staking on link battles is refused on a cluster without one. (Tests and the local rehearsal hand the builders
 * an address in code; nothing reads one from the environment.)
 */
export const LINK_WAGER_PROGRAM_IDS: Record<Cluster, string | null> = {
  devnet: "J6GQfe7VYa6tpDxZg7j2xEobF4Jj3ciq2AzUcC2UBUQe",
  mainnet: null,
};

export const LINK_TICKET_DOMAIN = "highwire-link-ticket-1";
export const LINK_RESULT_DOMAIN = "highwire-link-result-1";

/** The instructions' Borsh enum tags. */
export const LINK_WAGER_TAGS = {
  initConfig: 0,
  updateConfig: 1,
  open: 2,
  accept: 3,
  cancel: 4,
  settle: 5,
  refund: 6,
  freezeAndRefund: 7,
} as const;

export type LinkWagerKind = keyof typeof LINK_WAGER_TAGS;

/** A result's outcome, by its byte: player A won, player B won, a draw, a void. */
export const LINK_OUTCOMES = ["a", "b", "draw", "void"] as const;
export type LinkOutcome = (typeof LINK_OUTCOMES)[number];

export function linkWagerProgram(cluster: Cluster): PublicKey | null {
  const id = LINK_WAGER_PROGRAM_IDS[cluster];
  return id ? new PublicKey(id) : null;
}

export function linkConfigAddress(program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0];
}

export function linkBattleAddress(program: PublicKey, battleId: string): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("battle"), hex32(battleId, "the battle id")], program)[0];
}

/** The desk's ticket for one staked battle: what `open` and `accept` must carry, signed. */
export interface LinkTicket {
  battleId: string;
  playerA: string;
  playerB: string;
  /** Lamports a side. */
  stake: bigint;
  /** Unix seconds: B must accept by then. */
  acceptDeadline: number;
  /** Unix seconds: A must open by then. */
  expiry: number;
  keyId: number;
}

/** How a staked battle ended, as the referee signs it: the battle, its two wallets, the outcome, the key's id. */
export interface LinkResult {
  battleId: string;
  playerA: string;
  playerB: string;
  outcome: LinkOutcome;
  keyId: number;
}

const u8 = (n: number, what: string) => {
  if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`${what} is a whole number from 0 to 255`);
  return Buffer.from([n]);
};
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const i64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};
const key = (k: string) => new PublicKey(k).toBuffer();
const outcomeByte = (o: LinkOutcome) => {
  const i = LINK_OUTCOMES.indexOf(o);
  if (i < 0) throw new Error("the outcome is a, b, draw or void");
  return Buffer.from([i]);
};

/** The exact bytes the desk signs: the domain, the program, then every field (little-endian). */
export function linkTicketMessage(program: PublicKey, t: LinkTicket): Buffer {
  return Buffer.concat([Buffer.from(LINK_TICKET_DOMAIN, "utf8"), program.toBuffer(), hex32(t.battleId, "the battle id"), key(t.playerA), key(t.playerB), u64(t.stake), i64(t.acceptDeadline), i64(t.expiry), u16(t.keyId)]);
}

/** The exact bytes the referee signs for a result. */
export function linkResultMessage(program: PublicKey, r: LinkResult): Buffer {
  return Buffer.concat([Buffer.from(LINK_RESULT_DOMAIN, "utf8"), program.toBuffer(), hex32(r.battleId, "the battle id"), key(r.playerA), key(r.playerB), outcomeByte(r.outcome), u16(r.keyId)]);
}

/** The Ed25519 check that must come immediately before `open` or `accept` (the ticket) or `settle` (the result). */
export function linkSignedCheck(message: Buffer, signer: PublicKey, signature: Uint8Array): TransactionInstruction {
  return Ed25519Program.createInstructionWithPublicKey({ publicKey: signer.toBytes(), message, signature });
}

/** A program instruction's arguments, by kind (the ones Highwire builds for players). */
export type LinkWagerArgs = { kind: "open"; ticket: LinkTicket } | { kind: "accept" } | { kind: "cancel" } | { kind: "settle"; outcome: LinkOutcome; keyId: number } | { kind: "refund" };

export function encodeLinkWager(args: LinkWagerArgs): Buffer {
  const tag = Buffer.from([LINK_WAGER_TAGS[args.kind]]);
  switch (args.kind) {
    case "open": {
      const t = args.ticket;
      return Buffer.concat([tag, hex32(t.battleId, "the battle id"), key(t.playerB), u64(t.stake), i64(t.acceptDeadline), i64(t.expiry), u16(t.keyId)]);
    }
    case "settle":
      return Buffer.concat([tag, outcomeByte(args.outcome), u16(args.keyId)]);
    default:
      return tag;
  }
}

/** The two wallets a payout or refund instruction names, from the battle's account. */
export interface LinkParties {
  playerA: PublicKey;
  playerB: PublicKey;
}

const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

/**
 * A program instruction with its accounts in the program's order (programs/link-wager/src/instruction.rs). `wallet` is
 * the signer of an open, accept or cancel; a settle and a refund have no signer of their own (whoever sends pays the
 * fee). `parties` are needed by cancel, settle and refund. A payee that can't be credited is passed read-only (the
 * runtime won't load a program account as writable); the program burns its share.
 */
export function linkWagerInstruction(program: PublicKey, wallet: PublicKey, battleId: string, args: LinkWagerArgs, parties?: LinkParties, readOnly: PublicKey[] = []): TransactionInstruction {
  const battle = linkBattleAddress(program, battleId);
  const config = linkConfigAddress(program);
  const burn = w(new PublicKey(INCINERATOR));
  const payee = (k: PublicKey) => (readOnly.some((x) => x.equals(k)) ? r(k) : w(k));
  const need = () =>
    parties ??
    (() => {
      throw new Error(`a ${args.kind} needs the battle's two players`);
    })();
  let keys: AccountMeta[];
  switch (args.kind) {
    case "open":
    case "accept":
      keys = [w(wallet, true), w(config), w(battle), r(SYSVAR_INSTRUCTIONS_PUBKEY), r(SystemProgram.programId)];
      break;
    case "cancel":
      keys = [r(wallet, true), w(config), w(battle), payee(need().playerA), burn];
      break;
    case "settle":
      keys = [w(battle), w(config), payee(need().playerA), payee(need().playerB), r(SYSVAR_INSTRUCTIONS_PUBKEY), burn];
      break;
    case "refund":
      keys = [w(battle), w(config), payee(need().playerA), payee(need().playerB), burn];
      break;
  }
  return new TransactionInstruction({ programId: program, keys, data: encodeLinkWager(args) });
}

// ---------------------------------------------------------------- the authority's instructions (the maintainer's tool)

export interface LinkConfigInit {
  authority: string;
  ticketKey: string;
  ticketKeyId: number;
  resultKey: string;
  resultKeyId: number;
  /** Up to four tiers, lamports a side. */
  tiers: bigint[];
  maxStake: bigint;
  openStakeCap: bigint;
  refundAfterSeconds: number;
}

const tiers4 = (tiers: bigint[]) => {
  if (tiers.length > 4) throw new Error("the program holds four tiers at most");
  return Buffer.concat([0, 1, 2, 3].map((i) => u64(tiers[i] ?? 0n)));
};

export function encodeLinkConfigInit(c: LinkConfigInit): Buffer {
  return Buffer.concat([Buffer.from([LINK_WAGER_TAGS.initConfig]), key(c.authority), key(c.ticketKey), u16(c.ticketKeyId), key(c.resultKey), u16(c.resultKeyId), tiers4(c.tiers), u64(c.maxStake), u64(c.openStakeCap), u32(c.refundAfterSeconds)]);
}

/** Once, by the program's upgrade authority, who pays for the config account. */
export function linkInitConfigInstruction(program: PublicKey, payer: PublicKey, c: LinkConfigInit): TransactionInstruction {
  const programData = PublicKey.findProgramAddressSync([program.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
  return new TransactionInstruction({ programId: program, keys: [w(payer, true), w(linkConfigAddress(program)), r(programData), r(SystemProgram.programId)], data: encodeLinkConfigInit(c) });
}

export interface LinkConfigUpdate {
  authority?: string;
  ticketKey?: { key: string; id: number };
  resultKey?: { key: string; id: number };
  paused?: boolean;
  tiers?: bigint[];
  maxStake?: bigint;
  openStakeCap?: bigint;
  refundAfterSeconds?: number;
}

const option = (b: Buffer | undefined) => (b === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), b]));

export function encodeLinkConfigUpdate(u: LinkConfigUpdate): Buffer {
  return Buffer.concat([
    Buffer.from([LINK_WAGER_TAGS.updateConfig]),
    option(u.authority === undefined ? undefined : key(u.authority)),
    option(u.ticketKey === undefined ? undefined : Buffer.concat([key(u.ticketKey.key), u16(u.ticketKey.id)])),
    option(u.resultKey === undefined ? undefined : Buffer.concat([key(u.resultKey.key), u16(u.resultKey.id)])),
    option(u.paused === undefined ? undefined : Buffer.from([u.paused ? 1 : 0])),
    option(u.tiers === undefined ? undefined : tiers4(u.tiers)),
    option(u.maxStake === undefined ? undefined : u64(u.maxStake)),
    option(u.openStakeCap === undefined ? undefined : u64(u.openStakeCap)),
    option(u.refundAfterSeconds === undefined ? undefined : u32(u.refundAfterSeconds)),
  ]);
}

/** By the authority. A change of authority is signed by the new one too, so the config can't be handed to a mistyped address. */
export function linkConfigUpdateInstruction(program: PublicKey, authority: PublicKey, u: LinkConfigUpdate): TransactionInstruction {
  const keys = [r(authority, true), w(linkConfigAddress(program)), ...(u.authority === undefined ? [] : [r(new PublicKey(u.authority), true)])];
  return new TransactionInstruction({ programId: program, keys, data: encodeLinkConfigUpdate(u) });
}

/** The authority alone: refunds whoever has staked on a battle, in full. */
export function linkFreezeAndRefundInstruction(program: PublicKey, authority: PublicKey, battleId: string, parties: LinkParties, readOnly: PublicKey[] = []): TransactionInstruction {
  const payee = (k: PublicKey) => (readOnly.some((x) => x.equals(k)) ? r(k) : w(k));
  return new TransactionInstruction({
    programId: program,
    keys: [r(authority, true), w(linkConfigAddress(program)), w(linkBattleAddress(program, battleId)), payee(parties.playerA), payee(parties.playerB), w(new PublicKey(INCINERATOR))],
    data: Buffer.from([LINK_WAGER_TAGS.freezeAndRefund]),
  });
}

// ---------------------------------------------------------------- decoding

export type DecodedLinkWager =
  | { kind: "open"; battleId: string; playerB: string; stake: bigint; acceptDeadline: number; expiry: number; keyId: number }
  | { kind: "settle"; outcome: LinkOutcome; keyId: number }
  | { kind: "accept" | "cancel" | "refund" | "freezeAndRefund" | "initConfig" | "updateConfig" };

/** A program instruction's data, or null for anything that isn't exactly one (trailing bytes included). */
export function decodeLinkWager(data: Buffer): DecodedLinkWager | null {
  const tag = data[0];
  const kind = (Object.keys(LINK_WAGER_TAGS) as LinkWagerKind[]).find((k) => LINK_WAGER_TAGS[k] === tag);
  if (!kind) return null;
  switch (kind) {
    case "open": {
      if (data.length !== 1 + 32 + 32 + 8 + 8 + 8 + 2) return null;
      return {
        kind,
        battleId: data.subarray(1, 33).toString("hex"),
        playerB: new PublicKey(data.subarray(33, 65)).toBase58(),
        stake: data.readBigUInt64LE(65),
        acceptDeadline: Number(data.readBigInt64LE(73)),
        expiry: Number(data.readBigInt64LE(81)),
        keyId: data.readUInt16LE(89),
      };
    }
    case "settle": {
      if (data.length !== 4) return null;
      const outcome = LINK_OUTCOMES[data[1]!];
      return outcome ? { kind, outcome, keyId: data.readUInt16LE(2) } : null;
    }
    case "accept":
    case "cancel":
    case "refund":
    case "freezeAndRefund":
      return data.length === 1 ? { kind } : null;
    default:
      return { kind };
  }
}

class Reader {
  o = 0;
  constructor(readonly d: Buffer) {}
  private take(n: number) {
    if (this.o + n > this.d.length) throw new Error("the account is shorter than its layout");
    const b = this.d.subarray(this.o, this.o + n);
    this.o += n;
    return b;
  }
  u8 = () => this.take(1)[0]!;
  bool = () => {
    const b = this.u8();
    if (b > 1) throw new Error("not a bool");
    return b === 1;
  };
  u16 = () => this.take(2).readUInt16LE(0);
  u32 = () => this.take(4).readUInt32LE(0);
  u64 = () => this.take(8).readBigUInt64LE(0);
  i64 = () => Number(this.take(8).readBigInt64LE(0));
  hex = () => this.take(32).toString("hex");
  key = () => new PublicKey(this.take(32)).toBase58();
}

/** The program's config (state.rs `Config`). */
export interface LinkWagerConfig {
  authority: string;
  ticketKey: string;
  ticketKeyId: number;
  resultKey: string;
  resultKeyId: number;
  paused: boolean;
  /** Lamports a side; unused slots dropped. */
  tiers: bigint[];
  maxStake: bigint;
  openStakeCap: bigint;
  openStake: bigint;
  refundAfterSeconds: number;
}

export const LINK_CONFIG_LEN = 162;

export function decodeLinkConfig(data: Buffer): LinkWagerConfig {
  const rd = new Reader(data);
  if (rd.u8() !== 1) throw new Error("not a version-1 link-wager config");
  return {
    authority: rd.key(),
    ticketKey: rd.key(),
    ticketKeyId: rd.u16(),
    resultKey: rd.key(),
    resultKeyId: rd.u16(),
    paused: rd.bool(),
    tiers: [rd.u64(), rd.u64(), rd.u64(), rd.u64()].filter((t) => t > 0n),
    maxStake: rd.u64(),
    openStakeCap: rd.u64(),
    openStake: rd.u64(),
    refundAfterSeconds: rd.u32(),
  };
}

export const LINK_BATTLE_STATUS = { open: 1, live: 2 } as const;
export const LINK_BATTLE_LEN = 148;
/** Where each player's wallet sits in a battle's account: for getProgramAccounts filters. */
export const LINK_BATTLE_PLAYER_OFFSETS = { A: 34, B: 66 } as const;

/** A staked battle's account (state.rs `Battle`): who staked what, and when. */
export interface LinkBattleAccount {
  status: "open" | "live";
  battleId: string;
  playerA: string;
  playerB: string;
  /** Lamports a side. */
  stake: bigint;
  ticketKeyId: number;
  acceptDeadline: number;
  ticketExpiry: number;
  /** Unix seconds: when A staked, and when B did (0 until then). */
  openedAt: number;
  liveAt: number;
  /** Unix seconds: from when anyone may refund both if no result has come (0 until B stakes). Fixed when B stakes. */
  refundAt: number;
}

export function decodeLinkBattle(data: Buffer): LinkBattleAccount {
  const rd = new Reader(data);
  if (rd.u8() !== 1) throw new Error("not a version-1 link-wager battle");
  const status = rd.u8();
  if (status !== LINK_BATTLE_STATUS.open && status !== LINK_BATTLE_STATUS.live) throw new Error("not a battle this version knows");
  return {
    status: status === LINK_BATTLE_STATUS.open ? "open" : "live",
    battleId: rd.hex(),
    playerA: rd.key(),
    playerB: rd.key(),
    stake: rd.u64(),
    ticketKeyId: rd.u16(),
    acceptDeadline: rd.i64(),
    ticketExpiry: rd.i64(),
    openedAt: rd.i64(),
    liveAt: rd.i64(),
    refundAt: rd.i64(),
  };
}
