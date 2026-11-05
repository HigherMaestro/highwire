import { LAMPORTS_PER_SOL, TOKEN_DECIMALS } from "../higher/constants.ts";
import { ValidationError } from "../lib/errors.ts";

// Exact conversions between the units tools speak (SOL, whole tokens) and the
// integers on-chain (lamports, base units). Floats never touch an amount
// that goes into a transaction.

function toBaseUnits(value: number | string, decimals: number, what: string): bigint {
  const s = typeof value === "number" ? value.toFixed(decimals + 3) : value.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new ValidationError(`${what} must be a positive decimal number, got "${value}"`);
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

export function solToLamports(sol: number | string): bigint {
  return toBaseUnits(sol, 9, "SOL amount");
}

export function tokensToBase(tokens: number | string): bigint {
  return toBaseUnits(tokens, TOKEN_DECIMALS, "token amount");
}

function fromBaseUnits(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

/** "1,234.5" style, exact. */
export function formatLamports(v: bigint): string {
  return fromBaseUnits(v, 9);
}

export function formatTokens(v: bigint): string {
  return fromBaseUnits(v, TOKEN_DECIMALS);
}

/** A number for JSON output. Fine for display; never feed it back into a transaction. */
export function lamportsNumber(v: bigint): number {
  return Number(v) / LAMPORTS_PER_SOL;
}

export function tokensNumber(v: bigint): number {
  return Number(v) / 10 ** TOKEN_DECIMALS;
}
