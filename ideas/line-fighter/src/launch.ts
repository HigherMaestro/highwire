import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COIN_FILE, CONFIG_FILE, configProblem, launchSignature, readCoin, type Coin, type CoinConfig } from "./coin.ts";
import { highwireJson } from "./highwire.ts";

// `npm run launch`: launches the fighter's coin, once, from the agent's wallet, with what coin.config.json says. It's a
// dry run until the policy is live (it then writes nothing). A live launch writes coin.json, which the loop registers
// on The Line. Running it again never launches a second coin: the same wallet, name and ticker always make the same
// coin, so a retry finishes the first launch instead.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const say = (s: string) => console.log(s);

const existing = readCoin();
if (existing) {
  say(`Already launched: $${existing.ticker} at ${existing.mint}. One coin, one fighter; nothing to do.`);
  process.exit(0);
}

const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as CoinConfig;
const problem = configProblem(config);
if (problem) {
  say(`coin.config.json: ${problem}. Fill it in, then run npm run launch again.`);
  process.exit(1);
}

const args = ["launch", "--name", config.name, "--ticker", config.ticker, "--image", join(ROOT, config.image)];
if (config.description) args.push("--description", config.description);
if (config.buy_sol > 0) args.push("--buy", String(config.buy_sol));
const r = await highwireJson<{
  status?: string;
  mint?: string;
  error?: string;
  next_step?: string;
  transactions?: { signature: string; confirmed: boolean }[];
}>(args);
const b = r.body;
if (!b) {
  say(`The launch didn't run: ${r.err || "no answer from Highwire"}`);
  process.exit(1);
}
if (!r.ok || b.error) {
  say(`Not launched: ${b.error ?? r.err}${b.next_step ? `\n${b.next_step}` : ""}`);
  process.exit(1);
}

const ticker = config.ticker.toUpperCase();
let signature: string | null = null;
if (b.status === "dry_run") {
  say(`Dry run: it would launch $${ticker} at ${b.mint}, and nothing was signed or sent. Set "live": true in the policy to launch for real.`);
  process.exit(0);
} else if (b.status === "sent") {
  signature = b.transactions?.find((t) => t.confirmed)?.signature ?? null;
  if (!signature) {
    say(`The launch of $${ticker} was sent but hasn't confirmed. Run npm run launch again in a minute: it finishes this launch, never a second one.`);
    process.exit(1);
  }
} else if (b.status === "already_launched") {
  signature = launchSignature(b.mint!);
  if (!signature) {
    say(`$${ticker} is already launched at ${b.mint}, but its launch signature isn't in the audit log. Write coin.json by hand: {"mint", "ticker", "signature", "launchedAt"}.`);
    process.exit(1);
  }
} else {
  say(`The launch ended as ${b.status}; nothing was written. ${b.next_step ?? ""}`);
  process.exit(1);
}

const coin: Coin = { mint: b.mint!, ticker, signature, launchedAt: new Date().toISOString() };
writeFileSync(COIN_FILE, JSON.stringify(coin, null, 2) + "\n");
say(`Launched $${ticker}: https://higher.fun/coin/${coin.mint}. Wrote coin.json; the agent registers it on The Line on its next wake-up (npm start).`);
