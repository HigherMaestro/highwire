import { TxVersion } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { COMPUTE_UNITS } from "../higher/constants.ts";
import { ValidationError } from "../lib/errors.ts";
import { WSOL, type Chain } from "./chain.ts";
import { UnsafeTransactionError, type DecodedTrade } from "./decode.ts";
import { finish, priorityFee, type Finished } from "./envelope.ts";
import { quoteFromMarket, vaultBalances, type Quote, type QuoteRequest } from "./quote.ts";

// build_trade: the same transaction higher.fun's site builds for a buy or a
// sell (Raydium SDK launchpad.buyToken / sellToken on the curve, cpmm.swap
// after graduation), for a wallet given only as a public key.

export interface TradeRequest extends QuoteRequest {
  wallet: PublicKey;
  /** For a buy, the most SOL it may spend; for a sell, the most SOL it may return. In lamports. */
  maxLamports: bigint;
  simulate?: boolean;
}

export interface BuiltTrade extends Finished {
  quote: Quote;
}

const asVersioned = (tx: unknown, what: string): VersionedTransaction => {
  if (!(tx instanceof VersionedTransaction)) throw new Error(`expected a v0 transaction from ${what}`);
  return tx;
};

/** Checks the one trade in the bytes against the quote: same kind, mint, amount in, and a min-out no looser than quoted. */
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
  } else if (t.minOut > quote.amountOut || t.minOut < (quote.minOut * 99n) / 100n) {
    // The pool is re-read for the swap, so a trade landing in between can move it a little.
    fail("the transaction's minimum out is more than 1% away from the quote; quote again");
  }
}

export async function buildTrade(chain: Chain, req: TradeRequest): Promise<BuiltTrade> {
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

  const done = await finish({
    chain,
    wallet: req.wallet,
    kind: "trade",
    simulate: req.simulate,
    txs: [
      {
        tx,
        label: `${req.side} ${quote.stage === "curve" ? "on the curve" : "in the CPMM pool"}`,
        expect: {
          wallet: req.wallet,
          platformId: market.stage === "curve" ? market.pool.platformId : undefined,
          allowLaunchLab: market.stage === "curve",
          allowCpmm: market.stage === "graduated",
        },
      },
    ],
  });
  assertTradeMatches(done.decoded[0]!.trades, quote, req.mint);
  return { ...done, quote };
}
