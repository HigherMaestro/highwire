import { arenaGuide } from "highwire-core/arena";
import type { Clock } from "./clock.ts";
import { RelayError } from "./errors.ts";
import { Referee, type CoinDirectory, type RefereeConfig } from "./arena/referee.ts";
import { Registration, type RegistrationRpc } from "./registration.ts";
import { LinkReferee, type LinkConfig } from "./link/referee.ts";
import { LinkArena, linkFilmsVisible, type RatedEngine } from "./link/arena.ts";
import { LinkStakeDesk } from "./link/stakes.ts";
import type { Store } from "./store.ts";

// The relay's routes, as one fetch handler (Request in, Response out), so any host can mount it: the relay's own
// Vercel project in production, an in-process call in tests and in the local server's end-to-end check.
//
//   POST /api/agents/challenge     { wallet, mint, launchSignature, secretHash }
//   POST /api/agents/register      { code, signature, secret }  -> { arenaToken, fighter }  (0.14's `adult` is ignored)
//   GET  /api/arena/rules
//   POST /api/arena/join           { fallback, opponent?, wait? }             (token) waits up to 40s to be paired
//   GET  /api/arena/queue          how many fighters are waiting
//   GET  /api/arena/state?match=&after=&wait=1                                (arena token)
//   POST /api/arena/move           { match, round, pull, nonce, line }       (arena token)
//   POST /api/arena/retire                                                    (arena token)
//   GET  /api/arena/match/<id>     a spectator's view, cached 2 seconds
//   GET  /api/arena/fighter/<mint>
//   GET  /api/arena/leaderboard
//   GET  /api/arena/sweep          the cron: with CRON_SECRET set it needs the secret, otherwise once per 30 seconds
//   GET  /api/arena/wager          the wager program, cluster, tiers and ticket key (404 when wagering is off)
//   POST /api/arena/wager/join     { stake: "<lamports a side>", wait? }      (arena token) waits up to 40s to be paired
//   GET  /api/arena/wager/state                                               (arena token) the fighter's series
//   POST /api/arena/wager/leave                                               (arena token) leaves the queue
//   GET  /api/link/rules           link battles: the format and the actions (404 without a link engine)
//   POST /api/link/practice        (arena token) starts a battle against the house, or returns the one going
//   GET  /api/link/practice/state?match=  (arena token) the fighter's practice view
//   POST /api/link/practice/move   { match, action, line? }  (arena token) plays the turn; the next view comes back
//   POST /api/link/practice/leave  (arena token)
//   GET  /api/link/practice/<id>   the spectators' view of a practice battle, cached 2 seconds
//   POST /api/link/join            { fallback, opponent?, wait? }  (arena token) rated link battles: queues, waits up to 40s
//   GET  /api/link/state?match=&after=&wait=1                      (arena token) this side's view; long-polls
//   POST /api/link/move            { match, turn, action, line? }  (arena token) this turn's decision, held until it resolves
//   POST /api/link/leave           (arena token) a forfeit
//   GET  /api/link/stake           practice stakes (devnet): the program, tiers and the desk's public keys (404 when off)
//   POST /api/link/stake/join      { stake: "<lamports a side>", fallback, wait? }  (arena token) waits up to 40s to be paired
//   GET  /api/link/stake/state     (arena token) the fighter's stake: its ticket, the battle to play, the signed result
//   GET  /api/link/stake/results   (arena token) its battles that are over and not yet settled, each with the signed result
//   GET  /api/link/stake/result/<battle id>   a finished battle's signed result, for anyone to settle with, cached 10 seconds
//   POST /api/link/stake/leave     (arena token) leaves the queue
//   GET  /api/link/stakes          the staked battles played, for the practice page (no amounts), cached 10 seconds
//   GET  /api/link/match/<id>      a battle's spectators' view, cached 2 seconds
//   GET  /api/link/matches         battles live and recent, for the lobby, cached 5 seconds
//   GET  /api/link/leaderboard     link battles' ladder, cached 30 seconds
//   GET  /api/arena/admin/flags (cheating signals), POST /api/arena/admin/hide { match, round, side } (legal takedowns)
//   GET  /api/arena/admin/metrics?weeks=12 (free play's weekly numbers), POST /api/arena/admin/metrics/backfill
//                                  (LINE_ADMIN_TOKEN; off without it)

export interface RelayOptions {
  store: Store;
  clock: Clock;
  rpc: RegistrationRpc;
  coins: CoinDirectory;
  /** The cron's bearer secret. Without it anyone may call the sweep, but it runs at most once every 30 seconds. */
  cronSecret?: string;
  /** The moderator's bearer token for the admin routes; without it they don't exist. */
  adminToken?: string;
  /** Who's calling, for the per-caller limit on registration (an IP, from the host). */
  clientKey?: (req: Request) => string | null;
  referee?: RefereeConfig;
  /** Link battles (docs/link-battles.md): the battle engine, passed in by the host; without it the routes don't exist. */
  link?: LinkConfig;
}

export interface Relay {
  fetch(req: Request): Promise<Response>;
  referee: Referee;
  registration: Registration;
  link: LinkReferee | null;
  /** Rated link battles, when switched on and the engine plays them. */
  linkArena: LinkArena | null;
  /** Link battles' practice-stake desk, when it's configured and rated battles are on. */
  linkStakes: LinkStakeDesk | null;
  /**
   * Whether a battle's screens may be shown, read from the store whether or not rated play is on: true once a rated
   * battle is over, false while it's on, null when no rated battle has that id (a practice's, shown as filmed).
   */
  linkFilmsVisible(id: string): Promise<boolean | null>;
}

const json = (body: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": cache } });

export function createRelay(o: RelayOptions): Relay {
  const referee = new Referee(o.store, o.clock, o.coins, o.referee);
  const registration = new Registration(o.store, o.rpc, () => o.clock.now());
  const link = o.link ? new LinkReferee(o.store, o.clock, o.link, (f, units) => referee.spend(f, units)) : null;
  const rated = o.link?.rated && o.link.engine.startMatch && o.link.engine.resolveMatch ? o.link : null;
  const linkArena = rated ? new LinkArena(o.store, o.clock, rated.engine as typeof rated.engine & RatedEngine, (f, units) => referee.spend(f, units), rated.defer, rated.arena, () => referee.outages()) : null;
  const linkStakes = linkArena && o.link?.stakes ? new LinkStakeDesk(o.store, o.clock, o.link.stakes, linkArena, (f, units) => referee.spend(f, units)) : null;

  const body = async (req: Request): Promise<Record<string, unknown>> => {
    try {
      const b = await req.json();
      return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
    } catch {
      throw new RelayError("bad_request", "The body is JSON.");
    }
  };
  const bearer = (req: Request) => /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
  const fighter = (req: Request) => referee.authenticate(bearer(req));
  /** A per-caller limit for the routes without a token: each registration step reads the chain. */
  const limitCaller = async (req: Request, what: string, perMinute: number) => {
    const who = o.clientKey?.(req);
    if (!who) return;
    const used = await o.store.incr(`arena:rl-ip:${what}:${who}:${Math.floor(o.clock.now() / 60_000)}`, 1, 120);
    if (used > perMinute) throw new RelayError("rate_limited", "Too many requests from here this minute; wait a little.");
  };

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");
    const m = req.method;
    if (m === "POST" && path === "/api/agents/challenge") {
      await limitCaller(req, "challenge", 20);
      return json(await registration.challenge(await body(req)));
    }
    if (m === "POST" && path === "/api/agents/register") {
      await limitCaller(req, "register", 20);
      const b = await body(req);
      const v = await registration.verify(b);
      const { token, fighter: f } = await referee.enroll(v);
      return json({ arenaToken: token, fighter: f });
    }
    if (m === "GET" && path === "/api/arena/rules") return json(arenaGuide(), 200, "public, s-maxage=3600");
    if (m === "POST" && path === "/api/arena/join") return json(await referee.join(await fighter(req), await body(req)));
    if (m === "GET" && path === "/api/arena/state") {
      const f = await fighter(req);
      const after = url.searchParams.get("after");
      return json(await referee.state(f, { match: url.searchParams.get("match") ?? undefined, after: after === null ? undefined : Number(after), wait: url.searchParams.get("wait") === "1" }));
    }
    if (m === "POST" && path === "/api/arena/move") return json(await referee.move(await fighter(req), await body(req)));
    if (m === "POST" && path === "/api/arena/retire") return json(await referee.retire(await fighter(req)));
    if (path === "/api/arena/wager" || path.startsWith("/api/arena/wager/")) {
      const desk = referee.wager;
      if (!desk) throw new RelayError("not_found", "Wagering isn't open.");
      if (m === "GET" && path === "/api/arena/wager") return json(desk.info(), 200, "public, s-maxage=60");
      if (m === "POST" && path === "/api/arena/wager/join") return json(await desk.join(await fighter(req), await body(req)));
      if (m === "GET" && path === "/api/arena/wager/state") return json(await desk.state(await fighter(req)));
      if (m === "POST" && path === "/api/arena/wager/leave") return json(await desk.leave(await fighter(req)));
      throw new RelayError("not_found", "No such route.");
    }
    if (m === "GET" && path === "/api/arena/queue") return json({ waiting: await referee.queueSize() }, 200, "public, s-maxage=5");
    if (m === "GET" && path === "/api/arena/leaderboard") return json(await referee.leaderboard(), 200, "public, s-maxage=30");
    const match = /^\/api\/arena\/match\/([0-9a-f]{24})$/.exec(path);
    if (m === "GET" && match) return json(await referee.spectate(match[1]!), 200, "public, s-maxage=2");
    const one = /^\/api\/arena\/fighter\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
    if (m === "GET" && one) return json(await referee.fighter(one[1]!), 200, "public, s-maxage=30");
    if ((m === "POST" || m === "GET") && path === "/api/arena/sweep") {
      if (o.cronSecret) {
        if (bearer(req) !== o.cronSecret) throw new RelayError("unauthorized", "The sweep is for the cron.");
      } else if ((await o.store.cas("arena:sweep-lock", 0, 1, 30)) === null) {
        return json({ skipped: "a sweep ran in the last 30 seconds" });
      }
      const swept = await referee.sweep();
      // Each of the other sweeps on its own: one that throws doesn't cost the rest their minute.
      const each = async <T>(what: string, run: (() => Promise<T>) | null): Promise<T | { failed: true } | undefined> => {
        if (!run) return undefined;
        try {
          return await run();
        } catch (err) {
          console.error(`sweep: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
          return { failed: true };
        }
      };
      const wagers = await each("the wager desk", referee.wager ? () => referee.wager!.sweep() : null);
      const linkSwept = await each("link battles", linkArena ? () => linkArena.sweep() : null);
      const stakesSwept = await each("link battles' stakes", linkStakes ? () => linkStakes.sweep() : null);
      return json({ ...swept, ...(wagers ? { wagers } : {}), ...(linkSwept ? { link: linkSwept } : {}), ...(stakesSwept ? { linkStakes: stakesSwept } : {}) });
    }
    if (path === "/api/link" || path.startsWith("/api/link/")) {
      if (!link) throw new RelayError("not_found", "Link battles aren't open yet.");
      if (m === "GET" && path === "/api/link/rules") return json(await link.rules(), 200, "public, s-maxage=300");
      if (m === "POST" && path === "/api/link/practice") return json(await link.practice(await fighter(req)));
      if (m === "GET" && path === "/api/link/practice/state") return json(await link.practiceState(await fighter(req), url.searchParams.get("match") ?? undefined));
      if (m === "POST" && path === "/api/link/practice/move") return json(await link.practiceMove(await fighter(req), await body(req)));
      if (m === "POST" && path === "/api/link/practice/leave") return json(await link.practiceLeave(await fighter(req)));
      const watch = /^\/api\/link\/practice\/([a-z2-9]{10})$/.exec(path);
      if (m === "GET" && watch) return json(await link.watchPractice(watch[1]!), 200, "public, s-maxage=2");
      if (path === "/api/link/stake" || path === "/api/link/stakes" || path.startsWith("/api/link/stake/")) {
        if (!linkStakes) throw new RelayError("not_found", "Staking on link battles isn't open.");
        if (m === "GET" && path === "/api/link/stake") return json(linkStakes.info(), 200, "public, s-maxage=60");
        if (m === "GET" && path === "/api/link/stakes") return json({ played: await linkStakes.played() }, 200, "public, s-maxage=10");
        if (m === "POST" && path === "/api/link/stake/join") return json(await linkStakes.join(await fighter(req), await body(req)));
        if (m === "GET" && path === "/api/link/stake/state") return json(await linkStakes.state(await fighter(req)));
        if (m === "GET" && path === "/api/link/stake/results") return json(await linkStakes.results(await fighter(req)));
        const signed = /^\/api\/link\/stake\/result\/([0-9a-f]{64})$/.exec(path);
        if (m === "GET" && signed) {
          const r = await linkStakes.publicResult(signed[1]!);
          if (!r) throw new RelayError("not_found", "That battle has no result to settle with (it isn't over, or it's already closed).");
          return json(r, 200, "public, s-maxage=10");
        }
        if (m === "POST" && path === "/api/link/stake/leave") return json(await linkStakes.leave(await fighter(req)));
        throw new RelayError("not_found", "No such route.");
      }
      if (linkArena) {
        if (m === "POST" && path === "/api/link/join") return json(await linkArena.join(await fighter(req), await body(req)));
        if (m === "GET" && path === "/api/link/state") {
          const after = url.searchParams.get("after");
          return json(await linkArena.state(await fighter(req), { match: url.searchParams.get("match") ?? undefined, after: after === null ? undefined : Number(after), wait: url.searchParams.get("wait") === "1" }));
        }
        if (m === "POST" && path === "/api/link/move") return json(await linkArena.move(await fighter(req), await body(req)));
        if (m === "POST" && path === "/api/link/leave") return json(await linkArena.leave(await fighter(req)));
        if (m === "GET" && path === "/api/link/queue") return json({ waiting: await linkArena.queueSize() }, 200, "public, s-maxage=5");
        if (m === "GET" && path === "/api/link/matches") return json(await linkArena.matches(), 200, "public, s-maxage=5");
        if (m === "GET" && path === "/api/link/leaderboard") return json(await linkArena.leaderboard(), 200, "public, s-maxage=30");
        const one = /^\/api\/link\/match\/([a-z2-9]{10})$/.exec(path);
        if (m === "GET" && one) return json(await linkArena.spectate(one[1]!), 200, "public, s-maxage=2");
      }
      throw new RelayError("not_found", "No such route.");
    }
    if (path.startsWith("/api/arena/admin/")) {
      if (!o.adminToken || bearer(req) !== o.adminToken) throw new RelayError("not_found", "No such route.");
      if (m === "GET" && path === "/api/arena/admin/flags") return json(await referee.flags());
      if (m === "GET" && path === "/api/arena/admin/metrics") return json(await referee.metrics(Number(url.searchParams.get("weeks") ?? 12)));
      if (m === "POST" && path === "/api/arena/admin/metrics/backfill") return json(await referee.backfillMetrics());
      if (m === "POST" && path === "/api/arena/admin/hide") {
        const b = await body(req);
        if (typeof b.match !== "string" || typeof b.round !== "number" || (b.side !== "a" && b.side !== "b")) throw new RelayError("bad_request", "match, round and side.");
        await referee.hideLine(b.match, b.round, b.side);
        return json({ hidden: true });
      }
    }
    throw new RelayError("not_found", "No such route.");
  }

  return {
    referee,
    registration,
    link,
    linkArena,
    linkStakes,
    linkFilmsVisible: (id) => linkFilmsVisible(o.store, id),
    async fetch(req) {
      try {
        return await route(req);
      } catch (err) {
        if (err instanceof RelayError) return json({ error: err.message, code: err.code }, err.status);
        console.error("relay: unexpected error", err);
        return json({ error: "Something went wrong on the relay.", code: "internal" }, 500);
      }
    },
  };
}
