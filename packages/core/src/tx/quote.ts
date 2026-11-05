import { Curve, CurveCalculator } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import type { PublicKey } from "@solana/web3.js";
import { FEE_MODES, type FeeMode } from "../higher/constants.ts";
import { round } from "../higher/format.ts";
import { ValidationError } from "../lib/errors.ts";
import { WSOL, type Chain, type CpmmConfigState, type CpmmPoolState, type Market } from "./chain.ts";
import { lamportsNumber, tokensNumber } from "./units.ts";

// Quotes for buys and sells, on the LaunchLab curve or the graduated CPMM
// pool, with the same maths Raydium's SDK (and so higher.fun's site) uses.

export type TradeSide = "buy" | "sell";

export const MAX_SLIPPAGE_BPS = 1500;

export interface QuoteRequest {
  mint: PublicKey;
  side: TradeSide;
  /** Lamports in for a buy, token base units in for a sell. */
  amountIn: bigint;
  slippageBps: number;
}

export interface FeeLine {
  to: string;
  lamports: bigint;
  /** True when the fee is charged in tokens and shown here at the pool's price. */
  approx?: boolean;
}

export interface Quote {
  mint: string;
  side: TradeSide;
  stage: "curve" | "graduated";
  mode: FeeMode;
  poolId: string;
  amountIn: bigint;
  /** Less than amountIn when a buy would overshoot the curve's graduation target. */
  amountInUsed: bigint;
  amountOut: bigint;
  minOut: bigint;
  slippageBps: number;
  fees: FeeLine[];
  feeTotalLamports: bigint;
  /** Price movement caused by this trade alone, fees excluded. */
  priceImpactPct: number | null;
  /** SOL per whole token before the trade. */
  spotPriceSol: number | null;
  /** SOL per whole token this trade gets, fees included. */
  effectivePriceSol: number | null;
  notes: string[];
}

export function checkSlippage(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SLIPPAGE_BPS) {
    throw new ValidationError(`slippage must be a whole number of bps from 0 to ${MAX_SLIPPAGE_BPS}`);
  }
}

const big = (b: BN | bigint | number | string) => BigInt(b.toString());
const bn = (b: bigint) => new BN(b.toString());

function minOutFor(out: bigint, slippageBps: number): bigint {
  return (out * BigInt(10_000 - slippageBps)) / 10_000n;
}

function impact(inNet: bigint, outGross: bigint, inReserve: bigint, outReserve: bigint): number | null {
  if (inNet <= 0n || inReserve <= 0n || outReserve <= 0n) return null;
  // Spot would give inNet * outReserve / inReserve; impact is the shortfall.
  const spotOut = Number(inNet) * (Number(outReserve) / Number(inReserve));
  if (spotOut <= 0) return null;
  return round(Math.max(0, (1 - Number(outGross) / spotOut) * 100), 4);
}

function priceSolPerToken(lamports: bigint, base: bigint): number | null {
  if (lamports <= 0n || base <= 0n) return null;
  return lamportsNumber(lamports) / tokensNumber(base);
}

export function quoteFromMarket(market: Market, req: QuoteRequest, vaults?: { vaultA: bigint; vaultB: bigint }): Quote {
  checkSlippage(req.slippageBps);
  if (req.amountIn <= 0n) throw new ValidationError("the amount must be more than zero");
  if (market.stage === "migrating") {
    throw new ValidationError("This coin has just completed its curve and is moving to its Raydium pool. Try again in a minute.", {
      code: "migrating",
    });
  }
  return market.stage === "graduated" ? cpmmQuote(market, { ...req, ...vaults }) : curveQuote(market, req);
}

function curveQuote(market: Extract<Market, { stage: "curve" | "migrating" }>, req: QuoteRequest): Quote {
  const { pool, config, platform } = market;
  const rates = {
    protocolFeeRate: config.tradeFeeRate,
    platformFeeRate: platform.feeRate,
    creatorFeeRate: platform.creatorFeeRate,
    shareFeeRate: new BN(0),
    curveType: config.curveType,
    transferFeeConfigA: undefined,
    transferFeeConfigB: undefined,
    slot: 0,
  };
  // Constant-product curve: reserves are virtual plus real.
  const solReserve = big(pool.virtualB) + big(pool.realB);
  const tokenReserve = big(pool.virtualA) - big(pool.realA);
  const constantProduct = config.curveType === 0;
  const notes: string[] = [];

  let amountInUsed: bigint;
  let amountOut: bigint;
  let split: { protocolFee: BN; platformFee: BN; creatorFee: BN; shareFee: BN };
  let priceImpactPct: number | null = null;
  let effective: number | null;
  if (req.side === "buy") {
    const r = Curve.buyExactIn({ poolInfo: pool, amountB: bn(req.amountIn), ...rates });
    amountInUsed = big(r.amountB);
    amountOut = big(r.amountA.amount) - big(r.amountA.fee ?? 0);
    split = r.splitFee;
    const fee = big(split.protocolFee) + big(split.platformFee) + big(split.creatorFee);
    if (constantProduct) priceImpactPct = impact(amountInUsed - fee, amountOut, solReserve, tokenReserve);
    effective = priceSolPerToken(amountInUsed, amountOut);
    if (amountInUsed < req.amountIn) {
      notes.push(
        `Only ${lamportsNumber(amountInUsed)} SOL fits before the curve completes; this buy graduates the coin. The rest stays in the wallet.`,
      );
    }
  } else {
    const realA = big(pool.realA);
    if (req.amountIn > realA) throw new ValidationError("That's more tokens than the curve has sold; it can't buy them back.");
    const r = Curve.sellExactIn({ poolInfo: pool, amountA: bn(req.amountIn), ...rates });
    amountInUsed = req.amountIn;
    amountOut = big(r.amountB);
    split = r.splitFee;
    const fee = big(split.protocolFee) + big(split.platformFee) + big(split.creatorFee);
    if (constantProduct) priceImpactPct = impact(req.amountIn, amountOut + fee, tokenReserve, solReserve);
    effective = priceSolPerToken(amountOut, req.amountIn);
  }
  const fees: FeeLine[] = [
    { to: "Raydium (LaunchLab protocol fee)", lamports: big(split.protocolFee) },
    { to: "higher.fun (platform fee)", lamports: big(split.platformFee) },
    { to: "the coin's creator", lamports: big(split.creatorFee) },
  ].filter((f) => f.lamports > 0n || f.to.startsWith("Raydium"));
  return {
    mint: market.mint.toBase58(),
    side: req.side,
    stage: "curve",
    mode: market.mode,
    poolId: market.poolId.toBase58(),
    amountIn: req.amountIn,
    amountInUsed,
    amountOut,
    minOut: minOutFor(amountOut, req.slippageBps),
    slippageBps: req.slippageBps,
    fees,
    feeTotalLamports: fees.reduce((n, f) => n + f.lamports, 0n),
    priceImpactPct,
    spotPriceSol: constantProduct ? priceSolPerToken(solReserve, tokenReserve) : null,
    effectivePriceSol: effective,
    notes,
  };
}

/** Pool reserves net of fees the pool owes out (protocol, fund, creator), as the program computes them. */
export function cpmmReserves(pool: CpmmPoolState, vaultA: bigint, vaultB: bigint) {
  const a = vaultA - big(pool.protocolFeesMintA) - big(pool.fundFeesMintA) - big(pool.creatorFeesMintA);
  const b = vaultB - big(pool.protocolFeesMintB) - big(pool.fundFeesMintB) - big(pool.creatorFeesMintB);
  return { a, b };
}

export interface CpmmQuoteInputs {
  pool: CpmmPoolState;
  config: CpmmConfigState;
  vaultA: bigint;
  vaultB: bigint;
}

function cpmmQuote(market: Extract<Market, { stage: "graduated" }>, req: QuoteRequest & Partial<CpmmQuoteInputs>): Quote {
  if (req.vaultA === undefined || req.vaultB === undefined) throw new Error("cpmmQuote needs vault balances");
  const { pool, config } = market;
  const { a, b } = cpmmReserves(pool, req.vaultA, req.vaultB);
  const solIsA = pool.mintA.equals(WSOL);
  const [solReserve, tokenReserve] = solIsA ? [a, b] : [b, a];
  const buying = req.side === "buy";
  const [inReserve, outReserve] = buying ? [solReserve, tokenReserve] : [tokenReserve, solReserve];
  // feeOn: 0 both tokens (fee on input), 1 only token A, 2 only token B.
  const inputIsA = buying ? solIsA : !solIsA;
  const feeOn = Number(pool.feeOn);
  const creatorFeeOnInput = feeOn === 0 || (feeOn === 1 && inputIsA) || (feeOn === 2 && !inputIsA);
  const creatorRate = pool.enableCreatorFee ? config.creatorFeeRate : new BN(0);
  const r = CurveCalculator.swapBaseInput(
    bn(req.amountIn),
    bn(inReserve),
    bn(outReserve),
    config.tradeFeeRate,
    creatorRate,
    config.protocolFeeRate,
    config.fundFeeRate,
    creatorFeeOnInput,
  );
  const amountOut = big(r.outputAmount);
  const inNet = big(r.newInputVaultAmount) - inReserve;
  const outGross = outReserve - big(r.newOutputVaultAmount);
  const spot = priceSolPerToken(solReserve, tokenReserve) ?? 0;
  // Express a token-side fee in lamports at the pool price.
  const asLamports = (amount: bigint, inSol: boolean): FeeLine["lamports"] =>
    inSol ? amount : BigInt(Math.round(tokensNumber(amount) * spot * 1e9));
  const tradeFeeInSol = buying;
  const creatorFeeInSol = creatorFeeOnInput ? buying : !buying;
  const raydiumShare = big(r.protocolFee) + big(r.fundFee);
  const lpShare = big(r.tradeFee) - raydiumShare;
  const mode = FEE_MODES[market.mode];
  const lpLine =
    market.mode === "rewards"
      ? "liquidity providers (30% of the LP is locked for higher.fun, which pays the creator a third of its fees; the rest is burned)"
      : "liquidity providers (all LP was burned at graduation, so this stays in the pool)";
  const fees: FeeLine[] = [
    { to: "Raydium (CPMM protocol and fund fees)", lamports: asLamports(raydiumShare, tradeFeeInSol), approx: !tradeFeeInSol || undefined },
    { to: lpLine, lamports: asLamports(lpShare, tradeFeeInSol), approx: !tradeFeeInSol || undefined },
    { to: "the coin's creator (CPMM pool creator fee)", lamports: asLamports(big(r.creatorFee), creatorFeeInSol), approx: !creatorFeeInSol || undefined },
  ];
  return {
    mint: market.mint.toBase58(),
    side: req.side,
    stage: "graduated",
    mode: market.mode,
    poolId: market.poolId.toBase58(),
    amountIn: req.amountIn,
    amountInUsed: req.amountIn,
    amountOut,
    minOut: minOutFor(amountOut, req.slippageBps),
    slippageBps: req.slippageBps,
    fees,
    feeTotalLamports: fees.reduce((n, f) => n + f.lamports, 0n),
    priceImpactPct: impact(inNet, outGross, inReserve, outReserve),
    spotPriceSol: priceSolPerToken(solReserve, tokenReserve),
    effectivePriceSol: buying ? priceSolPerToken(req.amountIn, amountOut) : priceSolPerToken(amountOut, req.amountIn),
    notes: [`${mode.label} coin, graduated to a Raydium CPMM pool.`],
  };
}

/** Reads the market and returns a quote. */
export async function quoteTrade(chain: Chain, req: QuoteRequest): Promise<Quote> {
  const market = await chain.market(req.mint);
  if (market.stage !== "graduated") return quoteFromMarket(market, req);
  return quoteFromMarket(market, req, await vaultBalances(chain, market.pool));
}

export async function vaultBalances(chain: Chain, pool: CpmmPoolState): Promise<{ vaultA: bigint; vaultB: bigint }> {
  const [va, vb] = await Promise.all([
    chain.connection.getTokenAccountBalance(pool.vaultA),
    chain.connection.getTokenAccountBalance(pool.vaultB),
  ]);
  return { vaultA: BigInt(va.value.amount), vaultB: BigInt(vb.value.amount) };
}

/** A quote in tool units: SOL, whole tokens, percentages. */
export function summarizeQuote(q: Quote) {
  const buying = q.side === "buy";
  const sol = (v: bigint) => lamportsNumber(v);
  const tok = (v: bigint) => tokensNumber(v);
  return {
    mint: q.mint,
    side: q.side,
    venue: q.stage === "curve" ? "Raydium LaunchLab bonding curve" : "Raydium CPMM pool (graduated)",
    feeMode: { mode: q.mode, label: FEE_MODES[q.mode].label },
    poolId: q.poolId,
    ...(buying
      ? { solIn: sol(q.amountInUsed), tokensOut: tok(q.amountOut), minTokensOut: tok(q.minOut) }
      : { tokensIn: tok(q.amountIn), solOut: sol(q.amountOut), minSolOut: sol(q.minOut) }),
    slippagePct: q.slippageBps / 100,
    priceImpactPct: q.priceImpactPct,
    spotPriceSol: q.spotPriceSol,
    effectivePriceSol: q.effectivePriceSol,
    fees: {
      totalSol: sol(q.feeTotalLamports),
      split: q.fees.map((f) => ({ to: f.to, sol: sol(f.lamports), ...(f.approx ? { note: "charged in tokens; shown at the pool price" } : {}) })),
    },
    notes: q.notes,
  };
}
