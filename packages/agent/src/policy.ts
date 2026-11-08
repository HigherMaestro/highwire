import { readFileSync } from "node:fs";
import { z } from "zod";
import { CLUSTERS, HigherError, MAX_SLIPPAGE_BPS, solToLamports, type Cluster } from "highwire-core";

// The user's policy: the only thing that lets the local signer sign. It's a file
// on their machine that no tool can write, so an agent (or text an agent read)
// can't widen it. Read fresh on every execute, so an edit applies at once.

export const ACTIONS = ["trade", "launch", "claim", "transfer", "register"] as const;
export type Action = (typeof ACTIONS)[number];

/** "launches", "trades": for refusals. */
export const plural = (action: Action) => (action === "launch" ? "launches" : action === "register" ? "registrations" : `${action}s`);

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a base58 Solana address");

export const PolicySchema = z
  .object({
    version: z.literal(1),
    /** Where it may sign. Required, so mainnet is always a deliberate choice. */
    cluster: z.enum(CLUSTERS),
    /** Send for real. Default false: every execute is a dry run that signs nothing. */
    live: z.boolean().default(false),
    /** What it may do. */
    actions: z.array(z.enum(ACTIONS)).min(1),
    /** The most SOL one execute may spend: trade input, launch fee plus first buy, or SOL sent. */
    max_sol_per_tx: z.number().positive().max(1_000),
    /** The most SOL it may spend in any 24 hours, counted from the audit log. */
    max_sol_per_day: z.number().positive().max(10_000),
    max_slippage_bps: z.number().int().min(0).max(MAX_SLIPPAGE_BPS),
    /** Coins it may trade or send: only these (allow), or anything but these (deny). */
    coins: z.object({ allow: z.array(address).optional(), deny: z.array(address).optional() }).strict().optional(),
    /** Only coins launched by these creators. */
    creators: z.object({ allow: z.array(address) }).strict().optional(),
    /** The only wallets transfers may go to. */
    transfer_allowlist: z.array(address).default([]),
    /**
     * Standing orders: which kinds an agent may place, and how many may be open. Without it, none. Each fill is a
     * trade, so it needs "trade" in actions and passes every rule above when it runs.
     */
    orders: z
      .object({
        kinds: z.array(z.enum(["stop_loss", "take_profit", "limit_buy", "recurring_buy", "fee_claim"])).min(1),
        max_open: z.number().int().min(1).max(50).default(10),
      })
      .strict()
      .optional(),
    /**
     * Posting on higher.fun as this wallet: comments on coins (only the wallet's own launches, by default, or any coin),
     * site chat if `chat` is true, at most `max_per_day` posts in any 24 hours. Without it, none. Mainnet only.
     */
    posts: z
      .object({
        comments: z.enum(["none", "own", "any"]).default("own"),
        chat: z.boolean().default(false),
        max_per_day: z.number().int().min(1).max(100).default(10),
      })
      .strict()
      .optional(),
    /**
     * How sends go out (docs/protected-sends.md). "rpc", the default, is SOLANA_RPC_URL. "jito" sends each transaction
     * through Jito's block engine as a one-transaction bundle with a tip of at most `max_tip_sol` (mainnet only): it
     * can't be sandwiched, and one that would fail costs nothing. With "fallback": "rpc", a refused Jito send goes the
     * ordinary way instead; the default, "none", sends nothing.
     */
    send: z
      .object({
        route: z.enum(["rpc", "jito"]).default("rpc"),
        max_tip_sol: z.number().min(0.000001).max(0.01).default(0.0005),
        fallback: z.enum(["none", "rpc"]).default("none"),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((p) => !(p.send?.route === "jito" && p.cluster !== "mainnet"), { message: 'send.route "jito" is mainnet only: Jito has no devnet block engine', path: ["send", "route"] });

export type Policy = z.infer<typeof PolicySchema>;

/** A starting policy: devnet, dry run, small limits, no transfers. */
export const POLICY_TEMPLATE = {
  version: 1,
  cluster: "devnet",
  live: false,
  actions: ["trade", "claim"],
  max_sol_per_tx: 0.1,
  max_sol_per_day: 0.5,
  max_slippage_bps: 300,
  transfer_allowlist: [],
} satisfies z.input<typeof PolicySchema>;

/**
 * A starting policy for an agent that launches coins on its own: mainnet, launches and claims only, room for the
 * launch fee and a small first buy, and fee-claim orders so `highwire orders claim` can collect creator fees on a
 * schedule. Buying back with them needs "trade" added. Still a dry run until the user sets "live": true (or asks for it
 * when writing it).
 */
export const LAUNCH_POLICY_TEMPLATE = {
  version: 1,
  cluster: "mainnet",
  live: false,
  actions: ["launch", "claim"],
  max_sol_per_tx: 0.25,
  max_sol_per_day: 0.5,
  max_slippage_bps: 500,
  transfer_allowlist: [],
  orders: { kinds: ["fee_claim"], max_open: 3 },
} satisfies z.input<typeof PolicySchema>;

/**
 * What a policy leaves open that the user may not mean to. A live policy with no coin or creator allow-list lets an
 * agent buy any higher.fun coin within the limits, including one whose description talks it into buying.
 */
export function policyWarnings(p: Policy): string[] {
  const out: string[] = [];
  if (p.live && p.actions.includes("trade") && !p.coins?.allow && !p.creators?.allow) {
    out.push("Live, with no coins.allow or creators.allow: an agent may buy any higher.fun coin within your limits. List the coins (or creators) you mean it to trade.");
  }
  return out;
}

/** The policy, or why there isn't a usable one. */
export function loadPolicy(path: string): Policy {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new HigherError(`No policy at ${path}, so nothing executes.`, { code: "no_policy" });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HigherError(`The policy at ${path} isn't valid JSON.`, { code: "policy_invalid" });
  }
  const parsed = PolicySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "policy"}: ${i.message}`).join("; ");
    throw new HigherError(`The policy at ${path} isn't usable: ${issues}`, { code: "policy_invalid" });
  }
  return parsed.data;
}

/** What an execute is about to do, as the policy sees it. */
export interface Intent {
  action: Action;
  cluster: Cluster;
  /** SOL leaving the wallet for the trade, launch or transfer itself, in lamports (network fees and rent aside). */
  solOut: bigint;
  slippageBps?: number;
  /** The coin traded or sent. */
  mint?: string;
  /** The coin's creator, when the policy has a creator rule. null when it couldn't be found. */
  creator?: string | null;
  /** A transfer's recipient. */
  recipient?: string;
  /** Other actions it needs too: a claim and buyback is a claim and a trade. */
  also?: Action[];
}

export interface Refusal {
  rule: string;
  reason: string;
}

/** The first rule the intent breaks, or null when the policy allows it. `spentToday` is the last 24 hours, in lamports. */
export function checkPolicy(policy: Policy, intent: Intent, spentToday: bigint): Refusal | null {
  const no = (rule: string, reason: string): Refusal => ({ rule, reason });
  if (intent.cluster !== policy.cluster) return no("cluster", `the policy is for ${policy.cluster}, and this server builds on ${intent.cluster}`);
  if (!policy.actions.includes(intent.action)) return no("actions", `the policy doesn't allow ${plural(intent.action)}`);
  for (const a of intent.also ?? []) if (!policy.actions.includes(a)) return no("actions", `the policy doesn't allow ${plural(a)}`);
  if (intent.slippageBps !== undefined && intent.slippageBps > policy.max_slippage_bps) {
    return no("max_slippage_bps", `${intent.slippageBps} bps of slippage is over the policy's ${policy.max_slippage_bps}`);
  }
  const perTx = solToLamports(policy.max_sol_per_tx);
  if (intent.solOut > perTx) return no("max_sol_per_tx", `it spends more than the policy's ${policy.max_sol_per_tx} SOL per transaction`);
  const perDay = solToLamports(policy.max_sol_per_day);
  if (spentToday + intent.solOut > perDay) return no("max_sol_per_day", `it would take the last 24 hours past the policy's ${policy.max_sol_per_day} SOL`);
  if (intent.mint && (intent.action === "trade" || intent.action === "transfer")) {
    if (policy.coins?.deny?.includes(intent.mint)) return no("coins.deny", `the policy denies coin ${intent.mint}`);
    if (policy.coins?.allow && !policy.coins.allow.includes(intent.mint)) return no("coins.allow", `coin ${intent.mint} isn't on the policy's allow list`);
  }
  if (intent.action === "trade" && policy.creators) {
    if (!intent.creator) return no("creators.allow", "the coin's creator couldn't be found, and the policy only allows some creators");
    if (!policy.creators.allow.includes(intent.creator)) return no("creators.allow", `the coin's creator ${intent.creator} isn't on the policy's allow list`);
  }
  if (intent.action === "transfer" && (!intent.recipient || !policy.transfer_allowlist.includes(intent.recipient))) {
    return no("transfer_allowlist", `${intent.recipient ?? "the recipient"} isn't on the policy's transfer allowlist`);
  }
  return null;
}
