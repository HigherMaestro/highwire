import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRelay, FakeClock, MemoryStore } from "highwire-relay";
import { FakeCoins, FakeRpc, launchTx, memoTx, MINT, WALLET } from "highwire-relay/testing";
import { createHash, randomBytes } from "node:crypto";
import { createLinkEngine } from "../lib/link/engine.ts";

// Link battles' practice end to end, before the site serves it: the real relay (an in-memory store, registration
// through the test fakes) with the real engine (the emulator, the game and the starting battle read from disk instead
// of the Blob store), a whole battle over HTTP, as link_practice plays it. Needs the game, never in CI:
//   HIGHWIRE_LINK_ROM=<the game> npm run link-practice -w highwire-web -- <side 0 state> <side 1 state> [--sample]
// With --sample it also writes lib/link/sample.json, what the pages show without the referee: this battle once it's
// over, and as it stood mid-battle (live). The fighter is the test fakes' invented coin. With --films <dir> every turn is
// filmed after its answer, as on the site, into <dir>/<match>/<turn>.film (with --sample, under the sample's ids too):
// `next dev` with LINK_FILMS_DIR=<dir> plays them on the sample pages. Films are the game's screens: never commit them.

const args = process.argv.slice(2);
const filmsAt = args.indexOf("--films");
const filmsDir = filmsAt >= 0 ? args[filmsAt + 1] : undefined;
const [p0, p1] = args.filter((a, i) => !a.startsWith("--") && i !== filmsAt + 1);
const writeSample = args.includes("--sample");
const rom = process.env.HIGHWIRE_LINK_ROM;
if (!rom || !p0 || !p1) {
  console.error("HIGHWIRE_LINK_ROM=<the game> npm run link-practice -w highwire-web -- <side 0 state> <side 1 state>");
  process.exit(2);
}
const films = {
  put: async (pathname: string, bytes: Uint8Array) => {
    const to = join(filmsDir!, pathname.replace(/^link\/films\//, ""));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, bytes);
  },
  sweep: async () => {},
};
const engine = createLinkEngine(async () => ({ rom: new Uint8Array(readFileSync(rom)), bootstrap: [new Uint8Array(readFileSync(p0)), new Uint8Array(readFileSync(p1))] }), films);
const filming: Promise<unknown>[] = [];
const clock = new FakeClock(Date.now());
const store = new MemoryStore(clock);
const rpc = new FakeRpc();
const relay = createRelay({ store, clock, rpc, coins: new FakeCoins(clock.now()), link: { engine, agentSide: 1, defer: filmsDir ? (t) => filming.push(t()) : undefined } });
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
  if (v.view.phase === "waiting") {
    // Turns the agent isn't asked about took longer than one call: it goes on with no action.
    v = await call("POST", "/api/link/practice/move", { match: v.match, turn: v.turn, action: null }, token);
    continue;
  }
  const legal = v.view.legal as { action: unknown; label: string }[];
  // Mostly the first legal action (a move), now and then another, so the battle has switches in it.
  const pick = legal[moves % 5 === 4 ? legal.length - 1 : 0]!;
  if (moves === 8) midway = await call("GET", `/api/link/practice/${v.match}`);
  v = await call("POST", "/api/link/practice/move", { match: v.match, turn: v.turn, action: pick.action, line: moves === 0 ? "good luck" : "" }, token);
  moves++;
  console.log(`turn ${v.turn}: ${pick.label} -> ${v.view.last_turn.join(" ")}`);
}
console.log(`\nended: ${JSON.stringify(v.ended)} after ${v.turn} turns, ${moves} moves, ${((performance.now() - t1) / moves).toFixed(0)} ms a move`);
const page = await call("GET", `/api/link/practice/${v.match}`);
console.log(`watch page: turn ${page.turn}, ${page.spectator.turns.length} turns told, sides ${page.spectator.sides.map((s: { species: string; hp?: number }) => `${s.species} ${s.hp}`).join(" v ")}; agent-only fields: ${/"legal"|"you"/.test(JSON.stringify(page)) ? "LEAKED" : "none"}`);
if (writeSample) {
  // The fighter is the test fakes' coin: its mint is replaced, so the sample names no real address.
  const live = { ...(midway as Record<string, unknown>), match: "sampleliv2", fighter: "sample-fighter" };
  writeFileSync(new URL("../lib/link/sample.json", import.meta.url), JSON.stringify([{ ...page, match: "samplebat2", fighter: "sample-fighter" }, live], null, 1) + "\n");
  console.log("wrote lib/link/sample.json: /link/practice/samplebat2 (over) and /link/practice/sampleliv2 (live)");
}
console.log(`store keys left: ${Object.keys(store.dump()).filter((k) => k.startsWith("link:state")).length} packed battles; ${store.ops} store operations`);
if (filmsDir) {
  const t2 = performance.now();
  await Promise.all(filming);
  console.log(`filmed ${filming.length} steps into ${filmsDir}/${v.match} (${((performance.now() - t2) / 1000).toFixed(1)} s after the last answer)`);
  if (writeSample) {
    // The sample pages' ids play the same films.
    for (const id of ["samplebat2", "sampleliv2"]) cpSync(join(filmsDir, v.match), join(filmsDir, id), { recursive: true });
  }
}
