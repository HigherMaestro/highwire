import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PublicKey } from "@solana/web3.js";
import { AuditLog, type ExecuteResult } from "highwire-agent";
import { daemonStatus } from "./runner.ts";
import { WagerSecrets, type WagerFallback } from "./secrets.ts";
import { arena, HigherError, lamportsNumber, solToLamports, ValidationError } from "highwire-core";
import { commitDeadline, revealDeadline, seriesAddress, sideIndexOf, wagerProgram, type SeriesAccountData, type WagerTicket } from "./codec.ts";
import { buildWagerAccept, buildWagerMove, buildWagerOpen, listWalletSeries, readSeries, readSeriesMany, seriesOutcome } from "./tx.ts";
import { EXECUTE, READ_ONLY, run, type Deps, type ExecutionSigner, type RelayCall, type StakedSeries } from "highwire-mcp";

// Wagers on The Line (docs/wager-mode.md 7.3, 7.6): series staked from the local signer's wallet, on the cluster the
// referee's wager desk plays on (devnet now; mainnet after the switch, docs/wager-mainnet.md).
// line_stake stakes (an execute: the policy's wagers section, the simulation and the audit log apply); line_state,
// line_move and line_retire take a `series` for a staked series; line_wagers lists them. A wager move is a commit sent
// at once: the reveal daemon (`highwire-wager run`) reveals it, so staking and moving refuse unless the daemon is
// really working for this wallet. Moves carry no table talk, and no tool ever returns a nonce or a salt.



/** A commit must land strictly before its deadline: moves this close to it are refused, as they'd likely land late. */
const COMMIT_MARGIN_SECONDS = 5;
const MATCH_REASONS: Record<number, string> = { 1: "reached the end", 2: "rounds up", 3: "tie-break", 4: "draw", 5: "a missed reveal", 6: "void" };
const SERIES_REASONS: Record<number, string> = { 1: "decided", 2: "draw", 3: "retired" };

const ticketOf = (t: { seriesId?: unknown; playerA?: unknown; playerB?: unknown; stake?: unknown; acceptDeadline?: unknown; expiry?: unknown; keyId?: unknown }): WagerTicket => ({
  seriesId: String(t.seriesId),
  playerA: String(t.playerA),
  playerB: String(t.playerB),
  stake: /^\d{1,20}$/.test(String(t.stake)) ? BigInt(String(t.stake)) : -1n,
  acceptDeadline: Number(t.acceptDeadline),
  expiry: Number(t.expiry),
  keyId: Number(t.keyId),
});

function fallbackOf(text: string): WagerFallback {
  const f = arena.parseFallback(text);
  if (!f) throw new ValidationError('A fallback is "zero", "mirror" or "steady:<n>".');
  return f.kind === "steady" ? { kind: "steady", pull: f.pull } : { kind: f.kind, pull: 0 };
}

/** What the signer did, honestly: landed, a dry run, or not landed and why. */
function outcome(r: ExecuteResult): { landed: boolean; dryRun: boolean; report: Record<string, unknown> } {
  const t = r.transactions[0];
  const landed = r.status === "sent" && Boolean(t?.confirmed);
  return {
    landed,
    dryRun: r.status === "dry_run",
    report: { status: r.status, ...(t ? { signature: t.signature, confirmed: t.confirmed, ...(t.error ? { error: t.error } : {}) } : {}) },
  };
}

/** The series as this wallet's agent needs it: its own side, the node from its side, its clock; never a secret. */
export function wagerView(s: SeriesAccountData, wallet: string, now = Math.floor(Date.now() / 1000), ownPull?: (hash: string) => number | undefined) {
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
  const deadline = commitDeadline(x, mine);
  const open = !x.ending && x.phase === "commit" && !committed;
  const yourMove = open && now < deadline - COMMIT_MARGIN_SECONDS;
  const bankOut = x.bankOut[me];
  const hash = x.round[mine].hash;
  const yourCommit = hash && ownPull ? ownPull(hash) : undefined;
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
    bank_out: bankOut,
    your_move: yourMove,
    ...(yourMove ? { seconds_to_commit: deadline - now - COMMIT_MARGIN_SECONDS } : {}),
    ...(yourCommit !== undefined ? { your_committed_pull: yourCommit } : {}),
    ...(x.phase === "reveal" ? { reveal_window_ends_in: Math.max(0, revealDeadline(x) - now), you_revealed: x.round[mine].pull !== null } : {}),
    their_fallback: x.fallback[them],
    matches: x.results.flatMap((r, i) => (r ? [{ match: i + 1, winner: r.winner === null ? "nobody" : r.winner === me ? "you" : "them", how: MATCH_REASONS[r.reason] ?? String(r.reason) }] : [])),
    ending: x.ending ? { result: x.ending.winner === null ? "draw" : x.ending.winner === me ? "win" : "loss", how: SERIES_REASONS[x.ending.reason] ?? String(x.ending.reason) } : null,
    next_step: x.ending
      ? "The series is over: the reveal daemon settles it and the payout goes to the wallet."
      : bankOut
        ? "Your bank is out: your fallback plays every round for the rest of the series. Call line_state to follow it."
        : yourMove
          ? `Your move: line_move with this series, series_match ${x.match + 1}, round ${x.game.rounds + 1} and your pull (0 to ${x.game.energy[mine]}).`
          : open
            ? "Too late to commit this round: your fallback plays it once the deadline is applied. Call line_state."
            : x.phase === "reveal"
              ? "Both have committed: the reveal daemon reveals your move. Call line_state for the result."
              : "Waiting for the opponent's commit. Call line_state.",
  };
}

export function registerWagerTools(server: McpServer, deps: Deps, signer: ExecutionSigner, relay: RelayCall): StakedSeries {
  const { chain } = deps;
  const secrets = () => new WagerSecrets(signer.paths.wagerSecrets);
  const wallet = new PublicKey(signer.wallet);
  const program = () => {
    const p = wagerProgram(chain.cluster);
    if (!p) throw new ValidationError(`Wagering on The Line isn't deployed on ${chain.cluster}; this server builds there.`);
    return p;
  };
  const daemon = () => daemonStatus(signer.paths, { wallet: signer.wallet, cluster: chain.cluster, programId: program().toBase58() });
  const needDaemon = (what: string) => {
    const d = daemon();
    if (!d.ok) throw new HigherError(`${d.reason}, so ${what}. Ask the user to start \`highwire-wager run\` (same HIGHWIRE_CLUSTER, keypair and policy as this server).`, { code: "line_daemon_off" });
  };
  const execute = (tool: string, kind: string, solOut: bigint, envelope: Parameters<ExecutionSigner["execute"]>[1]["envelope"]): Promise<ExecuteResult> =>
    signer.execute(chain.connection, { tool, intent: { action: "wager", cluster: chain.cluster, solOut, wager: { kind } }, envelope });
  const ownPull = (series: string) => (hash: string) => secrets().move(series, hash)?.pull;
  const isMine = (s: SeriesAccountData) => s.header.playerA === signer.wallet || s.header.playerB === signer.wallet;
  /** Whether this wallet's stake into this series confirmed before: a ticket is used once. */
  const stakedBefore = (series: string) => {
    const addr = seriesAddress(program(), series).toBase58();
    return new AuditLog(signer.paths.audit).entries().some((e) => e.action === "wager" && e.series === addr && (e.wager === "open" || e.wager === "accept") && e.outcome === "confirmed");
  };
  const mustRead = async (id: string) => {
    program();
    const s = await readSeries(chain, id);
    if (!s) throw new HigherError("That series isn't on-chain: it hasn't been opened, or it has closed (line_state says how it ended).", { code: "wager_not_found" });
    if (!isMine(s)) throw new ValidationError("That series is between other wallets.");
    return s;
  };

  server.registerTool(
    "line_stake",
    {
      title: "The Line: stake a wager series (local signer)",
      description:
        "Stake SOL on a best-of-5 series against another agent, on the cluster the referee wagers on. Pairs you at a stake tier, then " +
        "stakes from this wallet through the local signer, inside the user's policy (\"wager\" in its actions, and a wagers " +
        "section allowing the tier). Needs the reveal daemon working for this wallet (`highwire-wager run`): a move nobody " +
        "reveals forfeits its match. If it answers waiting, call it again within a minute. Paired as B, call it again once " +
        "A has opened, to accept. Declare a fallback for rounds you miss: zero, mirror, or steady:<n>.",
      inputSchema: {
        stake: z.number().positive().max(10).describe("SOL a side: one of the tiers (line_wagers lists them)."),
        fallback: z.string().regex(/^(zero|mirror|steady:\d{1,2})$/).describe('What plays when you miss a commit: "zero", "mirror" or "steady:<n>". Committed when you stake, public once used.'),
        confirm: z.literal(true).describe("Stake the SOL."),
      },
      annotations: { title: "The Line: stake a wager series (local signer)", ...EXECUTE },
    },
    (args) =>
      run(async () => {
        program();
        signer.precheck("wager", chain.cluster, "line_stake");
        needDaemon("nothing could reveal your moves");
        const fallback = fallbackOf(args.fallback);
        const lamports = solToLamports(args.stake);
        const out = await relay("POST", "/api/arena/wager/join", { stake: String(lamports) });
        if (out.waiting) {
          return {
            waiting: true,
            waiting_at_this_tier: Number(out.waitingAtTier) || 0,
            owners_needed: Number(out.needed) || 0,
            waited_seconds: Number(out.waitedSeconds) || 0,
            next_step: "No opponent yet. Call line_stake again within a minute to keep your place. Nothing is staked until you're paired.",
          };
        }
        const v = out.series ?? {};
        const ticket = ticketOf(v.ticket ?? {});
        const role: "A" | "B" = v.role === "A" ? "A" : "B";
        if (v.cluster !== chain.cluster) throw new ValidationError(`The referee's wagers are on ${String(v.cluster)}, and this server builds on ${chain.cluster}.`);
        if (typeof v.id !== "string" || ticket.seriesId !== v.id || (role === "A" ? ticket.playerA : ticket.playerB) !== signer.wallet) {
          throw new HigherError("The referee's ticket isn't for this wallet in that role; nothing was staked. Tell the user.", { code: "wager_mismatch" });
        }
        // The stake is the ticket's: the agent asked for this one, so it must be this one.
        if (ticket.stake !== lamports) {
          throw new HigherError(
            `You're already paired at ${lamportsNumber(ticket.stake)} SOL a side (series ${v.id}). Stake that (line_stake with stake ${lamportsNumber(ticket.stake)}), or let the pairing expire in a few minutes. Nothing was staked.`,
            { code: "wager_mismatch" },
          );
        }
        const onchain = await readSeries(chain, v.id);
        if (onchain) {
          if (!isMine(onchain)) throw new HigherError("The referee named a series between other wallets; nothing was staked. Tell the user.", { code: "wager_mismatch" });
          if (onchain.header.status === "live" || role === "A") return { paired: true, ...wagerView(onchain, signer.wallet, undefined, ownPull(v.id)), note: "Already staked: the fallback is the one committed then." };
        } else if (role === "B") {
          return { paired: true, series: v.id, you: "B", waiting_for_opener: true, accept_by: new Date(ticket.acceptDeadline * 1000).toISOString(), next_step: "Your opponent opens first. Call line_stake again in a few seconds to accept." };
        }
        if (stakedBefore(v.id)) {
          throw new HigherError("This wallet already staked in that series, which has since closed: a ticket is used once. Call line_stake again in a minute or two for a new pairing.", { code: "wager_mismatch" });
        }
        needDaemon("nothing could reveal your moves");
        const fb = secrets().newFallback(v.id, role, fallback);
        const built = role === "A"
          ? await buildWagerOpen(chain, { wallet, ticket, signature: String(v.signature), fallbackHash: fb.hash })
          : await buildWagerAccept(chain, { wallet, ticket, signature: String(v.signature), fallbackHash: fb.hash });
        const o = outcome(await execute("line_stake", role === "A" ? "open" : "accept", built.stake, built.envelope));
        return {
          paired: true,
          series: v.id,
          you: role,
          stake_sol: lamportsNumber(built.stake),
          staked: o.report,
          next_step: o.dryRun
            ? "The policy is a dry run, so nothing was staked. The user sets it live to wager."
            : !o.landed
              ? "The stake didn't land (see staked). Call line_stake again to retry while the ticket lasts, or tell the user."
              : role === "A"
                ? "Staked and opened. Your opponent accepts next; then play with line_state and line_move, passing this series."
                : "Staked and accepted: match 1 has started. Play with line_state and line_move, passing this series.",
        };
      }),
  );

  server.registerTool(
    "line_wagers",
    {
      title: "The Line: your wagers",
      description: "This wallet's open and live wager series (from the chain), today's stakes (from the audit log), your wager rating and record and the tiers (from the referee, when it answers), and whether the reveal daemon is working.",
      inputSchema: {},
      annotations: { title: "The Line: your wagers", ...READ_ONLY },
    },
    () =>
      run(async () => {
        const p = program();
        const quiet = <T>(f: () => Promise<T>) => f().catch(() => null);
        // An RPC that refuses getProgramAccounts (public devnet's often does): the series this wallet staked in, by id.
        const series = () => listWalletSeries(chain, wallet).catch(() => readSeriesMany(chain, secrets().seriesIds()));
        const [all, info, mine] = await Promise.all([series(), quiet(() => relay("GET", "/api/arena/wager")), quiet(() => relay("GET", "/api/arena/wager/state"))]);
        const since = Date.now() - 86_400_000;
        const entries = new AuditLog(signer.paths.audit).entries();
        const unlanded = new Set(entries.filter((e) => e.outcome === "not_landed" && e.signature).map((e) => e.signature));
        const staked = entries
          .filter((e) => e.action === "wager" && e.outcome === "sent" && e.wallet === signer.wallet && (e.wager === "open" || e.wager === "accept") && e.cluster === chain.cluster && Date.parse(e.time) >= since && !(e.signature && unlanded.has(e.signature)))
          .reduce((n, e) => n + BigInt(e.lamports), 0n);
        const d = daemon();
        return {
          series: all.map((s) => wagerView(s, signer.wallet, undefined, ownPull(s.header.seriesId))),
          today: { staked_sol: lamportsNumber(staked), note: "Every stake sent in the last 24 hours, rent included, as the policy's daily limit counts it. Winnings never free up the day's limit." },
          you: mine?.you ? { rating: Number(mine.you.rating) || null, record: { win: Number(mine.you.record?.win) || 0, draw: Number(mine.you.record?.draw) || 0, loss: Number(mine.you.record?.loss) || 0 } } : null,
          tiers_sol: Array.isArray(info?.tiers) ? (info.tiers as unknown[]).filter((t) => /^\d{1,20}$/.test(String(t))).map((t) => lamportsNumber(BigInt(String(t)))) : null,
          ...(info ? {} : { referee: "not answering: the series above come from the chain" }),
          program: p.toBase58(),
          reveal_daemon: d.ok ? "working" : `NOT working: ${d.reason}. Start \`highwire-wager run\` before staking.`,
        };
      }),
  );

  /** A series that's gone from the chain: how it ended, from the program's closing event. */
  const ended = async (series: string) => {
    const o = await seriesOutcome(chain, series);
    if (o.state !== "closed") throw new HigherError("That series isn't on-chain: it hasn't been opened, or its closing isn't readable yet.", { code: "wager_not_found" });
    const me = secrets().player(series);
    const result = o.how !== "settled" ? o.how : o.winner === null ? "draw" : me === null ? `won by ${o.winner}` : o.winner === me ? "win" : "loss";
    return { series, status: "closed", how: o.how, result, ...(me ? { you: me } : {}), next_step: "The series is over and settled: the payout, if any, is in the wallet. line_stake starts another." };
  };

  return {
    /** line_state for a series: the chain's state, waiting up to 40 seconds for a change when asked. */
    async state(series: string, wait: boolean) {
      program();
      const first = await readSeries(chain, series);
      if (!first) return ended(series);
      if (!isMine(first)) throw new ValidationError("That series is between other wallets.");
      let s = first;
      const key = (x: SeriesAccountData) => `${x.series?.match}:${x.series?.game.rounds}:${x.series?.phase}:${Boolean(x.series?.ending)}`;
      const start = key(s);
      const yourMove = (x: SeriesAccountData) => {
        const v = wagerView(x, signer.wallet);
        return "your_move" in v && v.your_move;
      };
      const until = Date.now() + 40_000;
      while (wait && !s.series?.ending && !yourMove(s) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2_000));
        const next = await readSeries(chain, series);
        if (!next) return ended(series);
        s = next;
        if (key(s) !== start) break;
      }
      const d = daemon();
      return { ...wagerView(s, signer.wallet, undefined, ownPull(series)), reveal_daemon: d.ok ? "working" : `NOT working: ${d.reason}` };
    },

    /** line_move for a series: commits the pull (the nonce saved first, never returned); the daemon reveals it. */
    async move(series: string, pull: number, seriesMatch: number | undefined, round: number | undefined, line: string | undefined) {
      program();
      if (line) throw new ValidationError("Wager series carry no table talk: an opponent with money at stake has every reason to mislead.");
      if (seriesMatch === undefined || round === undefined) throw new ValidationError("A wager move names its series_match (1 to 5) and round, from line_state, so it's committed to the state you saw.");
      needDaemon("this commit would never be revealed and the match would be forfeited");
      const s = await mustRead(series);
      const x = s.series;
      if (!x || x.ending) throw new HigherError(x ? "The series is over." : "The series hasn't started: B hasn't accepted yet.", { code: "wager_late" });
      const me = s.header.playerA === signer.wallet ? "A" : "B";
      const mine = sideIndexOf(me, x.match);
      const r = x.game.rounds + 1;
      if (seriesMatch !== x.match + 1 || round !== r) throw new HigherError(`It's now round ${r} of match ${x.match + 1}: call line_state and choose again.`, { code: "wager_late" });
      if (x.phase !== "commit") throw new HigherError("Both sides have committed this round; it's being revealed.", { code: "wager_late" });
      if (x.round[mine].hash !== null) throw new HigherError("You've already committed this round.", { code: "wager_conflict" });
      if (x.round[mine].owesFallback) throw new HigherError(x.bankOut[me] ? "Your bank is out: your fallback plays every round." : "You missed this round's commit: your fallback plays it.", { code: "wager_late" });
      if (Math.floor(Date.now() / 1000) >= commitDeadline(x, mine) - COMMIT_MARGIN_SECONDS) throw new HigherError("Too close to this round's commit deadline to land in time: your fallback plays it.", { code: "wager_late" });
      if (pull > x.game.energy[mine]) throw new ValidationError(`You have ${x.game.energy[mine]} energy: pull 0 to ${x.game.energy[mine]}.`);
      const secret = secrets().newMove(series, x.match, r, mine === 0 ? "a" : "b", pull);
      const built = await buildWagerMove(chain, { wallet, seriesId: series, args: { kind: "commit", round: r, hash: secret.hash } });
      const o = outcome(await execute("line_move", "commit", 0n, built.envelope));
      return {
        committed: o.report,
        match: x.match + 1,
        round: r,
        pull,
        next_step: o.dryRun
          ? "The policy is a dry run, so nothing was committed and your fallback will play this round."
          : o.landed
            ? "Committed. The reveal daemon reveals it once both sides have committed; call line_state for the result."
            : "The commit didn't land (see committed). Call line_state: if it's still your move, try again; otherwise your fallback plays.",
      };
    },

    /** line_retire for a series: concedes it, if the policy's wagers.allow_retire lets it. */
    async retire(series: string) {
      await mustRead(series);
      const built = await buildWagerMove(chain, { wallet, seriesId: series, args: { kind: "retire" } });
      const o = outcome(await execute("line_retire", "retire", 0n, built.envelope));
      return {
        retired: o.report,
        next_step: o.landed ? "Conceded: the series goes to your opponent, and the daemon settles it." : o.dryRun ? "The policy is a dry run: nothing was conceded." : "The retirement didn't land (see retired); the series goes on. Call line_state.",
      };
    },
  };
}
