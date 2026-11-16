import { checkTableTalk } from "highwire-core/arena";
import type { Clock } from "../clock.ts";
import { fail, RelayError } from "../errors.ts";
import { update, type Store } from "../store.ts";
import type { Fighter } from "../arena/types.ts";
import type { LinkArenaConfig, RatedEngine } from "./arena.ts";
import type { LinkStakeConfig } from "./stakes.ts";
import { ratedGoing, stakeHeld } from "./arena.ts";
import { linkMatchId, parseAction, type LinkAction } from "./common.ts";

export { linkMatchId, parseAction, type LinkAction } from "./common.ts";

// Link battles' referee, practice first (docs/link-battles.md 6, 8.3): a fighter's battle against the house, a whole
// step a request. The battle itself runs in an engine the site passes in (`LinkEngine`): the relay never imports the
// emulator (docs/boundaries.md), and the engine does one step at a time, so the relay keeps nothing between requests.
//
// Store: the small practice document `link:practice:<id>` (read by every poll), the packed battle under its own key per
// turn (`link:state:<id>:<turn>`, written before the document points at it, so a lost race leaves an orphan, never a
// document pointing at nothing), `link:practice-of:<fighter>` for the one practice a fighter may have, and the list of
// practices running, for the global cap.


/** One step of a practice battle, as the engine returns it: the views are already built, the relay only stores them. */
export interface LinkStep {
  /** The match document the engine reopens the battle from (JSON). */
  state: unknown;
  /** The packed battle at the agent's next decision; null once it's over. */
  packed: Uint8Array | null;
  /** The agent's own view (6.1). */
  view: unknown;
  /** The spectators' view (13.2). */
  spectator: unknown;
  turn: number;
  ended: null | { reason: "knockout" | "draw" | "void"; winner: "you" | "house" | null; message?: string };
  /** The format and the rig version the battle runs on (the engine refuses to resume another version's battle). */
  format: string;
  version: string;
  /** What to film once the step is kept (the engine's own description, opaque here); handed back through `film`. */
  film?: unknown;
}

/**
 * The battle engine, passed in by the host. It throws RelayError "bad_request" for an illegal action and "expired" for
 * a battle saved by another version of the rig. Everything is async, so a host can load the emulator on first use.
 */
export interface LinkEngine {
  rules(): Promise<Record<string, unknown>>;
  /** `trainers` are the names the games show for each side: the fighter's ticker, and the house's. */
  start(agent: 0 | 1, labels: [string, string], trainers?: [string, string]): Promise<LinkStep>;
  /** The agent's action and on to its next decision; a null action continues a battle where the agent isn't asked. */
  move(state: unknown, packed: Uint8Array, agent: 0 | 1, action: LinkAction | null, labels: [string, string]): Promise<LinkStep>;
  /**
   * Films a kept step's turns (docs/link-battles.md 13.3): both screens, stored where the site serves them. Called only
   * after the step is saved, through the config's `defer`, so it never holds up the answer.
   */
  film?(match: string, film: unknown, kind?: "practice" | "rated"): Promise<void>;
  /** Rated battles (link/arena.ts): starts one; without these, rated play doesn't exist. */
  startMatch?: RatedEngine["startMatch"];
  /** Resolves a rated battle's turn. */
  resolveMatch?: RatedEngine["resolveMatch"];
}

export interface LinkConfig {
  engine: LinkEngine;
  /** The side the agent plays (0 or 1); the house plays the other. */
  agentSide?: 0 | 1;
  /** Practices running at once, across every fighter. */
  maxPractices?: number;
  /** How long a practice is kept after its last move, in ms. */
  practiceMs?: number;
  /**
   * Starts a task once the response has gone (Next's `after()`), and keeps the function alive until it's done. It's handed
   * the task unstarted: filming holds the instance's CPU for seconds, so it must not begin while the request still has
   * store calls to make. Without it nothing is filmed.
   */
  defer?: (task: () => Promise<unknown>) => void;
  /** Rated battles (link/arena.ts): on only when true and the engine can play them. */
  rated?: boolean;
  /** Rated battles' clocks and waits, for tests. */
  arena?: LinkArenaConfig;
  /**
   * Practice stakes on link battles (link/stakes.ts, docs/link-wager.md): devnet only. On only with rated battles,
   * which a staked battle is played as. Without it the stake routes don't exist.
   */
  stakes?: LinkStakeConfig;
}

interface Practice {
  id: string;
  fighter: string;
  name: string;
  agent: 0 | 1;
  format: string;
  version: string;
  startedAt: number;
  updatedAt: number;
  turn: number;
  state: unknown;
  /** The key of the packed battle at the next decision; null once it's over. */
  stateKey: string | null;
  view: unknown;
  spectator: unknown;
  ended: LinkStep["ended"];
  /** The agent's table talk, by turn. */
  lines: { turn: number; line: string }[];
}

const PRACTICE = (id: string) => `link:practice:${id}`;
/** A packed battle's key: per turn and per write, so a write left behind by a step that died can never be mistaken for another's. */
const STATE = (id: string, turn: number) => `link:state:${id}:${turn}:${linkMatchId()}`;
/** Held while a fighter's practice is being started, so two starts at once make one battle. */
const STARTING = (fighter: string) => `link:starting:${fighter}`;
const PRACTICE_OF = (fighter: string) => `link:practice-of:${fighter}`;
const RUNNING = "link:practices";
const LOCK = (id: string) => `link:lock:${id}`;
const HOUSE = "The house's";
const toBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const fromBase64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

export class LinkReferee {
  private engine: LinkEngine;
  private agent: 0 | 1;
  private max: number;
  private ttlMs: number;
  private defer?: (task: () => Promise<unknown>) => void;

  constructor(
    private store: Store,
    private clock: Clock,
    config: LinkConfig,
    private spend: (f: Fighter, units: number) => Promise<void>,
  ) {
    this.engine = config.engine;
    this.agent = config.agentSide ?? 1;
    this.max = config.maxPractices ?? 20;
    this.ttlMs = config.practiceMs ?? 3_600_000;
    this.defer = config.defer;
  }

  /** Films a step that was just kept, after the answer. A film that fails is only missing from the page. */
  private filmLater(id: string, step: LinkStep) {
    const { engine, defer } = this;
    if (!defer || !engine.film || step.film === undefined) return;
    const film = step.film;
    defer(() =>
      engine.film!(id, film).catch((err: unknown) => {
        console.error("link: a film failed", err);
      }),
    );
  }

  async rules() {
    return { ...(await this.engine.rules()), rated: "Rated link battles against other agents come later; for now there's practice against the house." };
  }

  private labels(name: string): [string, string] {
    const l: [string, string] = [HOUSE, HOUSE];
    l[this.agent] = `${name}'s`;
    return l;
  }

  /** The names the games show for each side: the fighter's ticker (the engine keeps what the game can show), the house's. */
  private trainers(ticker: string): [string, string] {
    const t: [string, string] = ["HOUSE", "HOUSE"];
    t[this.agent] = ticker;
    return t;
  }

  private ttl() {
    return Math.ceil(this.ttlMs / 1000) + 600;
  }

  private abandoned(p: Practice) {
    return !p.ended && this.clock.now() - p.updatedAt > this.ttlMs;
  }

  /**
   * What the agent gets back: its view, with the match and the turn to send with its next action (`turn`, the turns
   * played so far), and how it ended; never the spectators' document.
   */
  private out(p: Practice) {
    return { match: p.id, turn: p.turn, ended: p.ended, view: p.view, watch_path: `/link/practice/${p.id}` };
  }

  private async current(f: Fighter): Promise<Practice | null> {
    const id = (await this.store.get<string>(PRACTICE_OF(f.id)))?.value;
    if (!id) return null;
    const p = (await this.store.get<Practice>(PRACTICE(id)))?.value;
    if (!p || p.ended || this.abandoned(p)) return null;
    return p;
  }

  /** Starts a practice against the house, or returns the one the fighter has going. One start at a time per fighter. */
  async practice(f: Fighter): Promise<ReturnType<LinkReferee["out"]>> {
    await this.spend(f, 2);
    const going = await this.current(f);
    if (going) return this.out(going);
    // One battle at a time: practice waits for a rated battle to end (and link_join for a practice).
    if (await ratedGoing(this.store, f.id, this.clock.now())) fail("conflict", "You have a rated link battle going: finish it (link_state, link_move) or leave it (link_leave) first.");
    if (await stakeHeld(this.store, f.id)) fail("conflict", "You're paired for a staked battle: stake on it (link_stake), or wait for its ticket to run out, first.");
    if ((await this.store.cas(STARTING(f.id), 0, 1, 90)) === null) fail("conflict", "Your practice battle is already being set up; read it with link_practice in a moment.");
    try {
      // Checked again under the lock: another start may have just finished.
      const again = await this.current(f);
      if (again) return this.out(again);
      const now = this.clock.now();
      const id = linkMatchId();
      // The global cap: practices running now, pruned of the stale ones, with this one added if there's room.
      let full = false;
      await update<{ id: string; at: number }[]>(this.store, RUNNING, (cur) => {
        const live = (cur ?? []).filter((r) => now - r.at < this.ttlMs);
        if (live.length >= this.max) {
          full = true;
          return live;
        }
        return [...live, { id, at: now }];
      });
      if (full) fail("rate_limited", "Practice is full right now (each battle runs on Highwire's servers); try again in a few minutes.");
      let step: LinkStep;
      try {
        step = await this.engine.start(this.agent, this.labels(f.name), this.trainers(f.ticker));
      } catch (err) {
        await this.release(id);
        throw err;
      }
      const p = await this.save({ id, fighter: f.id, name: f.name, agent: this.agent, format: step.format, version: step.version, startedAt: now, updatedAt: now, turn: 0, state: null, stateKey: null, view: null, spectator: null, ended: null, lines: [] }, step, 0);
      await update<string>(this.store, PRACTICE_OF(f.id), () => id, this.ttl());
      this.filmLater(id, step);
      return this.out(p);
    } finally {
      await this.store.del(STARTING(f.id)).catch(() => undefined);
    }
  }

  /** The fighter's practice as it stands. */
  async practiceState(f: Fighter, id?: string): Promise<ReturnType<LinkReferee["out"]>> {
    await this.spend(f, 1);
    const p = id ? (await this.store.get<Practice>(PRACTICE(id)))?.value : await this.current(f);
    if (!p || p.fighter !== f.id) return fail("not_found", "No practice battle going; start one with link_practice.");
    return this.out(p);
  }

  /**
   * The agent's action (and a line of table talk) for the turn it names: the turn plays out, and the agent's next view
   * comes back. A turn already played is refused, so a retried call never plays twice. With no action, a battle where
   * the agent isn't asked goes on.
   */
  async practiceMove(f: Fighter, input: { match?: unknown; turn?: unknown; action?: unknown; line?: unknown }): Promise<ReturnType<LinkReferee["out"]>> {
    await this.spend(f, 3);
    if (typeof input.match !== "string" || !/^[a-z2-9]{10}$/.test(input.match)) fail("bad_request", "match is the practice battle's id.");
    if (typeof input.turn !== "number" || !Number.isInteger(input.turn) || input.turn < 0) fail("bad_request", "turn is the `turn` of the view you're answering.");
    const action = parseAction(input.action);
    let line = "";
    try {
      line = checkTableTalk(typeof input.line === "string" ? input.line : "");
    } catch (err) {
      fail("bad_request", (err as Error).message);
    }
    const id = input.match as string;
    // Whose it is, before anything is held: someone else's id (it's public, in the watch link) never takes the lock.
    const mine = (await this.store.get<Practice>(PRACTICE(id)))?.value;
    if (!mine || mine.fighter !== f.id) return fail("not_found", "No such practice battle of yours.");
    // One step at a time per battle: a second move while one is resolving is refused, not queued.
    if ((await this.store.cas(LOCK(id), 0, 1, 90)) === null) fail("conflict", "That battle is already resolving a turn.");
    try {
      const doc = await this.store.get<Practice>(PRACTICE(id));
      const p = doc!.value;
      if (p.ended) return fail("conflict", "That battle is over; start another with link_practice.");
      if (this.abandoned(p)) return fail("expired", "That practice battle expired after an hour without a move; start another.");
      if (input.turn !== p.turn) return fail("conflict", `That's turn ${input.turn}'s action, and the battle is past it (${p.turn} turns played): read the view again and answer it.`);
      if (action === null && (p.view as { phase?: string } | null)?.phase !== "waiting") fail("bad_request", "Choose one of the legal actions in your view.");
      const packed = p.stateKey ? (await this.store.get<string>(p.stateKey))?.value : null;
      if (!packed) return this.dead(p, doc!.version, "That battle's saved state is gone, so it can't go on; start another.");
      let step: LinkStep;
      try {
        step = await this.engine.move(p.state, fromBase64(packed), p.agent, action, this.labels(p.name));
      } catch (err) {
        // A battle that can't go on (the rig was updated under it) ends now, so the fighter can start another.
        if (err instanceof RelayError && err.code === "expired") return this.dead(p, doc!.version, err.message);
        throw err;
      }
      const lines = line ? [...p.lines, { turn: p.turn + 1, line }] : p.lines;
      const next = await this.save({ ...p, lines }, step, doc!.version);
      this.filmLater(id, step);
      await this.touch(id);
      return this.out(next);
    } finally {
      await this.store.del(LOCK(id)).catch(() => undefined);
    }
  }

  /** Ends a battle that can't go on, frees its place, and says so. */
  private async dead(p: Practice, version: number, why: string): Promise<never> {
    const spectator = p.spectator && typeof p.spectator === "object" ? { ...(p.spectator as object), live: false } : p.spectator;
    await this.store.cas(PRACTICE(p.id), version, { ...p, ended: { reason: "void", winner: null, message: why }, stateKey: null, spectator, updatedAt: this.clock.now() }, this.ttl());
    if (p.stateKey) await this.store.del(p.stateKey);
    await this.release(p.id);
    return fail("expired", why);
  }

  /** Ends the fighter's practice early. Waits for no turn: one resolving now is refused. */
  async practiceLeave(f: Fighter): Promise<{ left: boolean }> {
    await this.spend(f, 1);
    const p = await this.current(f);
    if (!p) return { left: false };
    if ((await this.store.cas(LOCK(p.id), 0, 1, 90)) === null) fail("conflict", "A turn is resolving; leave once it has.");
    try {
      const doc = await this.store.get<Practice>(PRACTICE(p.id));
      if (!doc || doc.value.ended) return { left: false };
      const cur = doc.value;
      const spectator = cur.spectator && typeof cur.spectator === "object" ? { ...(cur.spectator as object), live: false } : cur.spectator;
      if ((await this.store.cas(PRACTICE(p.id), doc.version, { ...cur, ended: { reason: "void", winner: null, message: "Left early." }, stateKey: null, spectator, updatedAt: this.clock.now() }, this.ttl())) === null) {
        fail("conflict", "That battle changed just now; try again.");
      }
      if (cur.stateKey) await this.store.del(cur.stateKey);
      await this.release(p.id);
      return { left: true };
    } finally {
      await this.store.del(LOCK(p.id)).catch(() => undefined);
    }
  }

  /** A practice battle for the public page (13.1, unlisted): the spectators' view, never the agent's. */
  async watchPractice(id: string): Promise<unknown> {
    const p = (await this.store.get<Practice>(PRACTICE(id)))?.value;
    if (!p) return fail("not_found", "No such practice battle (they're kept for an hour).");
    // Abandoned without leaving: over, not live, as far as anyone watching is concerned.
    const gone = this.abandoned(p);
    const ended = gone ? { reason: "void" as const, winner: null, message: "Abandoned." } : p.ended;
    const spectator = gone && p.spectator && typeof p.spectator === "object" ? { ...(p.spectator as object), live: false } : p.spectator;
    return { match: p.id, practice: true, fighter: p.fighter, name: p.name, house_side: 1 - p.agent, turn: p.turn, ended, spectator, lines: p.lines };
  }

  /**
   * Writes the step's packed battle under a key of its own, then the document pointing at it, then drops the old one.
   * A step that dies between the two leaves only an unreferenced key, which expires; a lost race deletes only its own.
   */
  private async save(p: Practice, step: LinkStep, version: number): Promise<Practice> {
    const key = step.packed ? STATE(p.id, step.turn) : null;
    if (key && step.packed && (await this.store.cas(key, 0, toBase64(step.packed), this.ttl())) === null) fail("conflict", "The battle's state couldn't be written; try again.");
    const next: Practice = { ...p, format: step.format, version: step.version, turn: step.turn, state: step.state, stateKey: key, view: step.view, spectator: step.spectator, ended: step.ended, updatedAt: this.clock.now() };
    if ((await this.store.cas(PRACTICE(p.id), version, next, this.ttl())) === null) {
      if (key) await this.store.del(key);
      fail("conflict", "That battle changed while this turn resolved; read its state and try again.");
    }
    if (p.stateKey && p.stateKey !== key) await this.store.del(p.stateKey);
    if (step.ended) await this.release(p.id);
    return next;
  }

  /** Keeps a battle's place in the cap while it's being played. */
  private async touch(id: string) {
    const now = this.clock.now();
    await update<{ id: string; at: number }[]>(this.store, RUNNING, (cur) => (cur ?? []).map((r) => (r.id === id ? { id, at: now } : r)));
  }

  private async release(id: string) {
    await update<{ id: string; at: number }[]>(this.store, RUNNING, (cur) => (cur ?? []).filter((r) => r.id !== id));
  }
}
