import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PublicKey } from "@solana/web3.js";
import { AuditLog, lockHolder, WagerSecrets, type ExecuteResult, type WagerFallback } from "highwire-agent";
import {
  arena,
  buildWagerAccept,
  buildWagerMove,
  buildWagerOpen,
  commitDeadline,
  HigherError,
  lamportsNumber,
  listWalletSeries,
  readSeries,
  revealDeadline,
  sideIndexOf,
  solToLamports,
  ValidationError,
  wagerProgram,
  type SeriesAccountData,
  type WagerTicket,
} from "highwire-core";
import { run } from "../result.ts";
import { EXECUTE, READ_ONLY, type Deps, type ExecutionSigner } from "./shared.ts";

// Wagers on The Line (docs/wager-mode.md 7.3, 7.6): practice series on devnet, staked from the local signer's wallet.
// line_stake stakes (an execute: the policy's wagers section, the simulation and the audit log apply); line_state,
// line_move and line_retire take a `series` for a staked series; line_wagers lists them. A wager move is a commit sent
// at once: the reveal daemon (`highwire line run`) reveals it, so staking refuses unless the daemon is running. Moves
// carry no table talk, and no tool ever returns a nonce or a salt.

export const SERIES_ID = z.string().regex(/^[0-9a-f]{64}$/).describe("The wager series' id (64 hex characters), from line_stake.");

type Relay = (method: "GET" | "POST", path: string, body?: unknown) => Promise<any>;

const ticketOf = (t: { seriesId: string; playerA: string; playerB: string; stake: string; acceptDeadline: number; expiry: number; keyId: number }): WagerTicket => ({ ...t, stake: BigInt(t.stake) });

function fallbackOf(text: string): WagerFallback {
  const f = arena.parseFallback(text);
  if (!f) throw new ValidationError('A fallback is "zero", "mirror" or "steady:<n>".');
  return f.kind === "steady" ? { kind: "steady", pull: f.pull } : { kind: f.kind, pull: 0 };
}

const daemonRunning = (signer: ExecutionSigner) => lockHolder(signer.paths.wagerRunner) !== null;

/** The series as this wallet's agent needs it: its own side, the node from its side, its clock; never a secret. */
export function wagerView(s: SeriesAccountData, wallet: string, now = Math.floor(Date.now() / 1000)) {
  const h = s.header;
  const me = h.playerA === wallet ? "A" : "B";
  const them = me === "A" ? "B" : "A";
  const base = { series: h.seriesId, you: me, stake_sol: lamportsNumber(h.stake), status: h.status };
  const x = s.series;
  if (!x) return { ...base, next_step: me === "A" ? "Waiting for B to accept." : "Accept with line_stake." };
  const mine = sideIndexOf(me, x.match);
  const theirs = mine === 0 ? 1 : 0;
  const toMe = (node: number) => (mine === 1 ? node : -node);
  const score = (p: "A" | "B") => x.results.filter((r) => r?.winner === p).length;
  const committed = x.round[mine].hash !== null || x.round[mine].owesFallback;
  const yourMove = !x.ending && x.phase === "commit" && !committed;
  return {
    ...base,
    score: { you: score(me), them: score(them) },
    match: x.match + 1,
    of: 5,
    side: mine === 0 ? "a" : "b",
    round: x.game.rounds + 1,
    phase: x.phase,
    node: toMe(x.game.node),
    node_note: "From your side: positive is toward your end; +3 wins the match, -3 loses it.",
    energy: { you: x.game.energy[mine], them: x.game.energy[theirs] },
    last_pulls: x.game.rounds > 0 ? { you: x.game.lastPull[mine], them: x.game.lastPull[theirs] } : null,
    bank_seconds: { you: x.bank[me], them: x.bank[them] },
    your_move: yourMove,
    ...(yourMove ? { seconds_to_commit: Math.max(0, commitDeadline(x, mine) - now) } : {}),
    ...(x.phase === "reveal" ? { reveal_window_ends_in: Math.max(0, revealDeadline(x) - now), you_revealed: x.round[mine].pull !== null } : {}),
    their_fallback: x.fallback[them],
    matches: x.results.flatMap((r, i) => (r ? [{ match: i + 1, result: r.winner === null ? "void or draw" : r.winner === me ? "you" : "them", reason: r.reason }] : [])),
    ending: x.ending ? { result: x.ending.winner === null ? "draw" : x.ending.winner === me ? "win" : "loss", reason: x.ending.reason } : null,
    next_step: x.ending
      ? "The series is over: the reveal daemon settles it and the payout goes to the wallet."
      : yourMove
        ? `Your move: line_move with this series and your pull (0 to ${x.game.energy[mine]}).`
        : x.phase === "reveal"
          ? "Both have committed: the reveal daemon reveals your move. Call line_state for the result."
          : "Waiting for the opponent's commit. Call line_state.",
  };
}

export function registerWagerTools(server: McpServer, deps: Deps, signer: ExecutionSigner, relay: Relay) {
  const { chain } = deps;
  const secrets = () => new WagerSecrets(signer.paths.wagerSecrets);
  const wallet = new PublicKey(signer.wallet);
  const onDevnet = () => {
    if (!wagerProgram(chain.cluster)) throw new ValidationError(`Wagering on The Line is devnet only for now (practice wagers); this server builds on ${chain.cluster}.`);
  };
  const execute = (tool: string, kind: string, solOut: bigint, envelope: Parameters<ExecutionSigner["execute"]>[1]["envelope"]): Promise<ExecuteResult> =>
    signer.execute(chain.connection, { tool, intent: { action: "wager", cluster: chain.cluster, solOut, wager: { kind } }, envelope });
  const sent = (r: ExecuteResult) => ({ status: r.status, ...(r.transactions[0] ? { signature: r.transactions[0].signature, confirmed: r.transactions[0].confirmed, ...(r.transactions[0].error ? { error: r.transactions[0].error } : {}) } : {}) });
  const mustRead = async (id: string) => {
    const s = await readSeries(chain, id);
    if (!s) throw new HigherError("That series isn't on-chain: it hasn't been opened, or it has closed.", { code: "line_not_found" });
    if (s.header.playerA !== signer.wallet && s.header.playerB !== signer.wallet) throw new ValidationError("That series is between other wallets.");
    return s;
  };

  server.registerTool(
    "line_stake",
    {
      title: "The Line: stake a wager series (local signer)",
      description:
        "Stake SOL on a best-of-5 series against another agent (devnet: practice wagers). Pairs you at a stake tier, then " +
        "stakes from this wallet through the local signer, inside the user's policy (\"wager\" in its actions, and a wagers " +
        "section allowing the tier). Needs the reveal daemon running (`highwire line run`): a move nobody reveals forfeits " +
        "its match. If it answers waiting, call it again within a minute. Call it again after pairing to accept, as B, " +
        "once A has opened. Declare a fallback for rounds you miss: zero, mirror, or steady:<n>.",
      inputSchema: {
        stake: z.number().positive().max(10).describe("SOL a side: one of the tiers (line_wagers lists them)."),
        fallback: z.string().regex(/^(zero|mirror|steady:\d{1,2})$/).describe('What plays when you miss a commit: "zero", "mirror" or "steady:<n>". Committed now, public once used.'),
        confirm: z.literal(true).describe("Stake the SOL."),
      },
      annotations: { title: "The Line: stake a wager series (local signer)", ...EXECUTE },
    },
    (args) =>
      run(async () => {
        onDevnet();
        signer.precheck("wager", chain.cluster, "line_stake");
        if (!daemonRunning(signer)) {
          throw new HigherError("The reveal daemon isn't running, so nothing could reveal your moves. Ask the user to start `highwire line run`, then stake.", { code: "line_daemon_off" });
        }
        const fallback = fallbackOf(args.fallback);
        const out = await relay("POST", "/api/arena/wager/join", { stake: String(solToLamports(args.stake)) });
        if (out.waiting) {
          return {
            waiting: true,
            waiting_at_this_tier: out.waitingAtTier,
            owners_needed: out.needed,
            waited_seconds: out.waitedSeconds,
            next_step: "No opponent yet. Call line_stake again within a minute to keep your place. Nothing is staked until you're paired.",
          };
        }
        const v = out.series;
        if (v.cluster !== chain.cluster) throw new ValidationError(`The referee's wagers are on ${v.cluster}, and this server builds on ${chain.cluster}.`);
        const onchain = await readSeries(chain, v.id);
        if (onchain?.header.status === "live" || (v.role === "A" && onchain)) return { paired: true, ...wagerView(onchain, signer.wallet) };
        if (v.role === "B" && !onchain) {
          return { paired: true, series: v.id, you: "B", waiting_for_opener: true, accept_by: new Date(v.ticket.acceptDeadline * 1000).toISOString(), next_step: "Your opponent opens first. Call line_stake again in a few seconds to accept." };
        }
        const ticket = ticketOf(v.ticket);
        const fb = secrets().newFallback(v.id, v.role, fallback);
        const built = v.role === "A"
          ? await buildWagerOpen(chain, { wallet, ticket, signature: v.signature, fallbackHash: fb.hash })
          : await buildWagerAccept(chain, { wallet, ticket, signature: v.signature, fallbackHash: fb.hash });
        const r = await execute("line_stake", v.role === "A" ? "open" : "accept", built.stake, built.envelope);
        return {
          paired: true,
          series: v.id,
          you: v.role,
          stake_sol: lamportsNumber(built.stake),
          staked: sent(r),
          next_step:
            r.status === "dry_run"
              ? "The policy is a dry run, so nothing was staked. The user sets it live to wager."
              : v.role === "A"
                ? "Staked and opened. Your opponent accepts next; then play with line_state and line_move, passing this series."
                : "Staked and accepted: match 1 has started. Play with line_state and line_move, passing this series.",
        };
      }),
  );

  server.registerTool(
    "line_wagers",
    {
      title: "The Line: your wagers",
      description: "This wallet's open and live wager series (from the chain), today's gross stakes (from the audit log), your wager rating and record, the tiers, and whether the reveal daemon is running.",
      inputSchema: {},
      annotations: { title: "The Line: your wagers", ...READ_ONLY },
    },
    () =>
      run(async () => {
        onDevnet();
        const [all, info, mine] = await Promise.all([listWalletSeries(chain, wallet), relay("GET", "/api/arena/wager"), relay("GET", "/api/arena/wager/state")]);
        const since = Date.now() - 86_400_000;
        const staked = new AuditLog(signer.paths.audit)
          .entries()
          .filter((e) => e.action === "wager" && e.outcome === "sent" && (e.wager === "open" || e.wager === "accept") && e.cluster === chain.cluster && Date.parse(e.time) >= since)
          .reduce((n, e) => n + BigInt(e.lamports), 0n);
        return {
          series: all.map((s) => wagerView(s, signer.wallet)),
          today: { staked_sol: lamportsNumber(staked), note: "Gross: what left the wallet to stake, rent included. Winnings never free up the day's limit." },
          you: mine.you,
          tiers_sol: (info.tiers as string[]).map((t) => lamportsNumber(BigInt(t))),
          reveal_daemon: daemonRunning(signer) ? "running" : "NOT running: start `highwire line run` before staking",
        };
      }),
  );

  return {
    /** line_state for a series: the chain's state, waiting up to 40 seconds for a change when asked. */
    async state(series: string, wait: boolean) {
      onDevnet();
      let s = await mustRead(series);
      const key = (x: SeriesAccountData) => `${x.series?.match}:${x.series?.game.rounds}:${x.series?.phase}:${Boolean(x.series?.ending)}`;
      const start = key(s);
      const until = Date.now() + 40_000;
      const yourMove = (x: SeriesAccountData) => {
        const v = wagerView(x, signer.wallet);
        return "your_move" in v && v.your_move;
      };
      while (wait && !s.series?.ending && !yourMove(s) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2_000));
        const next = await readSeries(chain, series);
        if (!next) break;
        s = next;
        if (key(s) !== start) break;
      }
      return { ...wagerView(s, signer.wallet), reveal_daemon: daemonRunning(signer) ? "running" : "NOT running: your commits won't be revealed" };
    },

    /** line_move for a series: commits the pull (the nonce saved first, never returned); the daemon reveals it. */
    async move(series: string, pull: number, round: number | undefined, line: string | undefined) {
      onDevnet();
      if (line) throw new ValidationError("Wager series carry no table talk: an opponent with money at stake has every reason to mislead.");
      if (!daemonRunning(signer)) throw new HigherError("The reveal daemon isn't running, so this commit would never be revealed and the match would be forfeited. Ask the user to start `highwire line run`.", { code: "line_daemon_off" });
      const s = await mustRead(series);
      const x = s.series;
      if (!x || x.ending) throw new ValidationError(x ? "The series is over." : "The series hasn't started: B hasn't accepted yet.");
      const me = s.header.playerA === signer.wallet ? "A" : "B";
      const mine = sideIndexOf(me, x.match);
      if (x.phase !== "commit") throw new HigherError("Both sides have committed this round; it's being revealed. Call line_state.", { code: "line_late" });
      if (x.round[mine].hash !== null || x.round[mine].owesFallback) throw new HigherError("You've already committed this round (or missed it, and your fallback plays).", { code: "line_conflict" });
      const r = x.game.rounds + 1;
      if (round !== undefined && round !== r) throw new HigherError(`This is round ${r} of match ${x.match + 1}.`, { code: "line_late" });
      if (pull > x.game.energy[mine]) throw new ValidationError(`You have ${x.game.energy[mine]} energy: pull 0 to ${x.game.energy[mine]}.`);
      const secret = secrets().newMove(series, x.match, r, mine === 0 ? "a" : "b", pull);
      const built = await buildWagerMove(chain, { wallet, seriesId: series, args: { kind: "commit", round: r, hash: secret.hash } });
      const out = await execute("line_move", "commit", 0n, built.envelope);
      return { committed: sent(out), match: x.match + 1, round: r, pull, next_step: "Committed. The reveal daemon reveals it once both sides have committed; call line_state for the result." };
    },

    /** line_retire for a series: concedes it, if the policy's wagers.allow_retire lets it. */
    async retire(series: string) {
      onDevnet();
      await mustRead(series);
      const built = await buildWagerMove(chain, { wallet, seriesId: series, args: { kind: "retire" } });
      return { retired: sent(await execute("line_retire", "retire", 0n, built.envelope)), next_step: "Conceded: the series goes to your opponent, and the daemon settles it." };
    },
  };
}
