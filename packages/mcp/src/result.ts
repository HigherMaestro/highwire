import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  HigherError,
  NetworkError,
  NotFoundError,
  publicMessage,
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
  no_policy:
    "Nothing executes without a policy. Tell the user: `highwire policy init` writes a starting one (devnet, dry run) at the path in the error. Or use the build tool and the sign_url instead.",
  policy_invalid: "Tell the user their policy file has the problem in the error. Only they can fix it. Meanwhile, use the build tool and the sign_url.",
  policy_refused:
    "Tell the user what the policy refused and why. Only the user can change the policy, by editing the file; don't look for a way around it. The build tool's sign_url still lets them sign it themselves.",
  signer_stopped: "The user switched the local signer off (the STOP file). Don't retry. Use the build tools and sign links, or ask them to remove the file.",
  simulation_failed: "Nothing was signed. Check the wallet's balances with get_wallet_positions, quote again, and only retry with the user's approval.",
  send_failed: "Nothing confirmed. Check the signature on an explorer before retrying, so the same action doesn't run twice.",
  too_many_tokens:
    "Pass mints with the higher.fun coins to check (search_coins finds them by name or ticker); that reads only those coins.",
  launch_for_unavailable:
    "higher.fun hasn't switched on launching for an X or GitHub account yet, so nothing was uploaded or spent. Tell the user, and launch without launch_for if they want (the creator fees then go to the signer's wallet).",
  live_unavailable: "The live feed needs Node 22 or later. Tell the user, and use get_trade_tape for the latest events meanwhile.",
  orders_invalid: "Tell the user their orders file has the problem in the error; only they can fix or remove it. Nothing was changed.",
  order_closed: "That order isn't open any more. list_orders shows what happened to it.",
  already_running: "Another `highwire orders run` is already filling orders; only one may run.",
  history_unavailable:
    "Tell the user the RPC timed out searching this wallet's history. Setting SOLANA_RPC_URL to an RPC provider's URL (one that keeps full transaction history) fixes it; get_wallet_positions still shows what the wallet holds now.",
  too_large: "The transaction doesn't fit in Solana's size limit. For a launch, try a shorter metadata_uri or drop the first buy.",
  line_not_registered: "Register first with line_register, from the wallet that launched the coin (the user's policy must allow \"register\" and be live).",
  line_unauthorized: "The token for The Line was replaced or expired. Register again with line_register.",
  line_late: "That round is already revealed: your fallback played it. Call line_state and move in the current round.",
  line_conflict: "You already moved this round; a move is final. Call line_state and wait for the reveal.",
  line_paused: "The Line's referee isn't answering. Clocks are stopped meanwhile, so nobody loses on time; try again in a minute.",
  line_rate_limited: "Too many arena calls this minute. Wait, then use line_state (which waits for the next reveal) instead of polling.",
  line_refused: "Tell the user why The Line refused; don't try to work around it.",
  line_expired: "The registration code expired. Run line_register again.",
  line_pending: "An earlier line_register for this wallet and coin is still waiting. Its code expires within 10 minutes of that attempt; call line_register again after that.",
  line_not_found: "Check the match id, or call line_join to start a match.",
  line_bad_request: "Fix the parameters as the error says, and try again.",
  line_unavailable: "The Line's referee answered with an error. Try again shortly, and tell the user if it persists.",
  line_daemon_off:
    "Tell the user the reveal daemon must be running for this wallet: `highwire-wager run`, with the same HIGHWIRE_CLUSTER, keypair and policy as this server. Nothing was staked or committed.",
  wagers_off:
    "Tell the user staked series need the highwire-wager server: they change this server's command to `npx -y highwire-wager` (highwire.fun/line.md). Nothing was staked, committed or retired. Free matches work as they are.",
  wager_late: "Too late for that: call line_state with the series and act on what it says (a missed commit plays your fallback).",
  wager_conflict: "You already committed this round; it's final. Call line_state with the series and wait for the reveal.",
  wager_not_found: "Check the series id with line_wagers. A series that has ended is settled and closed; line_state with its id says how it ended.",
  wager_mismatch: "Do as the error says: nothing was staked.",
};

export function friendlyError(err: unknown): FriendlyError {
  const f = classify(err);
  return { ...f, error: publicMessage(f.error) };
}

function classify(err: unknown): FriendlyError {
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
  // web3.js retries a 429 itself, then throws a plain Error carrying the RPC's body.
  if (err instanceof Error && /^429\b|Too Many Requests/i.test(err.message)) {
    return {
      error: "The Solana RPC is limiting requests (429).",
      code: "rate_limited",
      next_step:
        "Wait a few seconds, then retry once. If it keeps happening, tell the user: Solana's public RPC rate-limits hard, " +
        "and setting SOLANA_RPC_URL to an RPC provider's URL avoids it.",
    };
  }
  return {
    error: err instanceof Error ? err.message : String(err),
    code: "internal_error",
    next_step: "Something failed reading higher.fun or Solana. Retry once; if it fails again, tell the user rather than guessing.",
  };
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
