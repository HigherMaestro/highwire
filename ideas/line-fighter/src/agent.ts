import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCoin } from "./coin.ts";
import { highwire } from "./highwire.ts";
import { loadSettings, MATCHES, playToday, register, registeredFor, RevealCheckFailed } from "./line.ts";
import { Highwire } from "./tools.ts";

// The fighter's loop. Each wake-up: with no coin yet, it says how to launch one; with one, it registers it on The Line
// (once, and only on a live policy), then plays the day's matches that are left. A reveal that doesn't check out stops
// it for good: it writes matches/STOPPED and plays nothing more until you've looked and deleted that file.

const EVERY_HOURS = Number(process.env.AGENT_EVERY_HOURS ?? 1);
const STOPPED = join(MATCHES, "STOPPED");
const log = (s: string) => console.log(`${new Date().toISOString().slice(0, 19)}Z  ${s}`);

async function once(): Promise<void> {
  const w = await highwire(["wallet", "address"]);
  if (!w.ok) {
    log(`Highwire couldn't find the wallet: ${w.err || "run npm run setup first"}`);
    return;
  }
  log(`Running for ${w.out}.`);
  if (existsSync(STOPPED)) {
    log(`Not playing: ${STOPPED} says why. Delete it to play again.`);
    return;
  }
  const coin = readCoin();
  if (!coin) {
    log("No coin yet. Fill in coin.config.json, put its image in assets/, and run npm run launch (a dry run until the policy is live). Meanwhile, npm run practice plays the house offline.");
    return;
  }
  const settings = loadSettings();
  const hw = await Highwire.connect();
  try {
    log(await register(hw, { mint: coin.mint, launchSignature: coin.signature }, settings));
    if (!registeredFor(coin.mint)) return;
    const played = await playToday(hw, settings, log);
    log(played ? `Played ${played} match${played === 1 ? "" : "es"}; the log is in matches/.` : `Nothing to play: today's ${settings.matches_per_day} are done.`);
  } finally {
    await hw.close();
  }
}

async function main(): Promise<void> {
  const loop = process.argv.includes("--loop");
  do {
    try {
      await once();
    } catch (err) {
      if (err instanceof RevealCheckFailed) {
        writeFileSync(STOPPED, `${new Date().toISOString()}\n${err.message}\n`);
        log(`STOPPED: ${err.message}. Look at the match, tell Highwire if it's the referee's fault, then delete ${STOPPED}.`);
      } else {
        // A refused or paused referee, a network blip: try again next wake-up.
        log(`This wake-up failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (loop) await new Promise((done) => setTimeout(done, EVERY_HOURS * 3_600_000));
  } while (loop);
}

await main();
