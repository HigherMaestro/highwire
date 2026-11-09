import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { COMPUTE_UNITS } from "../higher/constants.ts";
import { ValidationError } from "../lib/errors.ts";
import type { Chain } from "./chain.ts";
import { finish, priorityFee, type Finished } from "./envelope.ts";
import {
  decodeSeriesAccount,
  decodeWagerConfig,
  SERIES_PLAYER_OFFSETS,
  seriesAddress,
  ticketCheck,
  ticketMessage,
  wagerConfigAddress,
  wagerInstruction,
  wagerProgram,
  type SeriesAccountData,
  type WagerArgs,
  type WagerConfig,
  type WagerTicket,
} from "./wager-codec.ts";

// The Line's wager transactions (docs/wager-mode.md 7.3). Only the local signer sends them: the sign page refuses every
// wager instruction (assertSafe allows one only when the caller expects exactly that wager) and wagers get no sign
// link. Each goes through finish(), like everything Highwire builds.

export * from "./wager-codec.ts";

function program(chain: Chain): PublicKey {
  const p = wagerProgram(chain.cluster);
  if (!p) throw new ValidationError(`Wagering on The Line isn't deployed on ${chain.cluster} yet.`);
  return p;
}

export async function readWagerConfig(chain: Chain): Promise<WagerConfig> {
  const acc = await chain.connection.getAccountInfo(wagerConfigAddress(program(chain)), "confirmed");
  if (!acc) throw new ValidationError(`The wager program on ${chain.cluster} isn't set up yet.`);
  return decodeWagerConfig(acc.data);
}

/** A series by id, or null when there's no account (never opened, or closed). */
export async function readSeries(chain: Chain, seriesId: string): Promise<SeriesAccountData | null> {
  const acc = await chain.connection.getAccountInfo(seriesAddress(program(chain), seriesId), "confirmed");
  if (!acc || !acc.owner.equals(program(chain)) || acc.data.length === 0) return null;
  return decodeSeriesAccount(acc.data);
}

/** Every series this wallet is a player in, open or live. */
export async function listWalletSeries(chain: Chain, wallet: PublicKey): Promise<SeriesAccountData[]> {
  const p = program(chain);
  const out = new Map<string, SeriesAccountData>();
  for (const offset of [SERIES_PLAYER_OFFSETS.A, SERIES_PLAYER_OFFSETS.B]) {
    const accounts = await chain.connection.getProgramAccounts(p, { commitment: "confirmed", filters: [{ memcmp: { offset, bytes: wallet.toBase58() } }] });
    for (const { account } of accounts) {
      try {
        const s = decodeSeriesAccount(account.data);
        out.set(s.header.seriesId, s);
      } catch {
        /* not a series account */
      }
    }
  }
  return [...out.values()];
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

/** A ticket from the matchmaker and its Ed25519 signature (64 bytes, hex). */
export interface SignedTicket {
  ticket: WagerTicket;
  signature: string;
}

export interface StakeRequest extends SignedTicket {
  wallet: PublicKey;
  /** This player's fallback commitment for the series (fallbackCommitment in highwire-core/arena). */
  fallbackHash: string;
  simulate?: boolean;
}

export interface BuiltStake extends Finished {
  /** Lamports this wallet stakes. */
  stake: bigint;
}

/** The checks both sides make of a ticket before staking: the program's config, the key, the tier, the signature. */
function checkTicket(chain: Chain, config: WagerConfig, s: SignedTicket): Uint8Array {
  const t = s.ticket;
  if (config.paused) throw new ValidationError("Wagering is paused: no new series open or start.");
  if (t.keyId !== config.ticketKeyId) throw new ValidationError("The ticket was signed with a retired matchmaker key; ask for a new pairing.");
  if (!config.tiers.includes(t.stake)) throw new ValidationError("The ticket's stake isn't one of the program's tiers.");
  if (!/^[0-9a-f]{128}$/.test(s.signature)) throw new ValidationError("The ticket's signature is 64 bytes of hex.");
  const sig = Uint8Array.from(Buffer.from(s.signature, "hex"));
  if (!ed25519.verify(sig, ticketMessage(program(chain), t), new PublicKey(config.ticketKey).toBytes())) {
    throw new ValidationError("The ticket isn't signed by the matchmaker's key.");
  }
  return sig;
}

/** Player A: stake and open the series the matchmaker paired. */
export async function buildWagerOpen(chain: Chain, req: StakeRequest): Promise<BuiltStake> {
  const p = program(chain);
  const t = req.ticket;
  if (t.playerA !== req.wallet.toBase58()) throw new ValidationError("This ticket opens a series for another wallet.");
  const now = Math.floor(Date.now() / 1000);
  if (now > t.expiry) throw new ValidationError("The ticket has expired; ask for a new pairing.");
  const config = await readWagerConfig(chain);
  const sig = checkTicket(chain, config, req);
  const microLamports = await priorityFee(chain, [req.wallet, seriesAddress(p, t.seriesId)]);
  const tx = compose(req.wallet, microLamports, [
    ticketCheck(p, t, new PublicKey(config.ticketKey), sig),
    wagerInstruction(p, req.wallet, t.seriesId, { kind: "open", ticket: t, fallbackHash: req.fallbackHash }),
  ]);
  const built = await finish({
    chain,
    wallet: req.wallet,
    kind: "wager",
    simulate: req.simulate,
    txs: [{ tx, label: `stake and open wager series ${t.seriesId.slice(0, 8)}`, expect: { wallet: req.wallet, allowLaunchLab: false, allowCpmm: false, wager: { kind: "open", seriesId: t.seriesId, ticket: t, ticketKey: new PublicKey(config.ticketKey) } } }],
  });
  return { ...built, stake: t.stake };
}

/** Player B: stake and accept the series A opened. */
export async function buildWagerAccept(chain: Chain, req: StakeRequest): Promise<BuiltStake> {
  const p = program(chain);
  const t = req.ticket;
  if (t.playerB !== req.wallet.toBase58()) throw new ValidationError("This ticket is for another wallet to accept.");
  const [config, series] = await Promise.all([readWagerConfig(chain), readSeries(chain, t.seriesId)]);
  if (!series || series.header.status !== "open") throw new ValidationError("That series isn't open: its opener hasn't staked yet, or it has started or closed.");
  const h = series.header;
  if (h.playerA !== t.playerA || h.playerB !== t.playerB || h.stake !== t.stake || h.acceptDeadline !== t.acceptDeadline || h.ticketKeyId !== t.keyId) {
    throw new ValidationError("The series on-chain doesn't match the ticket.");
  }
  if (Math.floor(Date.now() / 1000) > t.acceptDeadline) throw new ValidationError("The time to accept has passed.");
  const sig = checkTicket(chain, config, req);
  const microLamports = await priorityFee(chain, [req.wallet, seriesAddress(p, t.seriesId)]);
  const tx = compose(req.wallet, microLamports, [
    ticketCheck(p, t, new PublicKey(config.ticketKey), sig),
    wagerInstruction(p, req.wallet, t.seriesId, { kind: "accept", fallbackHash: req.fallbackHash }),
  ]);
  const built = await finish({
    chain,
    wallet: req.wallet,
    kind: "wager",
    simulate: req.simulate,
    txs: [{ tx, label: `stake and accept wager series ${t.seriesId.slice(0, 8)}`, expect: { wallet: req.wallet, allowLaunchLab: false, allowCpmm: false, wager: { kind: "accept", seriesId: t.seriesId, ticket: t, ticketKey: new PublicKey(config.ticketKey) } } }],
  });
  return { ...built, stake: t.stake };
}

/** Accounts the runtime won't credit (a program, or anything a loader owns): passed read-only, and the program burns their share. */
const LOADERS = new Set([
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoader1111111111111111111111111111111111",
  "LoaderV411111111111111111111111111111111111",
  "NativeLoader1111111111111111111111111111111",
]);

async function uncreditable(chain: Chain, keys: PublicKey[]): Promise<PublicKey[]> {
  const infos = await chain.connection.getMultipleAccountsInfo(keys, "confirmed");
  return keys.filter((_, i) => {
    const a = infos[i];
    return !!a && (a.executable || LOADERS.has(a.owner.toBase58()));
  });
}

export interface WagerMoveRequest {
  wallet: PublicKey;
  seriesId: string;
  /** Anything but open and accept, which stake (buildWagerOpen, buildWagerAccept). */
  args: Exclude<WagerArgs, { kind: "open" } | { kind: "accept" }>;
  simulate?: boolean;
}

const LABELS: Record<WagerMoveRequest["args"]["kind"], string> = {
  cancel: "cancel the unaccepted series",
  commit: "commit a hidden move",
  reveal: "reveal the move",
  revealFallback: "reveal the fallback",
  timeout: "apply a passed deadline",
  settle: "settle the series",
  retire: "retire from the series",
  emergencyRefund: "refund the idle series",
};

/** A move, a crank or a payout in a series this wallet plays (or, for timeout, settle and refunds, any series). */
export async function buildWagerMove(chain: Chain, req: WagerMoveRequest): Promise<Finished> {
  const p = program(chain);
  const kind = req.args.kind;
  let parties;
  let readOnly: PublicKey[] = [];
  if (kind === "cancel" || kind === "settle" || kind === "emergencyRefund") {
    const series = await readSeries(chain, req.seriesId);
    if (!series) throw new ValidationError("There's no such series open: it was never opened, or it has closed.");
    parties = { playerA: new PublicKey(series.header.playerA), playerB: new PublicKey(series.header.playerB), feeAccount: new PublicKey(series.header.feeAccount) };
    readOnly = await uncreditable(chain, [parties.playerA, parties.playerB, parties.feeAccount]);
  }
  const microLamports = await priorityFee(chain, [req.wallet, seriesAddress(p, req.seriesId)]);
  const tx = compose(req.wallet, microLamports, [wagerInstruction(p, req.wallet, req.seriesId, req.args, parties, readOnly)]);
  return finish({
    chain,
    wallet: req.wallet,
    kind: "wager",
    simulate: req.simulate,
    txs: [{ tx, label: `${LABELS[kind]} (wager series ${req.seriesId.slice(0, 8)})`, expect: { wallet: req.wallet, allowLaunchLab: false, allowCpmm: false, wager: { kind, seriesId: req.seriesId } } }],
  });
}
