// The arithmetic behind the ideas' calculators, kept apart from the component so it can be tested.

/** New school curve rates, and Highwire's trade fee, in percent. */
export const CREATOR_PCT = 0.25;
export const HOLDERS_PCT = 0.25;
export const HIGHWIRE_PCT = 0.3;

/**
 * One round: buy with `buySol`, then sell after the price moves `movePct`. The coin's trading fee comes out of the
 * buy's SOL and the sale's; Highwire's 0.3% is a transfer on top of the buy and out of the sale. Slippage, price
 * impact and network fees aside.
 */
export function roundTrip(buySol: number, movePct: number, tradeFeePct: number) {
  const c = tradeFeePct / 100;
  const h = HIGHWIRE_PCT / 100;
  const paid = buySol * (1 + h);
  const saleSol = buySol * (1 - c) * (1 + movePct / 100) * (1 - c);
  const received = saleSol * (1 - h);
  return { paid, received, net: received - paid, highwire: buySol * h + saleSol * h };
}

/** The rise a round needs to come out even. */
export const breakEvenPct = (tradeFeePct: number) => {
  const c = tradeFeePct / 100;
  const h = HIGHWIRE_PCT / 100;
  return ((1 + h) / ((1 - c) ** 2 * (1 - h)) - 1) * 100;
};

/** The share of rounds that must hit the take-profit, the rest the stop, to come out even; null when a win loses too. */
export function winsToBreakEven(winNet: number, lossNet: number): number | null {
  if (winNet <= 0) return null;
  const loss = Math.max(0, -lossNet);
  return loss / (winNet + loss);
}
