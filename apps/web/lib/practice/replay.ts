import { commit, DUELS_1, playerOf, retire, reveal, sideOf, startSeries, timeout, type MatchResult, type MatchState, type Player, type SeriesState } from "highwire-core/arena";
import type { ClosedOutcome, SeriesHistory } from "highwire-core";

// A practice series replayed from its on-chain moves through the TypeScript twin of the program's rules
// (highwire-core/arena, series.ts), so every commitment is checked against its reveal and every round and match is
// worked out again, here. Runs on the server for the page and again in the browser, which is the check that counts.
// Imports only highwire-core/arena at runtime (the type import is erased), so it's safe in the browser.

export interface ReplayRound {
  round: number;
  /** Pulls by player, A and B. */
  pull: Record<Player, number>;
  /** Whether that player's fallback played the round (no commit of its own). */
  fallback: Record<Player, boolean>;
  winner: Player | null;
  /** The node after the round, from A's view: positive is toward A's own end. */
  node: number;
}

export interface ReplayMatch {
  match: number;
  /** Which side A played: "a" pulls toward the left end, "b" toward the right. */
  sideA: "a" | "b";
  rounds: ReplayRound[];
  result: { winner: Player | null; reason: MatchResult["reason"] } | null;
}

export interface Replay {
  /** Every move the chain accepted also replayed under the rules, every reveal matching its commitment. */
  ok: boolean;
  /** Where the replay and the chain parted, if they did. */
  problem: string | null;
  players: Record<Player, string> | null;
  matches: ReplayMatch[];
  commits: number;
  reveals: number;
  /** The series' end as the replay has it, and the program's own closing event. */
  ending: SeriesState["ending"];
  closed: ClosedOutcome | null;
  /** The replay's winner is the closing event's. */
  agrees: boolean | null;
}

const RULES_MATCH = (h: SeriesHistory) =>
  h.rules.places === DUELS_1.places &&
  h.rules.energy === DUELS_1.energy &&
  h.rules.regen === DUELS_1.regen &&
  h.rules.rounds === DUELS_1.rounds &&
  h.rules.roundSeconds === DUELS_1.roundSeconds &&
  h.rules.bankSeconds === DUELS_1.bankSeconds &&
  h.rules.tieBreakSpent === (DUELS_1.tieBreak === "spent");

function rounds(game: MatchState, match: number, committed: Set<string>): ReplayRound[] {
  const sA = sideOf("A", match);
  return game.rounds.map((r, i) => {
    const round = i + 1;
    const by = (p: Player) => r.pull[sideOf(p, match)];
    return {
      round,
      pull: { A: by("A"), B: by("B") },
      fallback: { A: !committed.has(`${match}:${round}:A`), B: !committed.has(`${match}:${round}:B`) },
      winner: r.winner === null ? null : playerOf(r.winner, match),
      node: sA === "a" ? -r.node : r.node,
    };
  });
}

export function replaySeries(h: SeriesHistory): Replay {
  const out: Replay = { ok: false, problem: null, players: null, matches: [], commits: 0, reveals: 0, ending: null, closed: null, agrees: null };
  if (!RULES_MATCH(h)) return { ...out, problem: "The program's rules aren't the ones this page knows (duels-1)." };
  // A can cancel an unaccepted series and open it again on the same ticket: only its last life counts.
  const from = h.events.map((e) => e.kind).lastIndexOf("open");
  if (from < 0) return { ...out, problem: "No opening transaction found for this series." };
  const events = h.events.slice(from);
  const open = events[0]!;
  if (open.kind !== "open") return out;
  const accept = events.find((e) => e.kind === "accept");
  const closed = events.find((e) => e.kind === "closed");
  out.closed = closed?.kind === "closed" ? closed.outcome : null;
  out.players = { A: open.playerA, B: open.playerB };
  if (!accept || accept.kind !== "accept") {
    // Never accepted: no move can have been made, and only a cancel (or a freeze) can have closed it.
    const moved = events.some((e) => e.kind !== "open" && e.kind !== "closed");
    if (moved || (out.closed && out.closed.how !== "cancelled" && out.closed.how !== "refunded" && out.closed.how !== "unread")) {
      return { ...out, problem: "Moves or a payout without the second side's acceptance: the history read from the chain is incomplete." };
    }
    return { ...out, ok: true };
  }
  const who = (wallet: string): Player | null => (wallet === open.playerA ? "A" : wallet === open.playerB ? "B" : null);
  const s = startSeries({ rules: DUELS_1, revealSeconds: h.revealSeconds }, h.seriesId, { A: open.fallbackHash, B: accept.fallbackHash }, accept.at);
  const committed = new Set<string>();
  try {
    for (const e of events) {
      if (e.kind === "open" || e.kind === "accept" || e.kind === "closed") continue;
      if (e.kind === "timeout") {
        timeout(s, e.at);
        continue;
      }
      const p = who(e.player);
      if (!p) throw new Error(`a move by ${e.player}, who isn't in this series`);
      if (e.kind === "commit") {
        committed.add(`${s.match}:${e.round}:${p}`);
        // A commit from before commits named their match was taken in whichever match was in play.
        commit(s, p, e.match ?? s.match, e.round, e.hash, e.at);
        out.commits++;
      } else if (e.kind === "reveal") {
        reveal(s, p, { pull: e.pull, nonce: e.nonce }, e.at);
        out.reveals++;
      } else if (e.kind === "revealFallback") {
        reveal(s, p, { fallback: e.fallback.kind === "steady" ? { kind: "steady", pull: e.fallback.pull } : { kind: e.fallback.kind }, salt: e.salt }, e.at);
        out.reveals++;
      } else if (e.kind === "retire") retire(s, p);
    }
  } catch (err) {
    out.problem = `The replay stopped where the chain went on: ${err instanceof Error ? err.message : String(err)}.`;
  }
  const finished = s.games.map((g, i) => ({ match: i + 1, sideA: sideOf("A", i), rounds: rounds(g, i, committed), result: s.results[i] ?? null }));
  // The match in play: unfinished, or cut short by a retirement.
  if ((!s.ending || s.ending.reason === "retired") && s.game.rounds.length > 0 && s.games[s.games.length - 1] !== s.game) finished.push({ match: s.match + 1, sideA: sideOf("A", s.match), rounds: rounds(s.game, s.match, committed), result: null });
  out.matches = finished;
  out.ending = s.ending;
  if (out.closed?.how === "settled") out.agrees = (s.ending?.winner ?? null) === out.closed.winner && s.ending !== null;
  out.ok = out.problem === null && out.agrees !== false;
  if (out.agrees === false && !out.problem) out.problem = "The replay's result isn't the one the program announced.";
  return out;
}
