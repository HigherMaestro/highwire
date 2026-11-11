import type { Connection } from "@solana/web3.js";
import type { Cluster, Envelope } from "highwire-core";
import type { AuditLog } from "./audit.ts";
import type { AgentPaths } from "./paths.ts";
import type { Action, Intent, Policy, Refusal } from "./policy.ts";
import type { ExecuteRequest } from "./signer.ts";

// Actions the signer can't check by itself (docs/boundaries.md 5.2). A wager is one: what it stakes, how many series
// the wallet has open and which of the policy's rules apply are known only to the package that builds wagers. That
// package passes the signer an ActionExtension in code; without one, an intent with that action is refused. Nothing
// here loads an extension by name, and an extension can't loosen what the signer enforces around it: the policy's
// cluster and actions, the per-transaction and daily limits, the simulation, the audit log and the kill switch.

/** Actions that need an extension. With none passed for it, the signer refuses the action. */
export const EXTENSION_ACTIONS: readonly Action[] = ["wager"];

/** What an envelope does, read from its bytes: the instruction's kind, and what it acts on (for the audit log). */
export interface ActionFacts {
  kind: string;
  subject: string;
}

export interface ActionExtension {
  action: Action;
  /** Reads the envelope's bytes. Throws when they aren't exactly one instruction of this action. */
  facts(env: Envelope, cluster: Cluster): ActionFacts;
  /**
   * Whether this kind puts money in. A kind that doesn't is a move: the signer lets it skip the queue and the daily
   * limit, holds it to spending nothing but a capped network fee, and refuses it if the extension's intent says more.
   */
  stakes(kind: string): boolean;
  /** The intent, from the bytes and the chain rather than the caller. Throws to refuse. */
  intent(ctx: { connection: Connection; req: ExecuteRequest; facts: ActionFacts; audit: AuditLog }): Promise<Intent>;
  /** The first of the policy's rules for this action that the intent breaks, or null. Called after the common rules. */
  check(policy: Policy, intent: Intent): Refusal | null;
  /** Why no new stake may be made now (a kill switch of its own), or null. Moves are never stopped by it. */
  stopped?(paths: AgentPaths): string | null;
}

/** A move: an extension's instruction that stakes nothing. The signer still caps what it may spend on fees. */
export const isMove = (intent: Intent, ext: ActionExtension | undefined): boolean =>
  !!ext && ext.action === intent.action && intent.solOut === 0n && !!intent.wager && !ext.stakes(intent.wager.kind);
