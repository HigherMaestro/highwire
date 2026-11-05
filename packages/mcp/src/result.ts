import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  HigherError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ServerError,
  TimeoutError,
  ValidationError,
} from "highwire-core";

// Results are pretty JSON text. Failures come back as `{error, code, next_step}`
// with isError set, so the model knows what to try next.

export function jsonResult(data: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export interface FriendlyError {
  error: string;
  code: string;
  next_step?: string;
}

/** Next steps for the error codes the transaction builders raise. */
const NEXT_STEPS: Record<string, string> = {
  unsafe_transaction:
    "Don't sign anything. A safety check on the built transaction failed; report this, and don't retry with other parameters.",
  not_higher_coin: "Check the mint. Use search_coins to find a higher.fun coin by name or ticker.",
  migrating: "The coin just finished its curve and is moving to its Raydium pool. Wait a minute, then quote again.",
  over_cap: "Show the user the quote, and raise max_sol only if they want the bigger trade.",
  idempotency_conflict: "Use a new idempotency_key for a different coin, or the same parameters to retry this one.",
  ticker_taken: "Pick another ticker; check_ticker tells you whether one is free.",
};

export function friendlyError(err: unknown): FriendlyError {
  if (err instanceof HigherError && err.code && NEXT_STEPS[err.code]) {
    return { error: err.message, code: err.code, next_step: NEXT_STEPS[err.code] };
  }
  if (err instanceof NotFoundError) {
    return {
      error: err.message,
      code: "not_found",
      next_step: "Check the mint or wallet address. Use search_coins to find a coin by name or ticker.",
    };
  }
  if (err instanceof ValidationError) {
    return { error: err.message, code: err.code ?? "bad_request", next_step: "Fix the parameters and try again." };
  }
  if (err instanceof RateLimitError) {
    return { error: err.message, code: "rate_limited", next_step: "Wait a few seconds, then retry once." };
  }
  if (err instanceof ServerError || err instanceof NetworkError || err instanceof TimeoutError) {
    return {
      error: err.message,
      code: "unavailable",
      next_step: "higher.fun or the Solana RPC is not answering. Retry later, and say so to the user rather than guessing.",
    };
  }
  if (err instanceof HigherError) {
    return { error: err.message, code: err.code ?? `http_${err.status ?? "error"}` };
  }
  return { error: err instanceof Error ? err.message : String(err), code: "internal_error" };
}

/** Like run(), for a body that builds its own result, such as an error that carries extra detail. */
export async function runResult(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return jsonResult(friendlyError(err), true);
  }
}

/** Run a tool body and turn any thrown error into an isError result. */
export async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await fn());
  } catch (err) {
    return jsonResult(friendlyError(err), true);
  }
}
