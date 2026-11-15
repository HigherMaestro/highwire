import { readFileSync, writeFileSync } from "node:fs";
import { createRelay, FakeClock, MemoryStore } from "highwire-relay";
import { FakeCoins, FakeRpc, launchTx, memoTx, MINT, WALLET } from "highwire-relay/testing";
import { createHash, randomBytes } from "node:crypto";
import { createLinkEngine } from "../lib/link/engine.ts";

// Link battles' practice end to end, before the site serves it: the real relay (an in-memory store, registration
// through the test fakes) with the real engine (the emulator, the game and the starting battle read from disk instead
// of the Blob store), a whole battle over HTTP, as link_practice plays it. Needs the game, never in CI:
//   HIGHWIRE_LINK_ROM=<the game> npm run link-practice -w highwire-web -- <side 0 state> <side 1 state> [--sample]
// With --sample it also writes lib/link/sample.json, what the pages show without the referee: this battle once it's
// over, and as it stood mid-battle (live). The fighter is the test fakes' invented coin.

const [p0, p1] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const writeSample = process.argv.includes("--sample");
const rom = process.env.HIGHWIRE_LINK_ROM;
if (!rom || !p0 || !p1) {
  console.error("HIGHWIRE_LINK_ROM=<the game> npm run link-practice -w highwire-web -- <side 0 state> <side 1 state>");
  process.exit(2);
}
const engine = createLinkEngine(async () => ({ rom: new Uint8Array(readFileSync(rom)), bootstrap: [new Uint8Array(readFileSync(p0)), new Uint8Array(readFileSync(p1))] }));
const clock = new FakeClock(Date.now());
const store = new MemoryStore(clock);
const rpc = new FakeRpc();
const relay = createRelay({ store, clock, rpc, coins: new FakeCoins(clock.now()), link: { engine, agentSide: 1 } });
const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const res = await relay.fetch(new Request(`https://relay.test${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return JSON.parse(text);
};

// Register the fakes' coin, as line_register does.
const secret = randomBytes(32).toString("hex");
const ch = await call("POST", "/api/agents/challenge", { wallet: WALLET, mint: MINT, launchSignature: rpc.add(launchTx({ payer: WALLET, mint: MINT })), secretHash: createHash("sha256").update(secret).digest("hex") });
const reg = await call("POST", "/api/agents/register", { code: ch.code, signature: rpc.add(memoTx(WALLET, ch.memo, clock.now() + 5000)), secret });
const token: string = reg.arenaToken;

console.log("rules:", Object.keys(await call("GET", "/api/link/rules")).join(", "));
const t0 = performance.now();
let v = await call("POST", "/api/link/practice", {}, token);
console.log(`started ${v.match} in ${(performance.now() - t0).toFixed(0)} ms; you: ${v.view.you.team.map((m: { species: string }) => m.species).join(", ")}; them: ${v.view.them.species} ${v.view.them.hp_percent}%`);
let moves = 0;
let midway: unknown = null;
const t1 = performance.now();
while (!v.ended) {
  const legal = v.view.legal as { action: unknown; label: string }[];
  // Mostly the first legal action (a move), now and then another, so the battle has switches in it.
  const pick = legal[moves % 5 === 4 ? legal.length - 1 : 0]!;
  if (moves === 8) midway = await call("GET", `/api/link/practice/${v.match}`);
  v = await call("POST", "/api/link/practice/move", { match: v.match, action: pick.action, line: moves === 0 ? "good luck" : "" }, token);
  moves++;
  console.log(`turn ${v.turn}: ${pick.label} -> ${v.view.last_turn.join(" ")}`);
}
console.log(`\nended: ${JSON.stringify(v.ended)} after ${v.turn} turns, ${moves} moves, ${((performance.now() - t1) / moves).toFixed(0)} ms a move`);
const page = await call("GET", `/api/link/practice/${v.match}`);
console.log(`watch page: turn ${page.turn}, ${page.spectator.turns.length} turns told, sides ${page.spectator.sides.map((s: { species: string; hp?: number }) => `${s.species} ${s.hp}`).join(" v ")}; agent-only fields: ${/"legal"|"you"/.test(JSON.stringify(page)) ? "LEAKED" : "none"}`);
if (writeSample) {
  const live = { ...(midway as Record<string, unknown>), match: "sampleliv2" };
  writeFileSync(new URL("../lib/link/sample.json", import.meta.url), JSON.stringify([{ ...page, match: "samplebat2" }, live], null, 1) + "\n");
  console.log("wrote lib/link/sample.json: /link/practice/samplebat2 (over) and /link/practice/sampleliv2 (live)");
}
console.log(`store keys left: ${Object.keys(store.dump()).filter((k) => k.startsWith("link:state")).length} packed battles; ${store.ops} store operations`);
