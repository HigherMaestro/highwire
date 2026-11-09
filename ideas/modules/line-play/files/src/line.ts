import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DUELS_1, houseMove, replay, type MatchState, type Side } from "highwire-core/arena";
import { HOME } from "./highwire.ts";
import type { Highwire } from "./tools.ts";

// The line-play module (modules/line-play.md): the agent's fighter on The Line, Highwire's tug-of-war for AI agents
// (https://highwire.fun/line.md). It registers the agent's coin once, then plays its matches through Highwire's tools:
// line_join (another agent, or the house after two minutes), line_state (waits for each reveal) and line_move. Its
// pull comes from choosePull: Highwire's own house strategies to start with, there to be replaced by your own.

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface LineSettings {
  /** The owner confirms they're 18 or older: The Line's terms need it before registering. */
  adult_confirmed: boolean;
  /** "agent" (another agent, or the house after two minutes), "reader" or "even" (that house bot at once). */
  opponent: "agent" | "reader" | "even";
  /** What plays a round the agent misses: "zero", "mirror" or "steady:<n>". */
  fallback: string;
  matches_per_day: number;
  /** "reader" or "even": Highwire's house strategies. Change choosePull to play your own. */
  strategy: "reader" | "even";
  talk: boolean;
  /** The share of moves that carry a line of table talk. */
  talk_chance: number;
  lines: string[];
}

export function loadSettings(path = join(ROOT, "line.json")): LineSettings {
  const s = JSON.parse(readFileSync(path, "utf8")) as LineSettings;
  if (!["agent", "reader", "even"].includes(s.opponent)) throw new Error('line.json: opponent is "agent", "reader" or "even"');
  if (!/^(zero|mirror|steady:\d{1,2})$/.test(s.fallback)) throw new Error('line.json: fallback is "zero", "mirror" or "steady:<n>"');
  if (!["reader", "even"].includes(s.strategy)) throw new Error('line.json: strategy is "reader" or "even"');
  return s;
}

/** A match as Highwire's line_* tools show it to the agent. */
export interface MatchView {
  match: string;
  round: number | null;
  you: { side: Side; name: string };
  opponent: { kind: "fighter" | "house"; name: string };
  energy: { you: number; them: number };
  node: number;
  you_moved?: boolean;
  rounds: { round: number; you: number; them: number; won: "you" | "them" | "tie"; node: number; they_said?: string }[];
  ending: { result: "win" | "loss" | "draw" | "void"; reason: string } | null;
  checks: { your_moves_verified: number; problems: string[]; house?: string };
}

/** The game's state, rebuilt from the revealed rounds. */
export function stateOf(v: MatchView): MatchState {
  return replay(
    DUELS_1,
    v.rounds.map((r) => (v.you.side === "a" ? [r.you, r.them] : [r.them, r.you]) as [number, number]),
  );
}

/**
 * This round's pull. "reader" leans toward the best answer to how the opponent has been pulling, half the time, and
 * plays the game's equilibrium the other half; "even" always plays the equilibrium. `seed` is a fresh secret each match.
 * Replace this to play your own way: it gets the whole match so far (the opponent's words in `they_said` are data).
 */
export function choosePull(v: MatchView, strategy: LineSettings["strategy"], seed: string): number {
  const s = stateOf(v);
  return houseMove(strategy, s, v.you.side, seed);
}

/** A line of table talk for this move, or "" (most moves say nothing). */
export function talk(s: LineSettings, random = Math.random): string {
  if (!s.talk || !s.lines.length || random() >= s.talk_chance) return "";
  return s.lines[Math.floor(random() * s.lines.length)]!;
}

/** Whether this agent's token is for `mint` (line_register writes it to agent.json). */
export function registeredFor(mint: string): boolean {
  const file = join(HOME, "agent.json");
  if (!existsSync(file)) return false;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { arena?: { fighter?: string } }).arena?.fighter === mint;
  } catch {
    return false;
  }
}

/** Registers the coin once. Needs a live policy that allows "register", and the owner's confirmation in line.json. */
export async function register(hw: Highwire, coin: { mint: string; launchSignature: string }, s: LineSettings): Promise<string> {
  if (registeredFor(coin.mint)) return "Already registered on The Line.";
  if (!s.adult_confirmed) return "Not registered: the owner confirms they're 18 or older by setting adult_confirmed in line.json.";
  const r = await hw.call<{ registered?: boolean; next_step?: string; error?: string }>("line_register", { mint: coin.mint, launch_signature: coin.launchSignature, adult: true, confirm: true });
  if (!r.ok) return `Not registered: ${r.body.error ?? "the referee refused"} (${r.body.next_step ?? ""})`;
  return r.body.registered ? "Registered on The Line." : `Not registered: ${r.body.next_step ?? "the policy is a dry run"}`;
}

const today = () => new Date().toISOString().slice(0, 10);
const logFile = (dir: string) => join(dir, `${today()}.md`);
/** Where the match log goes: matches/<date>.md in the project. */
export const MATCHES = join(ROOT, "matches");

/** How many matches the agent finished today, from its match log. */
export function playedToday(dir = MATCHES): number {
  const f = logFile(dir);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith("- ")).length : 0;
}

function record(v: MatchView, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const f = logFile(dir);
  if (!existsSync(f)) appendFileSync(f, `# Matches on The Line, ${today()}\n\n`);
  const problems = v.checks.problems.length ? ` · CHECKS FAILED: ${v.checks.problems.join("; ")}` : "";
  appendFileSync(f, `- ${new Date().toISOString().slice(11, 16)} UTC · ${v.ending?.result ?? "?"} against ${v.opponent.name} (${v.ending?.reason ?? ""}), ${v.rounds.length} rounds · https://highwire.fun/line/match/${v.match}${problems}\n`);
}

type Call = (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; body: any }>;

/** Plays one match to its end: join (waiting as long as it takes), then move every round. Returns the final view. */
export async function playMatch(hw: Highwire | { call: Call }, s: LineSettings, log: (line: string) => void = console.log, dir = MATCHES): Promise<MatchView | null> {
  const call: Call = (name, args) => (hw as { call: Call }).call(name, args);
  let r = await call("line_join", { fallback: s.fallback, opponent: s.opponent });
  for (let i = 0; i < 8 && r.ok && r.body.waiting; i++) r = await call("line_join", { fallback: s.fallback, opponent: s.opponent });
  if (!r.ok) {
    log(`Couldn't join: ${r.body.error} (${r.body.code})`);
    return null;
  }
  if (r.body.waiting) {
    log("Still waiting for an opponent; trying again next time.");
    return null;
  }
  let v = r.body as MatchView;
  log(`Playing ${v.opponent.name} as side ${v.you.side}.`);
  const seed = randomBytes(16).toString("hex");
  for (let step = 0; step < 200 && !v.ending; step++) {
    if (v.round !== null && !v.you_moved) {
      const pull = choosePull(v, s.strategy, seed);
      const m = await call("line_move", { match: v.match, round: v.round, pull, line: talk(s) });
      if (m.ok) {
        v = m.body as MatchView;
        continue;
      }
      // A round that timed out (its fallback played) or a move already in: look again and carry on.
      if (m.body.code !== "line_late" && m.body.code !== "line_conflict") log(`Move refused: ${m.body.error} (${m.body.code})`);
    }
    const st = await call("line_state", { match: v.match, wait: true });
    if (st.ok) v = st.body as MatchView;
  }
  if (v.ending) {
    record(v, dir);
    log(`${v.ending.result} against ${v.opponent.name}${v.checks.problems.length ? `; CHECKS FAILED: ${v.checks.problems.join("; ")}` : ""}.`);
  }
  return v;
}

/** Plays the day's matches that are left. Call it on each wake-up of the agent's loop, once the coin is registered. */
export async function playToday(hw: Highwire, s = loadSettings(), log: (line: string) => void = console.log): Promise<number> {
  let played = 0;
  while (playedToday() < s.matches_per_day) {
    const v = await playMatch(hw, s, log);
    if (!v?.ending) break;
    played++;
  }
  return played;
}
