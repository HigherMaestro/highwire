import { TxVersion } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { COMPUTE_UNITS, HIGHWIRE_WALLET, highwireFeeApplies, highwireFeeLamports, RENT_EXEMPT_WALLET_LAMPORTS } from "../higher/constants.ts";
import { ValidationError } from "../lib/errors.ts";
import { WSOL, type Chain } from "./chain.ts";
import { describeTransaction, UnsafeTransactionError, type DecodedTrade } from "./decode.ts";
import { finish, priorityFee, type BuiltTx, type Finished, type JitoTip } from "./envelope.ts";
import { quoteFromMarket, vaultBalances, type Quote, type QuoteRequest } from "./quote.ts";

// build_trade: the same transaction higher.fun's site builds for a buy or a
// sell (Raydium SDK launchpad.buyToken / sellToken on the curve, cpmm.swap
// after graduation), for a wallet given only as a public key.

export interface TradeRequest extends QuoteRequest {
  wallet: PublicKey;
  /** For a buy, the most SOL it may spend; for a sell, the most SOL it may return. In lamports. */
  maxLamports: bigint;
  simulate?: boolean;
  /** A protected send's tip (the local signer only). */
  jito?: JitoTip;
}

export interface BuiltTrade extends Finished {
  quote: Quote;
  /** Highwire's trade fee in this transaction, in lamports. */
  highwireFeeLamports: bigint;
}

const asVersioned = (tx: unknown, what: string): VersionedTransaction => {
  if (!(tx instanceof VersionedTransaction)) throw new Error(`expected a v0 transaction from ${what}`);
  return tx;
};

/** Checks the one trade in the bytes against the quote: same kind, mint, amount in, and a min-out no looser than quoted (within 1% on a pool). */
export function assertTradeMatches(trades: DecodedTrade[], quote: Quote, mint: PublicKey): void {
  const fail = (m: string): never => {
    throw new UnsafeTransactionError(m);
  };
  if (trades.length !== 1) fail(`expected exactly one trade in the transaction, found ${trades.length}`);
  const t = trades[0]!;
  const m = mint.toBase58();
  if (quote.stage === "curve") {
    const want = quote.side === "buy" ? "curve-buy" : "curve-sell";
    if (t.kind !== want) fail(`the transaction is a ${t.kind}, not a ${want}`);
    if (t.mint !== m) fail("the transaction trades a different coin");
  } else {
    if (t.kind !== "cpmm-swap") fail(`the transaction is a ${t.kind}, not a pool swap`);
    const [inMint, outMint] = quote.side === "buy" ? [WSOL.toBase58(), m] : [m, WSOL.toBase58()];
    if (t.inputMint !== inMint || t.outputMint !== outMint) fail("the swap goes the wrong way or trades a different coin");
  }
  if (t.amountIn !== quote.amountInUsed) fail("the transaction spends a different amount than quoted");
  if (t.minOut <= 0n) fail("the transaction has no minimum-out guard");
  if (quote.stage === "curve") {
    if (t.minOut !== quote.minOut) fail("the transaction's minimum out isn't the quoted one");
  } else if (t.minOut < (quote.minOut * 99n) / 100n) {
    // The pool is re-read for the swap, so a trade landing in between can move it a little. A move in the user's
    // favour only raises the guard; a move against them may lower it by at most 1%.
    fail("the transaction's minimum out is more than 1% below the quote; quote again");
  }
}

/**
 * Whether Highwire's wallet can take a fee: it must already hold the rent-exempt minimum, or Solana refuses a small
 * transfer into it. If the balance can't be read, assume it can; the simulation would show otherwise.
 */
async function feeWalletReady(chain: Chain): Promise<boolean> {
  try {
    return BigInt(await chain.connection.getBalance(new PublicKey(HIGHWIRE_WALLET), "confirmed")) >= RENT_EXEMPT_WALLET_LAMPORTS;
  } catch {
    return true;
  }
}

/** A trade built and checked against its quote, with Highwire's fee, before finish(): what a claim and buy combines. */
export interface PreparedTrade {
  built: BuiltTx;
  quote: Quote;
  fee: bigint;
}

export async function prepareTrade(chain: Chain, req: TradeRequest): Promise<PreparedTrade> {
  const market = await chain.market(req.mint);
  const vaults = market.stage === "graduated" ? await vaultBalances(chain, market.pool) : undefined;
  const quote = quoteFromMarket(market, req, vaults);
  if (req.side === "buy" && quote.amountInUsed > req.maxLamports) {
    throw new ValidationError("The buy spends more SOL than max_sol allows.", { code: "over_cap" });
  }
  if (req.side === "sell" && quote.amountOut > req.maxLamports) {
    throw new ValidationError("The sell returns more SOL than max_sol allows. Raise max_sol if that's intended.", { code: "over_cap" });
  }

  const raydium = await chain.raydium(req.wallet, [req.mint, WSOL]);
  const slippage = new BN(req.slippageBps);
  let tx: VersionedTransaction;
  if (market.stage === "curve") {
    const microLamports = await priorityFee(chain, [market.poolId, req.mint]);
    const common = {
      computeBudgetConfig: { units: COMPUTE_UNITS.curveTrade, microLamports },
      programId: chain.key("launchLabProgram"),
      authProgramId: chain.key("launchLabAuth"),
      mintA: req.mint,
      poolInfo: market.pool,
      configInfo: market.config,
      slippage,
      feePayer: req.wallet,
      txVersion: TxVersion.V0,
    } as const;
    const built =
      req.side === "buy"
        ? await raydium.launchpad.buyToken({
            ...common,
            buyAmount: new BN(quote.amountInUsed.toString()),
            minMintAAmount: new BN(quote.minOut.toString()),
          })
        : await raydium.launchpad.sellToken({
            ...common,
            sellAmount: new BN(req.amountIn.toString()),
            minAmountB: new BN(quote.minOut.toString()),
          });
    if (built.signers.length > 0) throw new UnsafeTransactionError("the SDK asked for an extra signer");
    tx = asVersioned(built.transaction, req.side === "buy" ? "buyToken" : "sellToken");
  } else {
    const microLamports = await priorityFee(chain, [market.poolId]);
    const { poolInfo, poolKeys, computePoolInfo } = await raydium.cpmm.getPoolInfoFromRpc(market.poolId.toBase58());
    const outputMint = req.side === "buy" ? req.mint : WSOL;
    const inputMint = req.side === "buy" ? WSOL : req.mint;
    const swap = raydium.cpmm.computeSwapAmount({
      pool: computePoolInfo,
      amountIn: new BN(req.amountIn.toString()),
      outputMint,
      slippage: req.slippageBps / 10_000,
    });
    const built = await raydium.cpmm.swap({
      computeBudgetConfig: { units: COMPUTE_UNITS.poolSwap, microLamports },
      poolInfo,
      poolKeys,
      inputAmount: new BN(req.amountIn.toString()),
      swapResult: swap.swapResult,
      slippage: req.slippageBps / 10_000,
      baseIn: inputMint.toBase58() === poolInfo.mintA.address,
      feePayer: req.wallet,
      txVersion: TxVersion.V0,
    });
    if (built.signers.length > 0) throw new UnsafeTransactionError("the SDK asked for an extra signer");
    tx = asVersioned(built.transaction, "cpmm.swap");
  }

  // Highwire's fee, from the trade in the built bytes (a buy's SOL in, a sell's minimum SOL out): the same amounts the
  // sign page bounds it by. A pool sell's minimum out comes from a fresh read of the pool, so the quote's can differ.
  const built = describeTransaction(tx, chain.cluster, await chain.lookupTables([tx]));
  assertTradeMatches(built.trades, quote, req.mint);
  const trade = built.trades[0]!;
  const charged = highwireFeeApplies(chain.cluster) && (await feeWalletReady(chain));
  const fee = charged ? highwireFeeLamports(req.side === "buy" ? trade.amountIn : trade.minOut) : 0n;
  const append = fee > 0n ? [SystemProgram.transfer({ fromPubkey: req.wallet, toPubkey: new PublicKey(HIGHWIRE_WALLET), lamports: fee })] : [];
  return {
    quote,
    fee,
    built: {
      tx,
      append,
      label: `${req.side} ${quote.stage === "curve" ? "on the curve" : "in the CPMM pool"}`,
      expect: {
        wallet: req.wallet,
        platformId: market.stage === "curve" ? market.pool.platformId : undefined,
        allowLaunchLab: market.stage === "curve",
        allowCpmm: market.stage === "graduated",
        ...(fee > 0n ? { highwireFee: { maxLamports: fee, lamports: fee } } : {}),
      },
    },
  };
}

export async function buildTrade(chain: Chain, req: TradeRequest): Promise<BuiltTrade> {
  const { built, quote, fee } = await prepareTrade(chain, req);
  const done = await finish({ chain, wallet: req.wallet, kind: "trade", simulate: req.simulate, jito: req.jito, txs: [built] });
  assertTradeMatches(done.decoded[0]!.trades, quote, req.mint);
  return { ...done, quote, highwireFeeLamports: fee };
}
