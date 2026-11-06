import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimitError } from "highwire-core";
import { friendlyError } from "../src/result.ts";

test("an RPC's 429, as web3.js throws it after its own retries, is rate_limited, not an internal error", () => {
  const raw = new Error('429 Too Many Requests: {"jsonrpc":"2.0","error":{"code": 429, "message":"Too many requests for a specific RPC call"}, "id": "649917ea" }');
  const f = friendlyError(raw);
  assert.equal(f.code, "rate_limited");
  assert.equal(f.error, "The Solana RPC is limiting requests (429).");
  assert.match(f.next_step ?? "", /SOLANA_RPC_URL/);
  // higher.fun's own 429 keeps its shorter advice
  assert.equal(friendlyError(new RateLimitError("slow down")).code, "rate_limited");
  // anything else is still an internal error
  assert.equal(friendlyError(new Error("boom")).code, "internal_error");
});
