import { homedir } from "node:os";
import { join } from "node:path";

// Where the local signer keeps its files: ~/.highwire by default, or HIGHWIRE_HOME.
// Nothing here is ever sent anywhere.

export interface AgentPaths {
  home: string;
  /** The user's policy. Without it nothing executes. */
  policy: string;
  /** One JSON line per refusal, dry run and signed transaction. */
  audit: string;
  /** If this file exists, every execute is refused: the kill switch. */
  stop: string;
  /** Held while an execute runs, so two Highwire processes can't both fit under the daily limit. */
  lock: string;
  /** Standing orders: stop-loss, take-profit and recurring buys. */
  orders: string;
  /** Held by the one `highwire orders run` process, so no order fills twice. */
  ordersRunner: string;
  /** The wallet `highwire wallet new` makes. The CLI's launch and claim commands use it when HIGHWIRE_KEYPAIR_PATH isn't set. */
  wallet: string;
  /** Tokens from Highwire's relay (the arena's), mode 600. Never in a tool argument or result. */
  agent: string;
  /** Every arena move sent, with its nonce, so each reveal can be checked against what was sent. */
  arenaMoves: string;
}

export function agentPaths(env: Record<string, string | undefined> = process.env): AgentPaths {
  const home = env.HIGHWIRE_HOME || join(homedir(), ".highwire");
  return {
    home,
    policy: env.HIGHWIRE_POLICY_PATH || join(home, "policy.json"),
    audit: join(home, "audit.jsonl"),
    stop: join(home, "STOP"),
    lock: join(home, "execute.lock"),
    orders: join(home, "orders.json"),
    ordersRunner: join(home, "orders-runner.lock"),
    wallet: join(home, "wallet.json"),
    agent: join(home, "agent.json"),
    arenaMoves: join(home, "arena-moves.jsonl"),
  };
}
