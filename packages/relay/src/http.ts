import { arenaGuide } from "highwire-core/arena";
import type { Clock } from "./clock.ts";
import { RelayError } from "./errors.ts";
import { Referee, type CoinDirectory, type RefereeConfig } from "./arena/referee.ts";
import { Registration, type RegistrationRpc } from "./registration.ts";
import type { Store } from "./store.ts";

// The relay's routes, as one fetch handler (Request in, Response out), so any host can mount it: the relay's own
// Vercel project in production, an in-process call in tests and in the local server's end-to-end check.
//
//   POST /api/agents/challenge     { wallet, mint, launchSignature, secretHash }
//   POST /api/agents/register      { code, signature, secret, adult: true }  -> { arenaToken, fighter }
//   GET  /api/arena/rules
//   POST /api/arena/join           { fallback, opponent? }                    (arena token)
//   GET  /api/arena/state?match=&after=&wait=1                                (arena token)
//   POST /api/arena/move           { match, round, pull, nonce, line }       (arena token)
//   POST /api/arena/retire                                                    (arena token)
//   GET  /api/arena/match/<id>     a spectator's view, cached 2 seconds
//   GET  /api/arena/fighter/<mint>
//   GET  /api/arena/leaderboard
//   POST /api/arena/report         { match, round, side, why? }              a spectator reports a line of table talk
//   GET  /api/arena/sweep          the cron: with CRON_SECRET set it needs the secret, otherwise once per 30 seconds
//   GET  /api/arena/admin/reports, POST /api/arena/admin/hide { match, round, side }   (LINE_ADMIN_TOKEN; off without it)

export interface RelayOptions {
  store: Store;
  clock: Clock;
  rpc: RegistrationRpc;
  coins: CoinDirectory;
  /** The cron's bearer secret. Without it anyone may call the sweep, but it runs at most once every 30 seconds. */
  cronSecret?: string;
  /** The moderator's bearer token for the admin routes; without it they don't exist. */
  adminToken?: string;
  /** Who's calling, for the per-caller limit on registration and reports (an IP, from the host). */
  clientKey?: (req: Request) => string | null;
  referee?: RefereeConfig;
}

export interface Relay {
  fetch(req: Request): Promise<Response>;
  referee: Referee;
  registration: Registration;
}

const json = (body: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": cache } });

export function createRelay(o: RelayOptions): Relay {
  const referee = new Referee(o.store, o.clock, o.coins, o.referee);
  const registration = new Registration(o.store, o.rpc, () => o.clock.now());

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
      const { token, fighter: f } = await referee.enroll(v, b.adult);
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
      return json(await referee.sweep());
    }
    if (m === "POST" && path === "/api/arena/report") {
      await limitCaller(req, "report", 10);
      return json(await referee.report(await body(req)));
    }
    if (path.startsWith("/api/arena/admin/")) {
      if (!o.adminToken || bearer(req) !== o.adminToken) throw new RelayError("not_found", "No such route.");
      if (m === "GET" && path === "/api/arena/admin/reports") return json(await referee.reports());
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
