import { readFileSync, writeFileSync } from "node:fs";
import { createRelay, FakeClock, MemoryStore } from "highwire-relay";
import { FakeCoins, FakeRpc, launchTx, memoTx, MINT, MINT2, OTHER, WALLET } from "highwire-relay/testing";
import { createHash, randomBytes } from "node:crypto";
import { createLinkEngine } from "../lib/link/engine.ts";

// A rated link battle end to end, before the site serves it (docs/link-battles.md 14.7): the real relay (an in-memory
// store, registration through the test fakes) with the real engine (the emulator, the game and the starting battle read
// from disk), two fighters paired by the queue, each deciding every turn over HTTP as link_move does, and each turn
// resolved after the answer that completes it, as the site's after() would. Needs the game, never in CI:
//   HIGHWIRE_LINK_ROM=<the game> npm run link-rated -w highwire-web -- <side 0 state> <side 1 state> [--sample]
// With --sample it also writes lib/link/sample-rated.json, what the rated pages show without the referee: this battle
// once it's over, as it stood mid-battle (live), and the lobby and ladder they make. The fighters are the test fakes'
// invented coins, their mints replaced so the sample names no real address.

const [p0, p1] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const writeSample = process.argv.includes("--sample");
let midway: Record<string, any> | null = null;
const rom = process.env.HIGHWIRE_LINK_ROM;
if (!rom || !p0 || !p1) {
  console.error("HIGHWIRE_LINK_ROM=<the game> npm run link-rated -w highwire-web -- <side 0 state> <side 1 state>");
  process.exit(2);
}
const films = { put: async () => {}, sweep: async () => {} };
const engine = createLinkEngine(async () => ({ rom: new Uint8Array(readFileSync(rom)), bootstrap: [new Uint8Array(readFileSync(p0)), new Uint8Array(readFileSync(p1))] }), films);
const clock = new FakeClock(Date.now());
const store = new MemoryStore(clock);
const rpc = new FakeRpc();
const tasks: (() => Promise<unknown>)[] = [];
const relay = createRelay({ store, clock, rpc, coins: new FakeCoins(clock.now()), link: { engine, agentSide: 1, rated: true, defer: (t) => tasks.push(t) } });
let resolveMs = 0;
const flush = async () => {
  while (tasks.length) {
    const t0 = performance.now();
    await tasks.shift()!();
    resolveMs += performance.now() - t0;
  }
};
const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const res = await relay.fetch(new Request(`https://relay.test${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return JSON.parse(text);
};
const register = async (mint: string, wallet: string) => {
  const secret = randomBytes(32).toString("hex");
  const ch = await call("POST", "/api/agents/challenge", { wallet, mint, launchSignature: rpc.add(launchTx({ payer: wallet, mint })), secretHash: createHash("sha256").update(secret).digest("hex") });
  const reg = await call("POST", "/api/agents/register", { code: ch.code, signature: rpc.add(memoTx(wallet, ch.memo, clock.now() + 5000)), secret });
  return reg.arenaToken as string;
};

const tokens = [await register(MINT, WALLET), await register(MINT2, OTHER)];
await call("POST", "/api/link/join", { fallback: "first", wait: false }, tokens[0]);
const t0 = performance.now();
const paired = await call("POST", "/api/link/join", { fallback: "strongest", wait: false }, tokens[1]);
await flush();
const match = paired.match as string;
console.log(`paired into ${match} in ${(performance.now() - t0).toFixed(0)} ms (rated: ${paired.rated})`);

let decisions = 0;
for (let round = 0; round < 200; round++) {
  const views = [await call("GET", `/api/link/state?match=${match}`, undefined, tokens[0]), await call("GET", `/api/link/state?match=${match}`, undefined, tokens[1])];
  if (views[0].status === "ended") break;
  const before = await call("GET", `/api/link/match/${match}`);
  for (const i of [0, 1]) {
    const v = views[i];
    if (v.status !== "your_decision") continue;
    const legal = v.view.legal as { action: unknown; label: string }[];
    // Mostly the first move; now and then the last legal action, so there are switches.
    const pick = legal[(decisions + i) % 6 === 5 ? legal.length - 1 : 0]!;
    await call("POST", "/api/link/move", { match, turn: v.turn, action: pick.action, line: decisions < 2 ? `good luck from ${i}` : "" }, tokens[i]);
    decisions++;
    // Nothing about a decision shows before its turn resolves: not to spectators.
    const mid = await call("GET", `/api/link/match/${match}`);
    if (JSON.stringify(mid) !== JSON.stringify(before) && i === 0 && views[1].status === "your_decision") throw new Error("the public view changed when one side decided");
  }
  await flush();
  const after = await call("GET", `/api/link/match/${match}`);
  if (!midway && after.turn >= 10 && after.live) midway = after;
  const told = (after.spectator?.turns ?? []).filter((t: { turn: number }) => t.turn > before.turn).flatMap((t: { lines: string[] }) => t.lines);
  console.log(`turn ${after.turn}: ${told.join(" ")}`);
}
const end = await call("GET", `/api/link/match/${match}`);
const ladder = await call("GET", "/api/link/leaderboard");
console.log(`\nended: ${JSON.stringify(end.ended)} after ${end.turn} turns, ${decisions} decisions; resolving took ${(resolveMs / Math.max(1, end.turn)).toFixed(0)} ms a turn`);
console.log(`ratings: ${ladder.fighters.map((f: { name: string; rating: number; record: { rated: unknown } }) => `${f.name} ${f.rating} ${JSON.stringify(f.record.rated)}`).join("; ")}`);
console.log(`lines on the page: ${JSON.stringify(end.lines)}`);
if (writeSample) {
  // The sample names no real address: the fakes' mints become placeholders.
  const scrub = (o: unknown, id: string) => JSON.parse(JSON.stringify(o).replaceAll(MINT, "sample-fighter-a").replaceAll(MINT2, "sample-fighter-b").replaceAll(match, id));
  const over = scrub(end, "samplerat2");
  const live = scrub(midway, "sampleliv3");
  const card = (m: Record<string, any>) => ({ match: m.match, rated: m.rated, house: m.house, sides: m.sides, turn: m.turn, live: m.live, ended: m.ended, started_at: m.started_at });
  const lobby = { live: [card(live)], recent: [card(over)], ladder: scrub(ladder, "samplerat2") };
  writeFileSync(new URL("../lib/link/sample-rated.json", import.meta.url), JSON.stringify({ matches: [over, live], lobby }, null, 1) + "\n");
  console.log("wrote lib/link/sample-rated.json: /link/match/samplerat2 (over), /link/match/sampleliv3 (live), and /link's lobby");
}
console.log(`store keys left: ${Object.keys(store.dump()).filter((k) => k.startsWith("link:mstate")).length} packed battles; ${store.ops} store operations`);
