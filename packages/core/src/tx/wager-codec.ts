import { Buffer } from "buffer";
import { Ed25519Program, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import type { Cluster } from "../higher/constants.ts";

// The wager program's wire format (programs/line-wager, docs/wager-mode.md 7.2): its address on each cluster, the
// accounts it derives, the matchmaker's ticket, its Borsh-encoded instructions, and its accounts' layouts. The sign
// page's checks (decode.ts) import this, so it imports only web3.js and plain modules. The encodings are pinned by
// test/fixtures/wager-codec.json, which the program's own tests check byte for byte.

/** Where the wager program is deployed. Wagering is refused on a cluster without one. */
export const WAGER_PROGRAM_IDS: Record<Cluster, string | null> = {
  devnet: "RRMA7jERXRceX7i5QBK2fw8qbACkAo5zs949onndezC",
  mainnet: null,
};

export const ED25519_PROGRAM_ID = "Ed25519SigVerify111111111111111111111111111";
/** Payouts to a wallet the runtime won't credit burn here (docs/wager-mode.md 6.3). */
export const INCINERATOR = "1nc1nerator11111111111111111111111111111111";
export const TICKET_DOMAIN = "highwire-line-ticket-1";

/** The instructions' Borsh enum tags. */
export const WAGER_TAGS = {
  initConfig: 0,
  updateConfig: 1,
  open: 2,
  accept: 3,
  cancel: 4,
  commit: 5,
  reveal: 6,
  revealFallback: 7,
  timeout: 8,
  settle: 9,
  retire: 10,
  emergencyRefund: 11,
  freezeAndRefund: 12,
} as const;

export type WagerKind = keyof typeof WAGER_TAGS;

export const FALLBACK_KINDS = ["zero", "steady", "mirror"] as const;

export function wagerProgram(cluster: Cluster): PublicKey | null {
  const id = WAGER_PROGRAM_IDS[cluster];
  return id ? new PublicKey(id) : null;
}

const isHex32 = (s: string) => /^[0-9a-f]{64}$/.test(s);

export function hex32(s: string, what: string): Buffer {
  if (!isHex32(s)) throw new Error(`${what} is 32 bytes of lowercase hex`);
  return Buffer.from(s, "hex");
}

export function wagerConfigAddress(program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0];
}

export function seriesAddress(program: PublicKey, seriesId: string): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("series"), hex32(seriesId, "the series id")], program)[0];
}

/** The matchmaker's ticket for one series: what `open` and `accept` must carry, signed. */
export interface WagerTicket {
  seriesId: string;
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

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
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

/** The exact bytes the matchmaker signs: the domain, the program, then every field (little-endian). */
export function ticketMessage(program: PublicKey, t: WagerTicket): Buffer {
  return Buffer.concat([
    Buffer.from(TICKET_DOMAIN, "utf8"),
    program.toBuffer(),
    hex32(t.seriesId, "the series id"),
    new PublicKey(t.playerA).toBuffer(),
    new PublicKey(t.playerB).toBuffer(),
    u64(t.stake),
    i64(t.acceptDeadline),
    i64(t.expiry),
    u16(t.keyId),
  ]);
}

/** The Ed25519 check that must come immediately before `open` or `accept`. */
export function ticketCheck(program: PublicKey, ticket: WagerTicket, ticketKey: PublicKey, signature: Uint8Array): TransactionInstruction {
  return Ed25519Program.createInstructionWithPublicKey({ publicKey: ticketKey.toBytes(), message: ticketMessage(program, ticket), signature });
}

/** A wager instruction's arguments, by kind (the ones Highwire builds). */
export type WagerArgs =
  | { kind: "open"; ticket: WagerTicket; fallbackHash: string }
  | { kind: "accept"; fallbackHash: string }
  | { kind: "cancel" }
  | { kind: "commit"; round: number; hash: string }
  | { kind: "reveal"; pull: number; nonce: string }
  | { kind: "revealFallback"; fallback: { kind: (typeof FALLBACK_KINDS)[number]; pull: number }; salt: string }
  | { kind: "timeout" }
  | { kind: "settle" }
  | { kind: "retire" }
  | { kind: "emergencyRefund" };

const byte = (n: number, what: string) => {
  if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`${what} is a whole number from 0 to 255`);
  return Buffer.from([n]);
};

export function encodeWager(args: WagerArgs): Buffer {
  const tag = Buffer.from([WAGER_TAGS[args.kind]]);
  switch (args.kind) {
    case "open": {
      const t = args.ticket;
      return Buffer.concat([tag, hex32(t.seriesId, "the series id"), new PublicKey(t.playerB).toBuffer(), u64(t.stake), i64(t.acceptDeadline), i64(t.expiry), u16(t.keyId), hex32(args.fallbackHash, "the fallback hash")]);
    }
    case "accept":
      return Buffer.concat([tag, hex32(args.fallbackHash, "the fallback hash")]);
    case "commit":
      return Buffer.concat([tag, byte(args.round, "the round"), hex32(args.hash, "the commitment")]);
    case "reveal":
      return Buffer.concat([tag, byte(args.pull, "the pull"), hex32(args.nonce, "the nonce")]);
    case "revealFallback":
      return Buffer.concat([tag, byte(FALLBACK_KINDS.indexOf(args.fallback.kind), "the fallback kind"), byte(args.fallback.pull, "the fallback's pull"), hex32(args.salt, "the salt")]);
    default:
      return tag;
  }
}

/** The accounts each payout and refund instruction needs, besides its own. */
export interface WagerParties {
  playerA: PublicKey;
  playerB: PublicKey;
  feeAccount: PublicKey;
}

const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

/**
 * A wager instruction with its accounts in the program's order (programs/line-wager/src/instruction.rs). `wallet` is
 * the signer (a player, or whoever cranks a timeout, settle or refund and pays its fee); `parties` are needed by cancel,
 * settle and the emergency refund, from the series account. A payee that can't be credited is passed read-only (the
 * runtime won't load a program account as writable); the program burns its share.
 */
export function wagerInstruction(program: PublicKey, wallet: PublicKey, seriesId: string, args: WagerArgs, parties?: WagerParties, readOnly: PublicKey[] = []): TransactionInstruction {
  const series = seriesAddress(program, seriesId);
  const config = wagerConfigAddress(program);
  const burn = w(new PublicKey(INCINERATOR));
  const payee = (k: PublicKey) => (readOnly.some((x) => x.equals(k)) ? r(k) : w(k));
  const need = () => parties ?? (() => { throw new Error(`a ${args.kind} needs the series' players and fee account`); })();
  let keys: AccountMeta[];
  switch (args.kind) {
    case "open":
    case "accept":
      keys = [w(wallet, true), w(config), w(series), r(SYSVAR_INSTRUCTIONS_PUBKEY), r(SystemProgram.programId)];
      break;
    case "cancel":
      keys = [r(wallet, true), w(config), w(series), payee(need().playerA), burn];
      break;
    case "commit":
    case "reveal":
    case "revealFallback":
    case "retire":
      keys = [r(wallet, true), w(series)];
      break;
    case "timeout":
      keys = [w(series)];
      break;
    case "settle":
      keys = [w(series), w(config), payee(need().playerA), payee(need().playerB), payee(need().feeAccount), burn];
      break;
    case "emergencyRefund":
      keys = [w(series), w(config), payee(need().playerA), payee(need().playerB), burn];
      break;
  }
  return new TransactionInstruction({ programId: program, keys, data: encodeWager(args) });
}

/** The program's config, as `InitConfig` sets it (instruction.rs `ConfigInit`). Lamports for amounts. */
export interface WagerConfigInit {
  authority: PublicKey;
  ticketKey: PublicKey;
  ticketKeyId: number;
  feeBps: number;
  feeAccount: PublicKey;
  /** Up to four tiers, lamports a side. */
  tiers: bigint[];
  maxStake: bigint;
  openStakeCap: bigint;
  revealSeconds: number;
}

/**
 * The one-time `InitConfig`, for the maintainer's tool only (packages/wager/scripts/wager-admin.ts): signed by the
 * program's upgrade authority, never by an agent's signer, and assertSafe refuses it everywhere.
 */
export function initConfigInstruction(program: PublicKey, c: WagerConfigInit): TransactionInstruction {
  if (c.tiers.length < 1 || c.tiers.length > 4) throw new Error("one to four tiers");
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const tiers = [...c.tiers, 0n, 0n, 0n, 0n].slice(0, 4);
  const data = Buffer.concat([
    Buffer.from([WAGER_TAGS.initConfig]),
    c.authority.toBuffer(),
    c.ticketKey.toBuffer(),
    u16(c.ticketKeyId),
    u16(c.feeBps),
    c.feeAccount.toBuffer(),
    ...tiers.map(u64),
    u64(c.maxStake),
    u64(c.openStakeCap),
    u32(c.revealSeconds),
  ]);
  const programData = PublicKey.findProgramAddressSync([program.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
  return new TransactionInstruction({
    programId: program,
    keys: [w(c.authority, true), w(wagerConfigAddress(program)), r(programData), r(SystemProgram.programId)],
    data,
  });
}

/** What `UpdateConfig` may change (instruction.rs `ConfigUpdate`); anything left out stays as it is. Lamports for amounts. */
export interface WagerConfigUpdate {
  authority?: PublicKey;
  ticketKey?: { key: PublicKey; id: number };
  paused?: boolean;
  /** Applies to series opened afterwards: each series keeps the fee it opened with. */
  feeBps?: number;
  feeAccount?: PublicKey;
  /** Up to four tiers, lamports a side. */
  tiers?: bigint[];
  maxStake?: bigint;
  openStakeCap?: bigint;
}

/**
 * `UpdateConfig`, for the maintainer's tool only: eight Borsh options in instruction.rs's order, signed by the config's
 * authority. The program checks the result against its hard caps. assertSafe refuses it everywhere.
 */
export function configUpdateInstruction(program: PublicKey, authority: PublicKey, u: WagerConfigUpdate): TransactionInstruction {
  const opt = (b: Buffer | undefined) => (b ? Buffer.concat([Buffer.from([1]), b]) : Buffer.from([0]));
  if (u.tiers && (u.tiers.length < 1 || u.tiers.length > 4)) throw new Error("one to four tiers");
  const data = Buffer.concat([
    Buffer.from([WAGER_TAGS.updateConfig]),
    opt(u.authority?.toBuffer()),
    opt(u.ticketKey ? Buffer.concat([u.ticketKey.key.toBuffer(), u16(u.ticketKey.id)]) : undefined),
    opt(u.paused === undefined ? undefined : Buffer.from([u.paused ? 1 : 0])),
    opt(u.feeBps === undefined ? undefined : u16(u.feeBps)),
    opt(u.feeAccount?.toBuffer()),
    opt(u.tiers ? Buffer.concat([...u.tiers, 0n, 0n, 0n, 0n].slice(0, 4).map(u64)) : undefined),
    opt(u.maxStake === undefined ? undefined : u64(u.maxStake)),
    opt(u.openStakeCap === undefined ? undefined : u64(u.openStakeCap)),
  ]);
  return new TransactionInstruction({ programId: program, keys: [r(authority, true), w(wagerConfigAddress(program))], data });
}

/**
 * `UpdateConfig` setting only `paused`. A paused config refuses new series and accepts (an opened, unaccepted series can
 * only be cancelled then); live ones play on and settle.
 */
export function pauseInstruction(program: PublicKey, authority: PublicKey, paused: boolean): TransactionInstruction {
  return configUpdateInstruction(program, authority, { paused });
}

/**
 * `FreezeAndRefund`, for the maintainer's tool only: the config authority refunds both stakes of a series in full,
 * whatever its state. `parties` from the series account; a payee that can't be credited goes read-only, and the program
 * burns its share. assertSafe refuses it everywhere.
 */
export function freezeAndRefundInstruction(program: PublicKey, authority: PublicKey, seriesId: string, parties: Pick<WagerParties, "playerA" | "playerB">, readOnly: PublicKey[] = []): TransactionInstruction {
  const payee = (k: PublicKey) => (readOnly.some((x) => x.equals(k)) ? r(k) : w(k));
  return new TransactionInstruction({
    programId: program,
    keys: [r(authority, true), w(wagerConfigAddress(program)), w(seriesAddress(program, seriesId)), payee(parties.playerA), payee(parties.playerB), w(new PublicKey(INCINERATOR))],
    data: Buffer.from([WAGER_TAGS.freezeAndRefund]),
  });
}

/** A wager instruction's data, decoded, or null when it isn't one the program knows (strict lengths). */
export type DecodedWager =
  | { kind: "open"; seriesId: string; playerB: string; stake: bigint; acceptDeadline: number; expiry: number; keyId: number; fallbackHash: string }
  | { kind: "accept"; fallbackHash: string }
  | { kind: "commit"; round: number; hash: string }
  | { kind: "reveal"; pull: number; nonce: string }
  | { kind: "revealFallback"; fallbackKind: number; pull: number; salt: string }
  | { kind: "cancel" | "timeout" | "settle" | "retire" | "emergencyRefund" | "freezeAndRefund" }
  | { kind: "initConfig" | "updateConfig" };

export function decodeWager(data: Buffer): DecodedWager | null {
  const tag = data[0];
  const at = (o: number) => data.subarray(o, o + 32).toString("hex");
  const len = (n: number) => data.length === n;
  switch (tag) {
    case WAGER_TAGS.open:
      if (!len(1 + 32 + 32 + 8 + 8 + 8 + 2 + 32)) return null;
      return {
        kind: "open",
        seriesId: at(1),
        playerB: new PublicKey(data.subarray(33, 65)).toBase58(),
        stake: data.readBigUInt64LE(65),
        acceptDeadline: Number(data.readBigInt64LE(73)),
        expiry: Number(data.readBigInt64LE(81)),
        keyId: data.readUInt16LE(89),
        fallbackHash: at(91),
      };
    case WAGER_TAGS.accept:
      return len(33) ? { kind: "accept", fallbackHash: at(1) } : null;
    case WAGER_TAGS.commit:
      return len(34) ? { kind: "commit", round: data[1]!, hash: at(2) } : null;
    case WAGER_TAGS.reveal:
      return len(34) ? { kind: "reveal", pull: data[1]!, nonce: at(2) } : null;
    case WAGER_TAGS.revealFallback:
      return len(35) ? { kind: "revealFallback", fallbackKind: data[1]!, pull: data[2]!, salt: at(3) } : null;
    case WAGER_TAGS.cancel:
      return len(1) ? { kind: "cancel" } : null;
    case WAGER_TAGS.timeout:
      return len(1) ? { kind: "timeout" } : null;
    case WAGER_TAGS.settle:
      return len(1) ? { kind: "settle" } : null;
    case WAGER_TAGS.retire:
      return len(1) ? { kind: "retire" } : null;
    case WAGER_TAGS.emergencyRefund:
      return len(1) ? { kind: "emergencyRefund" } : null;
    case WAGER_TAGS.freezeAndRefund:
      return len(1) ? { kind: "freezeAndRefund" } : null;
    case WAGER_TAGS.initConfig:
      return { kind: "initConfig" };
    case WAGER_TAGS.updateConfig:
      return { kind: "updateConfig" };
    default:
      return null;
  }
}

/** An Ed25519 program instruction with exactly one signature, every part inside itself, decoded; else null. */
export function decodeEd25519(data: Buffer): { key: string; message: Buffer } | null {
  if (data.length < 16 || data[0] !== 1) return null;
  const v = (o: number) => data.readUInt16LE(o);
  const [sigOff, sigIx, keyOff, keyIx, msgOff, msgLen, msgIx] = [v(2), v(4), v(6), v(8), v(10), v(12), v(14)];
  if (sigIx !== 0xffff || keyIx !== 0xffff || msgIx !== 0xffff) return null;
  if (sigOff + 64 > data.length || keyOff + 32 > data.length || msgOff + msgLen > data.length) return null;
  return { key: new PublicKey(data.subarray(keyOff, keyOff + 32)).toBase58(), message: data.subarray(msgOff, msgOff + msgLen) };
}

// ---------------------------------------------------------------- accounts

/** The program's config (state.rs `Config`). */
export interface WagerConfig {
  authority: string;
  ticketKey: string;
  ticketKeyId: number;
  paused: boolean;
  feeBps: number;
  feeAccount: string;
  /** Lamports a side; unused slots dropped. */
  tiers: bigint[];
  maxStake: bigint;
  openStakeCap: bigint;
  openStake: bigint;
  revealSeconds: number;
  rules: { places: number; energy: number; regen: number; rounds: number; tieBreakSpent: boolean; roundSeconds: number; bankSeconds: number };
}

export const WAGER_CONFIG_LEN = 175;

class Reader {
  o = 0;
  constructor(readonly d: Buffer) {}
  u8() {
    if (this.o + 1 > this.d.length) throw new Error("the account is shorter than its layout");
    return this.d[this.o++]!;
  }
  bool() {
    const b = this.u8();
    if (b > 1) throw new Error("not a bool");
    return b === 1;
  }
  i8() {
    const n = this.u8();
    return n > 127 ? n - 256 : n;
  }
  u16() {
    const n = this.d.readUInt16LE(this.o);
    this.o += 2;
    return n;
  }
  u32() {
    const n = this.d.readUInt32LE(this.o);
    this.o += 4;
    return n;
  }
  u64() {
    const n = this.d.readBigUInt64LE(this.o);
    this.o += 8;
    return n;
  }
  i64() {
    const n = Number(this.d.readBigInt64LE(this.o));
    this.o += 8;
    return n;
  }
  bytes32() {
    if (this.o + 32 > this.d.length) throw new Error("the account is shorter than its layout");
    const b = this.d.subarray(this.o, this.o + 32);
    this.o += 32;
    return b;
  }
  hex() {
    return this.bytes32().toString("hex");
  }
  key() {
    return new PublicKey(this.bytes32()).toBase58();
  }
  option<T>(f: () => T): T | null {
    return this.bool() ? f() : null;
  }
}

export function decodeWagerConfig(data: Buffer): WagerConfig {
  const r = new Reader(data);
  if (r.u8() !== 1) throw new Error("not a version-1 wager config");
  const c = {
    authority: r.key(),
    ticketKey: r.key(),
    ticketKeyId: r.u16(),
    paused: r.bool(),
    feeBps: r.u16(),
    feeAccount: r.key(),
    tiers: [r.u64(), r.u64(), r.u64(), r.u64()].filter((t) => t > 0n),
    maxStake: r.u64(),
    openStakeCap: r.u64(),
    openStake: r.u64(),
    revealSeconds: r.u32(),
    rules: { places: r.u8(), energy: r.u8(), regen: r.u8(), rounds: r.u8(), tieBreakSpent: r.bool(), roundSeconds: r.u32(), bankSeconds: r.u32() },
  };
  return c;
}

export const SERIES_STATUS = { open: 1, live: 2 } as const;
export const SERIES_HEADER_LEN = 198;
/** Where each player's wallet sits in a series account: for getProgramAccounts filters. */
export const SERIES_PLAYER_OFFSETS = { A: 34, B: 66 } as const;

export interface SeriesHeader {
  status: "open" | "live";
  seriesId: string;
  playerA: string;
  playerB: string;
  stake: bigint;
  feeBps: number;
  feeAccount: string;
  ticketKeyId: number;
  acceptDeadline: number;
  ticketExpiry: number;
  lastChange: number;
  fallbackHashA: string;
}

type Who = "A" | "B";
type SideIndex = 0 | 1;

/** The on-chain series (series.rs `Series`), sides indexed 0 (a) and 1 (b), players "A" and "B". */
export interface OnChainSeries {
  rules: WagerConfig["rules"];
  revealSeconds: number;
  seriesId: string;
  fallbackHash: Record<Who, string>;
  fallback: Record<Who, { kind: (typeof FALLBACK_KINDS)[number]; pull: number } | null>;
  match: number;
  game: { node: number; energy: [number, number]; spent: [number, number]; rounds: number; lastPull: [number, number]; ending: { winner: SideIndex | null; reason: number } | null };
  bank: Record<Who, number>;
  bankOut: Record<Who, boolean>;
  phase: "commit" | "reveal";
  phaseOpenedAt: number;
  round: [OnChainSideRound, OnChainSideRound];
  results: ({ winner: Who | null; reason: number } | null)[];
  ending: { winner: Who | null; reason: number } | null;
}

export interface OnChainSideRound {
  hash: string | null;
  owesFallback: boolean;
  pull: number | null;
}

export interface SeriesAccountData {
  header: SeriesHeader;
  series: OnChainSeries | null;
}

const who = (n: number): Who => {
  if (n !== 0 && n !== 1) throw new Error("not a player");
  return n === 0 ? "A" : "B";
};

export function decodeSeriesAccount(data: Buffer): SeriesAccountData {
  const r = new Reader(data);
  if (r.u8() !== 1) throw new Error("not a version-1 series account");
  const status = r.u8();
  if (status !== SERIES_STATUS.open && status !== SERIES_STATUS.live) throw new Error("not a series in play");
  const header: SeriesHeader = {
    status: status === SERIES_STATUS.open ? "open" : "live",
    seriesId: r.hex(),
    playerA: r.key(),
    playerB: r.key(),
    stake: r.u64(),
    feeBps: r.u16(),
    feeAccount: r.key(),
    ticketKeyId: r.u16(),
    acceptDeadline: r.i64(),
    ticketExpiry: r.i64(),
    lastChange: r.i64(),
    fallbackHashA: r.hex(),
  };
  const series = r.option((): OnChainSeries => {
    const rules = { places: r.u8(), energy: r.u8(), regen: r.u8(), rounds: r.u8(), tieBreakSpent: r.bool(), roundSeconds: r.u32(), bankSeconds: r.u32() };
    const revealSeconds = r.u32();
    const seriesId = r.hex();
    const fallbackHash = { A: r.hex(), B: r.hex() };
    const fb = () => r.option(() => ({ kind: FALLBACK_KINDS[r.u8()] ?? (() => { throw new Error("unknown fallback"); })(), pull: r.u8() }));
    const fallback = { A: fb(), B: fb() };
    const match = r.u8();
    const game = {
      node: r.i8(),
      energy: [r.u8(), r.u8()] as [number, number],
      spent: [r.u16(), r.u16()] as [number, number],
      rounds: r.u8(),
      lastPull: [r.u8(), r.u8()] as [number, number],
      ending: r.option(() => ({ winner: r.option(() => r.u8() as SideIndex), reason: r.u8() })),
    };
    const bank = { A: r.u32(), B: r.u32() };
    const bankOut = { A: r.bool(), B: r.bool() };
    const phase = r.u8() === 0 ? "commit" : "reveal";
    const phaseOpenedAt = r.i64();
    const side = (): OnChainSideRound => ({ hash: r.option(() => r.hex()), owesFallback: r.bool(), pull: r.option(() => r.u8()) });
    const round: [OnChainSideRound, OnChainSideRound] = [side(), side()];
    const results = Array.from({ length: 5 }, () => r.option(() => ({ winner: r.option(() => who(r.u8())), reason: r.u8() })));
    const ending = r.option(() => ({ winner: r.option(() => who(r.u8())), reason: r.u8() }));
    return { rules, revealSeconds, seriesId, fallbackHash, fallback, match, game, bank, bankOut, phase, phaseOpenedAt, round, results, ending };
  });
  return { header, series };
}

/** Player A takes side a (0) in matches 0, 2 and 4, side b (1) in 1 and 3. */
export const sideIndexOf = (player: Who, match: number): SideIndex => (((player === "A") === (match % 2 === 0)) ? 0 : 1);

/** The commit deadline of a side (series.rs `commit_deadline`): a commit must land strictly before it. */
export function commitDeadline(s: OnChainSeries, side: SideIndex): number {
  const player: Who = sideIndexOf("A", s.match) === side ? "A" : "B";
  return s.phaseOpenedAt + Math.min(s.rules.roundSeconds, s.bank[player]);
}

/** The reveal window's end (series.rs `reveal_deadline`): a reveal may land at it, a timeout only after. */
export function revealDeadline(s: OnChainSeries): number {
  return s.phaseOpenedAt + s.revealSeconds;
}
