import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PublicKey } from "@solana/web3.js";
import { AuditLog, type ExecuteResult } from "highwire-agent";
import { HigherError, lamportsNumber, solToLamports, ValidationError } from "highwire-core";
import { EXECUTE, READ_ONLY, run, type Deps, type ExecutionSigner, type RelayCall } from "highwire-mcp";
import { linkBattleAddress, type LinkBattleAccount, type LinkTicket, type LinkWagerConfig } from "./link-codec.ts";
import { actOnLinkBattle, nextLinkStakeAction, signedResultOf, usableResults, walletLinkBattles, type LinkStakeAction } from "./link-run.ts";
import { buildLinkAccept, buildLinkOpen, readLinkBattle, readLinkConfig, type LinkStakes, type SignedLinkResult } from "./link-tx.ts";
import { LINK_KIND } from "./signing.ts";

// Practice stakes on link battles (docs/link-wager.md 3, 4): devnet SOL, which is worth nothing, staked from the local
// signer's wallet on a battle against another agent. `link_stake` pairs and stakes (an execute: the policy's wagers
// section, the simulation and the audit log apply). The battle itself is an ordinary link battle, played with
// link_state and link_move. `link_settle` sends the referee's signed result, which pays the winner or refunds both;
// `link_wagers` lists where everything stands.
//
// The referee is not trusted here. What it sends is checked for shape before it's used, never put into a tool's answer
// as text (only a battle id and a match id, each checked to be one), and never taken on its word where the chain can
// say: that both have staked is read from the battle's account, and a result is one only if the program's own key
// signed it. No tool returns a ticket, the desk's or the referee's signature, or a key.

const FALLBACKS = ["first", "strongest", "random"] as const;
const BATTLE_ID = /^[0-9a-f]{64}$/;
const MATCH_ID = /^[a-z2-9]{10}$/;

const ticketOf = (t: Record<string, unknown>): LinkTicket => ({
  battleId: String(t.battleId),
  playerA: String(t.playerA),
  playerB: String(t.playerB),
  stake: /^\d{1,20}$/.test(String(t.stake)) ? BigInt(String(t.stake)) : -1n,
  acceptDeadline: Number(t.acceptDeadline),
  expiry: Number(t.expiry),
  keyId: Number(t.keyId),
});

/** What the signer did, honestly: landed, a dry run, or not known to have landed and why. */
function outcome(r: ExecuteResult): { landed: boolean; dryRun: boolean; report: Record<string, unknown> } {
  const t = r.transactions[0];
  const landed = r.status === "sent" && Boolean(t?.confirmed);
  return { landed, dryRun: r.status === "dry_run", report: { status: r.status, ...(t ? { transaction: t.signature, confirmed: t.confirmed, ...(t.error ? { error: t.error } : {}) } : {}) } };
}

const PRACTICE = "Practice: devnet SOL is worth nothing, and a staked battle never moves the free ladder.";
const when = (seconds: number) => new Date(seconds * 1000).toISOString();

/** Registers `link_stake`, `link_wagers` and `link_settle` for the program handed in (in code: the codec's, or a test's). */
export function registerLinkStakeTools(server: McpServer, deps: Deps, signer: ExecutionSigner, relay: RelayCall, program: PublicKey) {
  const stakes: LinkStakes = { chain: deps.chain, program };
  const { chain } = deps;
  const wallet = new PublicKey(signer.wallet);
  const quiet = <T>(f: () => Promise<T>) => f().catch(() => null);
  const audit = () => new AuditLog(signer.paths.audit);
  const execute = (tool: string, kind: string, solOut: bigint, envelope: Parameters<ExecutionSigner["execute"]>[1]["envelope"]) =>
    signer.execute(chain.connection, { tool, intent: { action: "wager", cluster: chain.cluster, solOut, wager: { kind: `${LINK_KIND}${kind}` } }, envelope });
  /** Whether this wallet's stake into this battle confirmed before: a ticket is used once. */
  const stakedBefore = (battleId: string) => {
    const addr = linkBattleAddress(program, battleId).toBase58();
    return audit()
      .entries()
      .some((e) => e.action === "wager" && e.series === addr && (e.wager === `${LINK_KIND}open` || e.wager === `${LINK_KIND}accept`) && e.outcome === "confirmed");
  };
  /**
   * The referee's results for these battles that the program would take: each for its own battle and wallets, under
   * the key id and the key the config holds. A "result" that fails any of that is dropped, so it can't hold up a refund.
   */
  const results = async (battles: LinkBattleAccount[], config: Pick<LinkWagerConfig, "resultKey" | "resultKeyId">): Promise<Map<string, SignedLinkResult>> => {
    const served = new Map<string, SignedLinkResult>();
    const body = await relay("GET", "/api/link/stake/results");
    for (const x of Array.isArray(body?.results) ? body.results : []) {
      const r = signedResultOf(x);
      if (r) served.set(r.result.battleId, r);
    }
    return usableResults(stakes, config, battles, served);
  };
  const sideOf = (b: LinkBattleAccount) => (b.playerA === signer.wallet ? "A" : "B");

  server.registerTool(
    "link_stake",
    {
      title: "Link battles: stake on a practice battle (local signer, devnet)",
      description:
        "Stake devnet SOL (worth nothing: this is practice) on one link battle against another agent; the winner takes both " +
        "stakes, a draw or a void refunds both. Pairs you at a stake tier, then stakes from this wallet through the local " +
        "signer, inside the user's policy (\"wager\" in its actions, and a wagers section allowing the tier). Call it again " +
        "as its next_step says: while waiting to be paired (within a minute), as B to accept once A has opened, and once " +
        "both have staked to get the match. Then play with link_state and link_move, and settle with link_settle. A stake " +
        "nobody accepts comes back once its ticket has run out (a few minutes). " +
        'Declare a fallback for decisions you miss: "first", "strongest" or "random".',
      inputSchema: {
        stake: z.number().positive().max(10).describe("Devnet SOL a side: one of the tiers (link_wagers lists them)."),
        fallback: z.enum(FALLBACKS).describe("What plays when you miss a decision, as in link_join."),
        confirm: z.literal(true).describe("Stake the SOL."),
      },
      annotations: { title: "Link battles: stake on a practice battle (local signer, devnet)", ...EXECUTE },
    },
    (args) =>
      run(async () => {
        signer.precheck("wager", chain.cluster, "link_stake");
        const lamports = solToLamports(args.stake);
        const out = await relay("POST", "/api/link/stake/join", { stake: String(lamports), fallback: args.fallback });
        if (out.waiting) {
          return {
            waiting: true,
            waiting_at_this_tier: Number(out.waitingAtTier) || 0,
            owners_needed: Number(out.needed) || 0,
            waited_seconds: Number(out.waitedSeconds) || 0,
            next_step: "No opponent yet. Call link_stake again within a minute to keep your place. Nothing is staked until you're paired.",
          };
        }
        const v = (out.stake ?? {}) as Record<string, unknown>;
        const ticket = ticketOf((v.ticket ?? {}) as Record<string, unknown>);
        const role: "A" | "B" = v.role === "A" ? "A" : "B";
        const mismatch = (what: string) => new HigherError(`${what}; nothing was staked. Tell the user.`, { code: "wager_mismatch" });
        if (v.cluster !== chain.cluster) throw mismatch(`The referee's practice stakes aren't on ${chain.cluster}, where this server builds`);
        if (v.programId !== program.toBase58()) throw mismatch("The referee stakes through another program than this server builds for");
        if (typeof v.battle !== "string" || !BATTLE_ID.test(v.battle) || ticket.battleId !== v.battle || (role === "A" ? ticket.playerA : ticket.playerB) !== signer.wallet) {
          throw mismatch("The referee's ticket isn't for this wallet in that role");
        }
        const battle = v.battle;
        const base = { paired: true, battle, you: role, stake_sol: lamportsNumber(ticket.stake), practice: PRACTICE };
        // Where the battle stands is the chain's to say, whatever the referee's answer claims.
        const onchain = await readLinkBattle(stakes, battle);
        if (onchain && (onchain.playerA !== ticket.playerA || onchain.playerB !== ticket.playerB || onchain.stake !== ticket.stake)) throw mismatch("The battle on-chain isn't the ticket's (other wallets, or another stake)");
        if (onchain?.status === "live") {
          const match = v.status === "playing" && typeof v.match === "string" && MATCH_ID.test(v.match) ? v.match : null;
          return match
            ? { ...base, both_staked: true, match, next_step: "Both stakes are in and the battle is on: play it with link_state and link_move. When it ends, link_settle pays it out." }
            : { ...base, both_staked: true, next_step: "Both stakes are in; the referee is starting the battle. Call link_stake again in a few seconds for the match." };
        }
        // The stake is the ticket's: the agent asked for this one, so it must be this one.
        if (ticket.stake !== lamports) {
          throw new HigherError(
            `You're already paired at ${lamportsNumber(ticket.stake)} SOL a side (battle ${battle.slice(0, 8)}). Stake that (link_stake with stake ${lamportsNumber(ticket.stake)}), or let the pairing run out in a few minutes. Nothing was staked.`,
            { code: "wager_mismatch" },
          );
        }
        const by = Number.isFinite(ticket.acceptDeadline) ? when(ticket.acceptDeadline) : null;
        if (onchain) {
          if (role === "A") return { ...base, staked: true, waiting_for_opponent: true, accept_by: by, next_step: "You've staked and opened. Your opponent accepts next: call link_stake again in a few seconds. If nobody accepts, link_settle takes your stake back once the ticket has run out." };
        } else {
          if (role === "B") return { ...base, waiting_for_opener: true, accept_by: by, next_step: "Your opponent opens first. Call link_stake again in a few seconds to accept." };
          if (stakedBefore(battle)) throw new HigherError("This wallet already staked on that battle, which has since closed: a ticket is used once. Call link_stake again in a minute or two for a new pairing.", { code: "wager_mismatch" });
        }
        const signed = { wallet, ticket, signature: String(v.signature) };
        const built = role === "A" ? await buildLinkOpen(stakes, signed) : await buildLinkAccept(stakes, signed);
        const o = outcome(await execute("link_stake", role === "A" ? "open" : "accept", built.stake, built.envelope));
        return {
          ...base,
          staked: o.report,
          next_step: o.dryRun
            ? "The policy is a dry run, so nothing was staked. The user sets it live to stake."
            : !o.landed
              ? "The stake isn't known to have landed (see staked). Call link_wagers to see whether it's on-chain; if it isn't, call link_stake again while the ticket lasts."
              : role === "A"
                ? "Staked and opened. Your opponent accepts next: call link_stake again in a few seconds."
                : "Staked and accepted: both stakes are in. Call link_stake again in a few seconds for the match, then play with link_state and link_move.",
        };
      }),
  );

  server.registerTool(
    "link_settle",
    {
      title: "Link battles: settle your staked battles (local signer, devnet)",
      description:
        "Brings this wallet's practice stakes home: sends the referee's signed result for each battle that has ended (the " +
        "winner is paid both stakes, a draw or a void refunds both; either side may send it), takes back a stake nobody " +
        "accepted, and refunds a battle that never got a result once its time has come. Nothing closes before a battle's " +
        "ticket has run out (a few minutes after pairing). Stakes nothing. The daemon (`highwire-wager run`) does the same " +
        "for an agent that has stopped.",
      inputSchema: { confirm: z.literal(true).describe("Send what's due.") },
      annotations: { title: "Link battles: settle your staked battles (local signer, devnet)", ...EXECUTE },
    },
    () =>
      run(async () => {
        signer.precheck("wager", chain.cluster, "link_settle");
        const battles = await walletLinkBattles(stakes, audit(), signer.wallet, chain.cluster);
        if (battles.length === 0) return { settled: [], next_step: "Nothing of this wallet's is staked on-chain: every battle it staked on has been paid or refunded." };
        const config = await readLinkConfig(stakes);
        const signed = battles.some((b) => b.status === "live") ? await quiet(() => results(battles, config)) : new Map<string, SignedLinkResult>();
        const now = Math.floor(Date.now() / 1000);
        const done = [];
        for (const b of battles) {
          const action: LinkStakeAction | null = nextLinkStakeAction(b, signer.wallet, now, { result: signed?.get(b.battleId) });
          const row = { battle: b.battleId, you: sideOf(b), stake_sol: lamportsNumber(b.stake) };
          if (!action) {
            done.push({
              ...row,
              did: "nothing yet",
              why:
                now <= b.ticketExpiry + 10
                  ? `Nothing closes a battle before its ticket has run out, at ${when(b.ticketExpiry)}${b.status === "open" ? ": an unaccepted stake can be taken back then" : ""}. Call link_settle again after that.`
                  : signed === null
                    ? `The referee didn't answer, so its result isn't known yet. Try again in a moment; with no result at all, both stakes are refunded from ${when(b.refundAt)}.`
                    : `Both stakes are in and the battle has no result yet: play it (link_state, link_move). If it never gets one, both stakes are refunded from ${when(b.refundAt)}.`,
            });
            continue;
          }
          const result = action.kind === "settle" ? action.signed.result.outcome : null;
          const said = result === null ? {} : { referee_result: result === "draw" || result === "void" ? `${result}: both stakes refunded` : (result === "a") === (sideOf(b) === "A") ? "you won: both stakes to this wallet" : "you lost: both stakes to your opponent" };
          // One battle's failure never hides what was done for another: each row says what happened to its own.
          try {
            const o = outcome(await actOnLinkBattle(stakes, signer, "link_settle", b.battleId, action));
            done.push({
              ...row,
              did: o.landed ? action.kind : o.dryRun ? `nothing: a dry run of a ${action.kind}` : `tried to ${action.kind}`,
              ...said,
              sent: o.report,
              ...(o.dryRun ? { note: "The policy is a dry run: nothing was sent." } : !o.landed ? { note: "It isn't known to have landed (the other side's may have landed first). Call link_wagers to see." } : {}),
            });
          } catch (err) {
            done.push({ ...row, did: `nothing: the ${action.kind} wasn't sent`, ...said, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return { settled: done, next_step: "link_wagers shows what's still staked. link_stake stakes on another battle." };
      }),
  );

  server.registerTool(
    "link_wagers",
    {
      title: "Link battles: your practice stakes",
      description:
        "Where this wallet's practice stakes stand: the stake you're paired for and its battle (from the referee), the battles with a stake on-chain and what each is waiting for, today's stakes (from the audit log), your practice rating and record, and the tiers.",
      inputSchema: {},
      annotations: { title: "Link battles: your practice stakes", ...READ_ONLY },
    },
    () =>
      run(async () => {
        const [battles, info, mine, config] = await Promise.all([
          walletLinkBattles(stakes, audit(), signer.wallet, chain.cluster),
          quiet(() => relay("GET", "/api/link/stake")),
          quiet(() => relay("GET", "/api/link/stake/state")),
          quiet(() => readLinkConfig(stakes)),
        ]);
        const signed = config && battles.some((b) => b.status === "live") ? await quiet(() => results(battles, config)) : null;
        const now = Math.floor(Date.now() / 1000);
        const since = Date.now() - 86_400_000;
        const entries = audit().entries();
        const unlanded = new Set(entries.filter((e) => e.outcome === "not_landed" && e.signature).map((e) => e.signature));
        const today = entries
          .filter((e) => e.action === "wager" && e.outcome === "sent" && e.wallet === signer.wallet && (e.wager === `${LINK_KIND}open` || e.wager === `${LINK_KIND}accept`) && e.cluster === chain.cluster && Date.parse(e.time) >= since && !(e.signature && unlanded.has(e.signature)))
          .reduce((n, e) => n + BigInt(e.lamports), 0n);
        const tiers = (list: unknown) => (Array.isArray(list) ? list.filter((t) => /^\d{1,20}$/.test(String(t))).map((t) => lamportsNumber(BigInt(String(t)))) : null);
        const pairedFor = mine && typeof mine.battle === "string" && BATTLE_ID.test(mine.battle) && (mine.status === "ticketed" || mine.status === "playing") ? mine : null;
        return {
          practice: PRACTICE,
          paired: pairedFor
            ? {
                battle: pairedFor.battle as string,
                you: pairedFor.role === "A" ? "A" : "B",
                status: pairedFor.status === "playing" ? "playing" : "ticketed",
                ...(typeof pairedFor.match === "string" && MATCH_ID.test(pairedFor.match) ? { match: pairedFor.match } : {}),
                next_step: pairedFor.status === "playing" ? "Play it with link_state and link_move." : "Call link_stake (same stake and fallback) to stake or to accept.",
              }
            : null,
          on_chain: battles.map((b) => {
            const action = nextLinkStakeAction(b, signer.wallet, now, { result: signed?.get(b.battleId) });
            return {
              battle: b.battleId,
              you: sideOf(b),
              stake_sol: lamportsNumber(b.stake),
              status: b.status === "open" ? "only the opener has staked" : "both staked",
              due: action
                ? `${action.kind}: call link_settle`
                : now <= b.ticketExpiry + 10
                  ? `nothing until its ticket runs out, at ${when(b.ticketExpiry)}`
                  : `the battle has no result yet; refunded from ${when(b.refundAt)} if it never gets one`,
            };
          }),
          today: { staked_sol: lamportsNumber(today), note: "Every link stake sent in the last 24 hours, rent included, as the policy's daily limit counts it." },
          you: mine?.you ? { rating: Number(mine.you.rating) || null, record: { win: Number(mine.you.record?.win) || 0, draw: Number(mine.you.record?.draw) || 0, loss: Number(mine.you.record?.loss) || 0 }, note: "A practice rating of its own, apart from the free ladder." } : null,
          tiers_sol: tiers(info?.tiers) ?? (config ? config.tiers.map((t) => lamportsNumber(t)) : null),
          ...(info ? {} : { referee: "not answering: what's on-chain is shown, and nothing can be paired or settled by result until it does" }),
          program: program.toBase58(),
          cluster: chain.cluster,
        };
      }),
  );
}
