// npm run arena-sample -w highwire-web: real matches for the arena pages' preview, played by the actual referee
// (highwire-relay, in memory, with a fake clock) and written to lib/arena/sample.json. Sample fighters with invented
// names, playing the house as language-model-like agents would, and a few agent-against-agent matches built with the
// same match functions. Touches no network.

import { writeFileSync } from "node:fs";
import bs58 from "bs58";
import { DUELS_1, houseMove, other, type MatchState, type Side } from "highwire-core/arena";
import { applyMove, createRelay, FakeClock, MemoryStore, newHouseMatch, settle, stateOf, viewMatch, type Match } from "highwire-relay";
import { FakeCoins, FakeRpc, launchTx, memoTx } from "highwire-relay/testing";

let seed = 20261109;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
const address = () => bs58.encode(Uint8Array.from({ length: 32 }, () => Math.floor(rand() * 256)));
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");

type Style = (s: MatchState, side: Side) => number;
const lead = (s: MatchState, side: Side) => (side === "b" ? s.node : -s.node);
const clamp = (s: MatchState, side: Side, n: number) => Math.max(0, Math.min(s.energy[side], Math.round(n)));

const STYLES: Record<string, { play: Style; lines: string[] }> = {
  rounder: {
    play: (s, side) => clamp(s, side, Math.max(5, Math.round((s.energy[side] * (lead(s, side) < 0 ? 0.5 : lead(s, side) > 0 ? 0.2 : 1 / 3) * (0.8 + 0.4 * rand())) / 5) * 5)),
    lines: ["a third, as always", "steady hands", "rounding up today", "patience is a pull too", "", "", "even numbers only"],
  },
  storyteller: {
    play: (s, side) => {
      const r = s.rounds.length;
      if (r === 0) return 10 + Math.floor(rand() * 3);
      if (r >= s.rules.rounds - 2 || lead(s, side) === -2) return s.energy[side];
      return lead(s, side) > 0 ? clamp(s, side, 2 + Math.floor(rand() * 3)) : clamp(s, side, 6 + Math.floor(rand() * 6));
    },
    lines: ["opening big, as promised", "saving for the finale", "every story needs a twist", "all in. obviously.", "", "this is the part where I win", ""],
  },
  chaser: {
    play: (s, side) => {
      const them = s.rounds.map((x) => x.pull[other(side)]);
      const avg = them.length ? them.reduce((a, b) => a + b, 0) / them.length : 7;
      return clamp(s, side, rand() < 0.25 ? 7 : avg + 1 + Math.floor(rand() * 3));
    },
    lines: ["I see your average", "seven is a lucky number", "one more than you, probably", "", "reading you like a ledger", ""],
  },
  mixer: {
    play: (s, side) => clamp(s, side, 2 + Math.floor(rand() * Math.min(12, s.energy[side]))),
    lines: ["dice say", "no pattern here", "guess", "", "", "chaos is a strategy"],
  },
};

const FIGHTERS = [
  { name: "Wire Cat", ticker: "WCAT", style: "rounder" },
  { name: "Moth Lamp", ticker: "MOTH", style: "storyteller" },
  { name: "Quiet Engine", ticker: "QENG", style: "chaser" },
  { name: "Tin Heron", ticker: "HERON", style: "mixer" },
  { name: "Paper Comet", ticker: "COMET", style: "storyteller" },
  { name: "Static Fox", ticker: "SFOX", style: "chaser" },
] as const;

async function main() {
  const clock = new FakeClock(Date.UTC(2026, 10, 9, 14));
  const rpc = new FakeRpc();
  const coins = new FakeCoins(clock.now());
  const store = new MemoryStore(clock);
  const relay = createRelay({ store, clock, rpc, coins });
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await relay.fetch(new Request(`https://relay.local${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }));
    const json = await res.json();
    if (!res.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
    return json as any;
  };
  const sweep = async (ms: number) => {
    for (let left = ms; left > 0; left -= 60_000) {
      clock.advance(Math.min(60_000, left));
      await relay.referee.sweep();
    }
  };

  // Register every fighter, as arena_register would: a launch, a challenge, the memo, the token.
  const roster: { id: string; name: string; ticker: string; style: string; token: string }[] = [];
  for (const f of FIGHTERS) {
    const wallet = address();
    const mint = address();
    coins.coins.set(mint, { name: f.name, ticker: f.ticker, createdAt: clock.now() - (2 + rand() * 20) * 86_400_000, holders: 10 + Math.floor(rand() * 200), volumeSol: 5 + rand() * 80, rugFlag: false, creatorHolds: true, creator: wallet });
    const secret = hex(64);
    const { sha256Hex } = await import("highwire-relay");
    const ch = await call("POST", "/api/agents/challenge", { wallet, mint, launchSignature: rpc.add(launchTx({ payer: wallet, mint })), secretHash: sha256Hex(secret) });
    const reg = await call("POST", "/api/agents/register", { code: ch.code, signature: rpc.add(memoTx(wallet, ch.memo, clock.now() + 3000)), secret, adult: true });
    roster.push({ id: mint, name: f.name, ticker: f.ticker, style: f.style, token: reg.arenaToken });
  }

  // Each fighter plays the house a few times, thinking for a while each round and now and then missing one.
  const houseMatches: string[] = [];
  for (let n = 0; n < 3; n++) {
    for (const f of roster) {
      const style = STYLES[f.style]!;
      let v = await call("POST", "/api/arena/join", { fallback: pick(["zero", "mirror", "steady:2", "steady:3"]), opponent: n % 2 ? "even" : "reader" }, f.token);
      houseMatches.push(v.id);
      while (v.round !== null) {
        if (rand() < 0.06) {
          await sweep(125_000); // away from the keyboard: the fallback plays
        } else {
          clock.advance(4_000 + Math.floor(rand() * 40_000));
          const m = (store.dump()[`arena:match:${v.id}`] as Match)!;
          const s = stateOf(m);
          const line = rand() < 0.45 ? pick(style.lines) : "";
          v = await call("POST", "/api/arena/move", { match: v.id, round: v.round, pull: style.play(s, v.you), nonce: hex(32), line }, f.token);
        }
        v = await call("GET", `/api/arena/state?match=${v.id}`, undefined, f.token);
      }
      clock.advance(60_000 + Math.floor(rand() * 600_000));
    }
  }

  // A few agent-against-agent matches (phase 3), with the referee's own match functions.
  const duelViews = [];
  const pairs: [number, number][] = [[0, 1], [2, 3], [4, 5], [1, 2], [3, 0], [5, 4]];
  for (const [i, j] of pairs) {
    const A = roster[i]!;
    const B = roster[j]!;
    const now = clock.now();
    const m = newHouseMatch({ id: hex(24), rules: DUELS_1, now, fighter: { id: A.id, name: A.name, fallback: { kind: "zero" } }, fighterSide: "a", bot: "even", seed: hex(64) });
    m.sides.b = { ...m.sides.b, kind: "fighter", id: B.id, name: B.name, fallback: { kind: "mirror" } };
    m.house = null;
    m.open!.moves = {};
    let t = now;
    while (m.open && !m.ending) {
      const s = stateOf(m);
      const o = m.open;
      const at = { a: t + 3_000 + Math.floor(rand() * 50_000), b: t + 3_000 + Math.floor(rand() * 50_000) };
      for (const side of (at.a < at.b ? ["a", "b"] : ["b", "a"]) as Side[]) {
        const who = side === "a" ? A : B;
        const style = STYLES[who.style]!;
        if (rand() < 0.04) continue;
        if (!m.open || m.open.round !== o.round) break;
        applyMove(m, side, { round: o.round, pull: style.play(s, side), nonce: hex(32), line: rand() < 0.4 ? pick(style.lines) : "" }, at[side], []);
      }
      t = Math.max(at.a, at.b);
      if (m.open && m.open.round === o.round) {
        t = o.openedAt + 120_000;
        settle(m, t, []);
      } else t = m.open?.openedAt ?? t;
    }
    duelViews.push(viewMatch(m, null, []));
    clock.advance(300_000 + Math.floor(rand() * 900_000));
  }
  void houseMove;

  const matches = [];
  for (const id of houseMatches) matches.push(await relay.referee.spectate(id));
  const all = [...matches, ...duelViews].sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0));
  const board = await relay.referee.leaderboard();
  const out = {
    note: "Sample matches for the arena pages' preview, played by the real referee with invented fighters. Not real coins or agents.",
    generatedAt: new Date(clock.now()).toISOString(),
    fighters: roster.map(({ token: _t, ...f }) => ({ ...f, ...board.fighters.find((x: any) => x.id === f.id) })),
    house: board.house,
    matches: all,
  };
  writeFileSync(new URL("../lib/arena/sample.json", import.meta.url), JSON.stringify(out) + "\n");
  console.log(`${all.length} matches (${matches.length} against the house, ${duelViews.length} between agents), ${roster.length} fighters`);
}

await main();
