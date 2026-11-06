import { Buffer } from "buffer";
import { PublicKey, TransactionMessage, type AddressLookupTableAccount, type VersionedTransaction } from "@solana/web3.js";
import {
  ADDRESSES,
  COMPUTE_UNITS,
  HIGHWIRE_FEE_BPS,
  HIGHWIRE_MEMO,
  HIGHWIRE_WALLET,
  MEMO_PROGRAM_ID,
  PRIORITY_FEE_MICRO_LAMPORTS,
  type Cluster,
} from "../higher/constants.ts";
import { HigherError } from "../lib/errors.ts";
import { formatLamports, formatTokens } from "./units.ts";

// Decodes a transaction's instructions into plain language and checks them
// against what the user asked for: the same review higher.fun's web app runs
// before it hands a transaction to a wallet (its allow-list of programs,
// "only the signer's own accounts", and "the trade in the bytes is the trade
// you quoted").
//
// The signing page runs this module in the browser too, so it imports only
// web3.js and plain modules: no Node built-ins (Buffer comes from the "buffer"
// package there) and no Raydium SDK.

/** A built transaction failed a safety check. Never hand such a transaction to a wallet. */
export class UnsafeTransactionError extends HigherError {
  constructor(message: string) {
    super(message, { code: "unsafe_transaction" });
    this.name = "UnsafeTransactionError";
  }
}

export const PROGRAMS = {
  system: "11111111111111111111111111111111",
  computeBudget: "ComputeBudget111111111111111111111111111111",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  associatedToken: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  memo: MEMO_PROGRAM_ID,
} as const;

/** Wrapped SOL. */
export const NATIVE_MINT_ADDRESS = "So11111111111111111111111111111111111111112";

/** The associated token account of `owner` for `mint` under `tokenProgram`. */
export function associatedTokenAddress(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey = new PublicKey(PROGRAMS.token)): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], new PublicKey(PROGRAMS.associatedToken))[0];
}

/** The plain-language line for Highwire's trade fee. */
export const feeLine = (lamports: bigint) => `Pay Highwire's ${HIGHWIRE_FEE_BPS / 100}% trade fee: ${formatLamports(lamports)} SOL to ${HIGHWIRE_WALLET}`;

/** The plain-language line for the Highwire memo. */
export const MEMO_LINE = `Tags the transaction as built by Highwire (memo "${HIGHWIRE_MEMO}")`;

const isHighwireMemo = (ix: { keys: unknown[]; data: Buffer }) => ix.keys.length === 0 && ix.data.toString("utf8") === HIGHWIRE_MEMO;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Anchor discriminators of the instructions we build. */
export const DISCRIMINATORS = {
  launchLab: {
    initializeV2: "4399af27da102620",
    buyExactIn: "faea0d7bd59c13ec",
    sellExactIn: "9527de9bd37c981a",
    createVestingAccount: "81b2020dd9ace6da",
    claimCreatorFee: "1a618acb84ab8dfc",
  },
  cpmm: {
    swapBaseInput: "8fbe5adac41e33de",
    collectCreatorFee: "1416567bc61cdb84",
  },
} as const;

export type TradeKind = "curve-buy" | "curve-sell" | "cpmm-swap";

export interface DecodedTrade {
  kind: TradeKind;
  /** Lamports for a buy, token base units for a sell. */
  amountIn: bigint;
  minOut: bigint;
  /** For a CPMM swap, the mint paid in and the mint received. */
  inputMint?: string;
  outputMint?: string;
  /** For a curve trade, the coin's mint. */
  mint?: string;
  /** The token account the trade pays into (the coin account on a buy, wrapped SOL on a pool sell). */
  outAccount?: string;
}

export interface DecodedInstruction {
  program: string;
  text: string;
  known: boolean;
}

export interface DecodedTransaction {
  feePayer: string;
  signers: string[];
  instructions: DecodedInstruction[];
  trades: DecodedTrade[];
  /** SOL transfers, by recipient. Highwire's trade fee is in `highwireFees`, not here. */
  transfers: { to: string; lamports: bigint }[];
  /** Highwire's trade fee transfers, in lamports. */
  highwireFees: bigint[];
  /** Token transfers (TransferChecked): the mint, the accounts, and the amount in base units. */
  tokenTransfers: { mint: string; from: string; to: string; owner: string; amount: bigint }[];
  /** Coins created by initialize_v2: the mint and the creator recorded on-chain. */
  launches: { mint: string; creator: string; platform: string; pool: string; name: string; symbol: string; uri: string }[];
  /** Creator fee claims: the curve vault, or a CPMM pool. */
  claims: { kind: "curve" | "pool"; from: string }[];
  /** Creator-lock assignments: the pool and the locked amount in base units. */
  locks: { pool: string; beneficiary: string; amount: bigint }[];
  computeUnitLimit?: number;
  microLamportsPerCu?: bigint;
}

interface CompiledIx {
  programId: PublicKey;
  keys: PublicKey[];
  data: Buffer;
}

/** Instructions with their account keys resolved, through lookup tables when the message uses them. */
export function resolveInstructions(tx: VersionedTransaction, lookupTables: AddressLookupTableAccount[] = []): CompiledIx[] {
  const msg = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: lookupTables });
  return msg.instructions.map((ix) => ({ programId: ix.programId, keys: ix.keys.map((k) => k.pubkey), data: Buffer.from(ix.data) }));
}

function u64(data: Buffer, offset: number): bigint {
  return data.length >= offset + 8 ? data.readBigUInt64LE(offset) : 0n;
}

function borshString(data: Buffer, offset: number): [string, number] {
  const len = data.readUInt32LE(offset);
  return [data.subarray(offset + 4, offset + 4 + len).toString("utf8"), offset + 4 + len];
}

export function describeTransaction(
  tx: VersionedTransaction,
  cluster: Cluster,
  lookupTables: AddressLookupTableAccount[] = [],
): DecodedTransaction {
  const a = ADDRESSES[cluster];
  const keys = tx.message.staticAccountKeys;
  const signers = keys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58());
  const out: DecodedTransaction = {
    feePayer: signers[0] ?? "?",
    signers,
    instructions: [],
    trades: [],
    transfers: [],
    highwireFees: [],
    tokenTransfers: [],
    launches: [],
    claims: [],
    locks: [],
  };

  for (const ix of resolveInstructions(tx, lookupTables)) {
    const program = ix.programId.toBase58();
    const k = (i: number) => ix.keys[i]?.toBase58() ?? "?";
    const d = ix.data;
    const disc = hex(d.subarray(0, 8));
    const known = (text: string) => out.instructions.push({ program, text, known: true });
    const unknown = (what: string) =>
      out.instructions.push({ program, text: `UNKNOWN ${what} (program ${program}, data ${d.toString("hex").slice(0, 64)})`, known: false });

    if (program === PROGRAMS.computeBudget) {
      if (d[0] === 2 && d.length === 5) {
        out.computeUnitLimit = d.readUInt32LE(1);
        known(`Set the compute limit to ${out.computeUnitLimit.toLocaleString("en-US")} units`);
      } else if (d[0] === 3 && d.length === 9) {
        out.microLamportsPerCu = d.readBigUInt64LE(1);
        known(`Set the priority fee to ${out.microLamportsPerCu.toLocaleString("en-US")} micro-lamports per compute unit`);
      } else unknown("compute budget instruction");
    } else if (program === PROGRAMS.system) {
      const type = d.length >= 4 ? d.readUInt32LE(0) : -1;
      if (type === 2 && d.length === 12) {
        const lamports = d.readBigUInt64LE(4);
        if (k(1) === HIGHWIRE_WALLET) {
          out.highwireFees.push(lamports);
          known(feeLine(lamports));
        } else {
          out.transfers.push({ to: k(1), lamports });
          known(`Send ${formatLamports(lamports)} SOL from ${k(0)} to ${k(1)}`);
        }
      } else if (type === 0) known(`Create account ${k(1)}, paid by ${k(0)}`);
      else if (type === 3) known(`Create account ${k(1)} (from a seed of ${k(0)}) to hold wrapped SOL`);
      else unknown("System instruction");
    } else if (program === PROGRAMS.associatedToken) {
      if (d.length === 0 || (d.length === 1 && (d[0] === 0 || d[0] === 1))) {
        known(`Open token account ${k(1)} for mint ${k(3)}, owned by ${k(2)}, if it doesn't exist yet`);
      } else unknown("associated token instruction");
    } else if (program === PROGRAMS.token || program === PROGRAMS.token2022) {
      if (d[0] === 17) known(`Sync wrapped SOL in ${k(0)}`);
      else if (d[0] === 9) known(`Close token account ${k(0)}, returning its SOL to ${k(1)}`);
      else if (d[0] === 1 || d[0] === 16 || d[0] === 18) known(`Initialise token account ${k(0)} for mint ${k(1)}`);
      else if (d[0] === 12 && d.length === 10) {
        const amount = d.readBigUInt64LE(1);
        out.tokenTransfers.push({ mint: k(1), from: k(0), to: k(2), owner: k(3), amount });
        known(`Send ${formatTokens(amount)} tokens of ${k(1)} from token account ${k(0)} to token account ${k(2)}`);
      } else unknown("token instruction");
    } else if (program === a.launchLabProgram) {
      const L = DISCRIMINATORS.launchLab;
      if (disc === L.buyExactIn) {
        const amountIn = u64(d, 8);
        const minOut = u64(d, 16);
        out.trades.push({ kind: "curve-buy", amountIn, minOut, mint: k(9), outAccount: k(5) });
        known(`Buy coin ${k(9)} on the LaunchLab curve (pool ${k(4)}, platform ${k(3)}): pay ${formatLamports(amountIn)} SOL, receive at least ${formatTokens(minOut)} tokens`);
      } else if (disc === L.sellExactIn) {
        const amountIn = u64(d, 8);
        const minOut = u64(d, 16);
        out.trades.push({ kind: "curve-sell", amountIn, minOut, mint: k(9) });
        known(`Sell ${formatTokens(amountIn)} tokens of ${k(9)} on the LaunchLab curve (pool ${k(4)}, platform ${k(3)}), receive at least ${formatLamports(minOut)} SOL`);
      } else if (disc === L.initializeV2) {
        let name = "?";
        let symbol = "?";
        let uri = "?";
        try {
          let o = 8 + 1; // decimals
          [name, o] = borshString(d, o);
          [symbol, o] = borshString(d, o);
          [uri] = borshString(d, o);
        } catch {
          /* leave "?" */
        }
        out.launches.push({ mint: k(6), creator: k(1), platform: k(3), pool: k(5), name, symbol, uri });
        known(`Create coin ${k(6)} ("${name}", $${symbol}) on the LaunchLab curve: creator ${k(1)}, platform ${k(3)}, pool ${k(5)}, metadata ${uri}`);
      } else if (disc === L.createVestingAccount) {
        out.locks.push({ pool: k(2), beneficiary: k(1), amount: u64(d, 8) });
        known(`Assign ${formatTokens(u64(d, 8))} locked tokens of pool ${k(2)} to ${k(1)} (vesting record ${k(3)})`);
      } else if (disc === L.claimCreatorFee) {
        out.claims.push({ kind: "curve", from: k(2) });
        known(`Claim curve creator fees for ${k(0)} from vault ${k(2)} into ${k(3)}`);
      } else unknown("LaunchLab instruction");
    } else if (program === a.cpmmProgram) {
      const C = DISCRIMINATORS.cpmm;
      if (disc === C.swapBaseInput) {
        const amountIn = u64(d, 8);
        const minOut = u64(d, 16);
        const inputMint = k(10);
        const outputMint = k(11);
        out.trades.push({ kind: "cpmm-swap", amountIn, minOut, inputMint, outputMint, outAccount: k(5) });
        const isBuy = inputMint === NATIVE_MINT_ADDRESS;
        known(
          isBuy
            ? `Buy coin ${outputMint} in Raydium CPMM pool ${k(3)}: pay ${formatLamports(amountIn)} SOL, receive at least ${formatTokens(minOut)} tokens`
            : `Sell ${formatTokens(amountIn)} tokens of ${inputMint} in Raydium CPMM pool ${k(3)}, receive at least ${formatLamports(minOut)} SOL`,
        );
      } else if (disc === C.collectCreatorFee) {
        // Accounts: creator, authority, pool, config, vault A, vault B, mint A, mint B, owner's account A, owner's account B, ...
        out.claims.push({ kind: "pool", from: k(2) });
        known(`Collect the pool creator fees of Raydium CPMM pool ${k(2)} into ${k(8)} and ${k(9)}`);
      } else unknown("CPMM instruction");
    } else if (program === PROGRAMS.memo) {
      // Never echo another memo's text: on the signing page it would be a stranger's words in Highwire's voice.
      if (isHighwireMemo(ix)) known(MEMO_LINE);
      else out.instructions.push({ program, text: "UNKNOWN memo (not the Highwire memo)", known: false });
    } else unknown("instruction");
  }
  return out;
}

export function summaryLines(d: DecodedTransaction): string[] {
  return [`Fee payer and signer: ${d.signers.join(", ")}`, ...d.instructions.map((ix, i) => `${i + 1}. ${ix.text}`)];
}

export interface Expectations {
  wallet: PublicKey;
  /** The fee mode's LaunchLab platform config; LaunchLab instructions must name it. */
  platformId?: PublicKey;
  /** Extra signers allowed besides the wallet (the new mint on a launch). */
  extraSigners?: PublicKey[];
  /** A single SOL transfer to this address is allowed, at or under maxLamports (the launch fee). */
  launchFee?: { to: PublicKey; maxLamports: bigint };
  /** Pool a vesting assignment must act on. */
  vestingPool?: PublicKey;
  /** A coin created for someone else (launch for an X or GitHub account): initialize_v2's creator. Default: the wallet. */
  launchCreator?: PublicKey;
  /** A single SOL transfer of exactly `lamports` to the launch-for creator, so they can claim. */
  creatorFunding?: { to: PublicKey; lamports: bigint };
  /** Whether a LaunchLab or CPMM instruction may appear at all. */
  allowCpmm?: boolean;
  allowLaunchLab?: boolean;
  /**
   * A transfer to another wallet: exactly `lamports` of SOL, or exactly `amount` base units of `mint` into the
   * recipient's associated token account (which the transaction may open). Without it, nothing may leave the wallet.
   */
  transfer?: { to: PublicKey; lamports?: bigint; mint?: PublicKey; amount?: bigint };
  /**
   * Highwire's trade fee: one SOL transfer to HIGHWIRE_WALLET of at most `maxLamports`, or exactly `lamports` when the
   * builder knows it. Without it, nothing may go to Highwire.
   */
  highwireFee?: { maxLamports: bigint; lamports?: bigint };
}

/**
 * Throws UnsafeTransactionError unless every instruction is one we build, for
 * the signer's own accounts, on higher.fun's platform and fee tier.
 */
export function assertSafe(tx: VersionedTransaction, cluster: Cluster, exp: Expectations, lookupTables: AddressLookupTableAccount[] = []): void {
  const a = ADDRESSES[cluster];
  const wallet = exp.wallet;
  const w = wallet.toBase58();
  const keys = tx.message.staticAccountKeys;
  const fail = (msg: string): never => {
    throw new UnsafeTransactionError(msg);
  };

  if (!keys[0]?.equals(wallet)) fail("the transaction is paid by a different wallet");
  const required = keys.slice(0, tx.message.header.numRequiredSignatures);
  const allowedSigners = [wallet, ...(exp.extraSigners ?? [])];
  for (const s of required) if (!allowedSigners.some((x) => x.equals(s))) fail(`the transaction needs an unexpected signer: ${s.toBase58()}`);

  const ixs = resolveInstructions(tx, lookupTables);
  const WSOL = new PublicKey(NATIVE_MINT_ADDRESS);
  const isTokenProgram = (k: PublicKey) => k.toBase58() === PROGRAMS.token || k.toBase58() === PROGRAMS.token2022;
  // Accounts this transaction may move the wallet's SOL into: the wallet's own wrapped-SOL accounts. That's its
  // wrapped-SOL ATAs, and accounts the transaction itself creates and initialises for the native mint, owned by the
  // wallet. A coin's token account, or one for any other mint, never takes SOL: an account initialised for a mint
  // someone else controls could be frozen, and one owned by another program could be emptied by it.
  const wsol = new Set([PROGRAMS.token, PROGRAMS.token2022].map((p) => associatedTokenAddress(WSOL, wallet, new PublicKey(p)).toBase58()));
  const created = new Set<string>();
  const initialised = new Map<string, { mint: string; owner: string }>();
  for (const ix of ixs) {
    const p = ix.programId.toBase58();
    const d = ix.data;
    if (p === PROGRAMS.system && d.length >= 4 && (d.readUInt32LE(0) === 0 || d.readUInt32LE(0) === 3) && ix.keys[1]) created.add(ix.keys[1].toBase58());
    if ((p === PROGRAMS.token || p === PROGRAMS.token2022) && ix.keys[0] && ix.keys[1]) {
      if (d[0] === 1 && ix.keys[2]) initialised.set(ix.keys[0].toBase58(), { mint: ix.keys[1].toBase58(), owner: ix.keys[2].toBase58() });
      if ((d[0] === 16 || d[0] === 18) && d.length >= 33) initialised.set(ix.keys[0].toBase58(), { mint: ix.keys[1].toBase58(), owner: new PublicKey(d.subarray(1, 33)).toBase58() });
    }
  }
  for (const k of created) {
    const init = initialised.get(k);
    if (init && init.mint === NATIVE_MINT_ADDRESS && init.owner === w) wsol.add(k);
  }
  const isWsol = (k: PublicKey) => wsol.has(k.toBase58());

  let feeTransfers = 0;
  let highwireFees = 0;
  let fundings = 0;
  let memos = 0;
  let transfers = 0;
  const send = exp.transfer;
  ixs.forEach((ix, i) => {
    const p = ix.programId.toBase58();
    const d = ix.data;
    const key = (n: number) => ix.keys[n] ?? fail(`instruction ${i + 1} is missing account ${n}`);
    if (p === PROGRAMS.computeBudget) {
      if (d[0] === 3 && d.length === 9) {
        if (d.readBigUInt64LE(1) > BigInt(PRIORITY_FEE_MICRO_LAMPORTS.max)) fail(`instruction ${i + 1}: priority fee above the cap`);
      } else if (d[0] === 2 && d.length === 5) {
        if (d.readUInt32LE(1) > 1_400_000) fail(`instruction ${i + 1}: compute limit above Solana's maximum`);
      } else fail(`instruction ${i + 1}: compute budget instruction ${d[0]} is not allowed`);
    } else if (p === PROGRAMS.system) {
      const type = d.length >= 4 ? d.readUInt32LE(0) : -1;
      if (!key(0).equals(wallet)) fail(`instruction ${i + 1}: System instruction spends from an account other than the wallet`);
      if (type === 2 && d.length === 12) {
        const to = key(1);
        const lamports = d.readBigUInt64LE(4);
        if (to.toBase58() === HIGHWIRE_WALLET) {
          if (!exp.highwireFee) fail(`instruction ${i + 1}: a payment to Highwire, which this transaction never makes`);
          if (lamports > exp.highwireFee!.maxLamports) fail(`instruction ${i + 1}: Highwire's fee is more than ${HIGHWIRE_FEE_BPS / 100}% of the trade`);
          if (exp.highwireFee!.lamports !== undefined && lamports !== exp.highwireFee!.lamports) fail(`instruction ${i + 1}: Highwire's fee isn't the quoted one`);
          if (++highwireFees > 1) fail(`instruction ${i + 1}: more than one payment to Highwire`);
        } else if (exp.launchFee && to.equals(exp.launchFee.to)) {
          if (lamports > exp.launchFee.maxLamports) fail(`instruction ${i + 1}: launch fee above the quoted amount`);
          if (++feeTransfers > 1) fail(`instruction ${i + 1}: more than one launch fee transfer`);
        } else if (exp.creatorFunding && to.equals(exp.creatorFunding.to)) {
          if (lamports !== exp.creatorFunding.lamports) fail(`instruction ${i + 1}: sends the coin's creator a different amount than asked`);
          if (++fundings > 1) fail(`instruction ${i + 1}: more than one transfer to the coin's creator`);
        } else if (send?.lamports !== undefined && to.equals(send.to)) {
          if (lamports !== send.lamports) fail(`instruction ${i + 1}: sends a different amount of SOL than asked`);
          if (++transfers > 1) fail(`instruction ${i + 1}: more than one transfer`);
        } else if (!isWsol(to)) fail(`instruction ${i + 1}: SOL transfer to ${to.toBase58()}, which is not the wallet's own wrapped-SOL account`);
      } else if (type === 0 || type === 3) {
        // CreateAccount and CreateAccountWithSeed both end with lamports (u64), space (u64) and the owning program.
        if (d.length < 4 + 8 + 8 + 32) fail(`instruction ${i + 1}: a malformed create-account instruction`);
        const owner = new PublicKey(d.subarray(d.length - 32));
        const space = d.readBigUInt64LE(d.length - 40);
        if (!isTokenProgram(owner)) fail(`instruction ${i + 1}: creates an account owned by ${owner.toBase58()}, not a token program`);
        if (space > 200n) fail(`instruction ${i + 1}: creates an account bigger than a token account`);
        if (!isWsol(key(1))) fail(`instruction ${i + 1}: creates an account that isn't initialised as the wallet's own wrapped SOL`);
      } else fail(`instruction ${i + 1}: System instruction ${type} is not allowed`);
    } else if (p === PROGRAMS.associatedToken) {
      if (!(d.length === 0 || (d.length === 1 && (d[0] === 0 || d[0] === 1)))) fail(`instruction ${i + 1}: associated-token instruction not allowed`);
      if (!key(0).equals(wallet)) fail(`instruction ${i + 1}: opens a token account paid for by someone else`);
      // The ATA program runs whatever token program it's given, so pin it, and the address it derives.
      if (!isTokenProgram(key(5))) fail(`instruction ${i + 1}: opens a token account under ${key(5).toBase58()}, which isn't a token program`);
      if (key(4).toBase58() !== PROGRAMS.system) fail(`instruction ${i + 1}: opens a token account with an unexpected system program`);
      if (!key(1).equals(associatedTokenAddress(key(3), key(2), key(5)))) fail(`instruction ${i + 1}: the token account isn't the associated address for its owner and mint`);
      // A token transfer may open the recipient's own associated account for the coin it sends.
      const forRecipient =
        send?.mint !== undefined && key(2).equals(send.to) && key(3).equals(send.mint) && key(1).equals(associatedTokenAddress(send.mint, send.to, key(5)));
      if (!key(2).equals(wallet) && !forRecipient) fail(`instruction ${i + 1}: opens a token account for someone else`);
    } else if (p === PROGRAMS.token || p === PROGRAMS.token2022) {
      const t = d[0];
      if (t === 17) {
        if (!isWsol(key(0))) fail(`instruction ${i + 1}: syncs an account that isn't the wallet's wrapped SOL`);
        return;
      }
      if (t === 1 || t === 16 || t === 18) {
        if (!isWsol(key(0)) || !created.has(key(0).toBase58())) fail(`instruction ${i + 1}: initialises a token account that isn't the wallet's own wrapped SOL`);
        return;
      }
      if (t === 9) {
        if (!isWsol(key(0))) fail(`instruction ${i + 1}: closes an account that isn't the wallet's wrapped SOL`);
        if (!key(1).equals(wallet) || !key(2).equals(wallet)) fail(`instruction ${i + 1}: closes a token account to someone other than the wallet`);
        return;
      }
      if (t === 12 && d.length === 10) {
        const sendMint = send?.mint;
        if (!send || !sendMint || send.amount === undefined) return fail(`instruction ${i + 1}: a token transfer, which this flow never makes`);
        if (!key(1).equals(sendMint)) fail(`instruction ${i + 1}: sends a different coin than asked`);
        if (!key(0).equals(associatedTokenAddress(sendMint, wallet, ix.programId)) || !key(3).equals(wallet)) {
          fail(`instruction ${i + 1}: sends from an account that isn't the wallet's`);
        }
        if (!key(2).equals(associatedTokenAddress(sendMint, send.to, ix.programId))) fail(`instruction ${i + 1}: sends to an account that isn't the recipient's`);
        if (d.readBigUInt64LE(1) !== send.amount) fail(`instruction ${i + 1}: sends a different amount than asked`);
        if (++transfers > 1) fail(`instruction ${i + 1}: more than one transfer`);
        return;
      }
      fail(`instruction ${i + 1}: token instruction ${t} is not allowed`);
    } else if (p === a.launchLabProgram) {
      if (exp.allowLaunchLab === false) fail(`instruction ${i + 1}: this flow never calls LaunchLab`);
      const L = DISCRIMINATORS.launchLab;
      const disc = hex(d.subarray(0, 8));
      if (disc === L.claimCreatorFee) {
        if (!key(0).equals(wallet)) fail(`instruction ${i + 1}: creator fee claim for someone else`);
        if (!key(3).equals(associatedTokenAddress(key(4), wallet, key(5)))) fail(`instruction ${i + 1}: creator fee claim into someone else's account`);
        return;
      }
      if (disc === L.createVestingAccount) {
        if (!exp.vestingPool || !key(2).equals(exp.vestingPool)) fail(`instruction ${i + 1}: vesting assignment on an unexpected pool`);
        if (!key(0).equals(wallet) || !key(1).equals(wallet)) fail(`instruction ${i + 1}: assigns the lock to someone other than the wallet`);
        return;
      }
      const platformIndex = disc === L.initializeV2 ? 3 : disc === L.buyExactIn || disc === L.sellExactIn ? 3 : -1;
      if (platformIndex < 0) fail(`instruction ${i + 1}: a LaunchLab instruction Highwire does not build`);
      if (!exp.platformId || !key(platformIndex).equals(exp.platformId)) fail(`instruction ${i + 1}: LaunchLab instruction for a platform other than higher.fun's`);
      if (!key(0).equals(wallet)) fail(`instruction ${i + 1}: LaunchLab instruction for someone other than the wallet`);
      if (disc === L.initializeV2 && !key(1).equals(exp.launchCreator ?? wallet)) fail(`instruction ${i + 1}: the coin isn't being created for the wallet`);
      if (disc === L.buyExactIn || disc === L.sellExactIn) {
        // Exactly the accounts Highwire builds: the wallet's own coin account and wrapped SOL, the pool's vaults under
        // LaunchLab's authority, the platform's fee vault, and no share-fee receiver.
        if (ix.keys.length !== 18 || d.length !== 32) fail(`instruction ${i + 1}: a curve trade with an unexpected layout`);
        if (d.readBigUInt64LE(24) !== 0n) fail(`instruction ${i + 1}: a curve trade that pays a share fee to someone`);
        if (d.readBigUInt64LE(16) === 0n) fail(`instruction ${i + 1}: a curve trade with no minimum-out guard`);
        if (key(1).toBase58() !== a.launchLabAuth || key(14).toBase58() !== a.launchLabProgram) fail(`instruction ${i + 1}: a curve trade with unexpected LaunchLab accounts`);
        if (!key(10).equals(WSOL) || key(12).toBase58() !== PROGRAMS.token || !isTokenProgram(key(11))) fail(`instruction ${i + 1}: a curve trade that isn't against SOL`);
        if (!key(5).equals(associatedTokenAddress(key(9), wallet, key(11)))) fail(`instruction ${i + 1}: a curve trade into or out of a coin account that isn't the wallet's`);
        if (!isWsol(key(6))) fail(`instruction ${i + 1}: a curve trade paying from or into SOL that isn't the wallet's`);
        const platformVault = PublicKey.findProgramAddressSync([key(3).toBuffer(), WSOL.toBuffer()], ix.programId)[0];
        if (!key(16).equals(platformVault)) fail(`instruction ${i + 1}: a curve trade with the wrong platform fee vault`);
      }
    } else if (p === a.cpmmProgram) {
      if (exp.allowCpmm === false) fail(`instruction ${i + 1}: this flow never calls the CPMM program`);
      const C = DISCRIMINATORS.cpmm;
      const disc = hex(d.subarray(0, 8));
      const ownAta = (acct: number, mint: number, prog: number) =>
        (key(mint).equals(WSOL) && isWsol(key(acct))) || key(acct).equals(associatedTokenAddress(key(mint), wallet, key(prog)));
      if (disc === C.swapBaseInput) {
        if (!key(0).equals(wallet)) fail(`instruction ${i + 1}: CPMM swap for someone else`);
        if (d.length < 24 || d.readBigUInt64LE(16) === 0n) fail(`instruction ${i + 1}: a pool swap with no minimum-out guard`);
        if (!key(10).equals(WSOL) && !key(11).equals(WSOL)) fail(`instruction ${i + 1}: a pool swap that isn't against SOL`);
        if (!key(2).toBase58() || key(2).toBase58() !== a.cpmmConfig) fail(`instruction ${i + 1}: CPMM swap outside higher.fun's fee tier`);
        if (!ownAta(4, 10, 8) || !ownAta(5, 11, 9)) fail(`instruction ${i + 1}: CPMM swap pays from or into an account that isn't the wallet's`);
      } else if (disc === C.collectCreatorFee) {
        if (!key(0).equals(wallet)) fail(`instruction ${i + 1}: creator fee collect for someone else`);
        if (key(3).toBase58() !== a.cpmmConfig) fail(`instruction ${i + 1}: creator fee collect outside higher.fun's fee tier`);
        if (!ownAta(8, 6, 10) || !ownAta(9, 7, 11)) fail(`instruction ${i + 1}: creator fee collect into an account that isn't the wallet's`);
      } else fail(`instruction ${i + 1}: a CPMM instruction Highwire does not build`);
    } else if (p === PROGRAMS.memo) {
      if (!isHighwireMemo(ix)) fail(`instruction ${i + 1}: a memo other than Highwire's`);
      if (++memos > 1) fail(`instruction ${i + 1}: more than one memo`);
    } else fail(`instruction ${i + 1} calls a program outside the allow-list: ${p}`);
  });
  if (exp.launchFee && feeTransfers !== 1) fail("the launch fee must be paid exactly once");
  if (send && transfers !== 1) fail("the transfer must happen exactly once");
  if (exp.highwireFee?.lamports !== undefined && exp.highwireFee.lamports > 0n && highwireFees !== 1) fail("Highwire's trade fee must be paid exactly once");
}

/** Default compute limits, re-exported for the builders. */
export { COMPUTE_UNITS };
