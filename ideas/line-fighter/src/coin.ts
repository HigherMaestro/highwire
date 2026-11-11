import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME } from "./highwire.ts";

// The fighter's coin: what it's launched as (coin.config.json, yours to fill in) and what the launch made (coin.json,
// written by `npm run launch`). One coin, one fighter.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const COIN_FILE = join(ROOT, "coin.json");
export const CONFIG_FILE = join(ROOT, "coin.config.json");

export interface CoinConfig {
  name: string;
  ticker: string;
  /** The image, relative to the project: PNG, JPEG, GIF or WebP, at most 4 MB. */
  image: string;
  description: string;
  /** SOL for the creator's first buy. Keep some: a coin whose creator holds none plays, but is never ranked. */
  buy_sol: number;
}

export interface Coin {
  mint: string;
  ticker: string;
  /** The launch transaction's signature: line_register checks it. */
  signature: string;
  launchedAt: string;
}

/** The launched coin, or null before `npm run launch` has launched one. */
export function readCoin(file = COIN_FILE): Coin | null {
  if (!existsSync(file)) return null;
  const c = JSON.parse(readFileSync(file, "utf8")) as Partial<Coin>;
  if (!c.mint || !c.signature) throw new Error(`${file} needs the coin's mint and its launch signature`);
  return c as Coin;
}

/** What's wrong with coin.config.json, or null. */
export function configProblem(c: Partial<CoinConfig>, root = ROOT): string | null {
  if (typeof c.name !== "string" || !c.name.trim() || c.name.length > 32) return "name: up to 32 characters";
  if (typeof c.ticker !== "string" || !/^[A-Za-z0-9]{1,10}$/.test(c.ticker)) return "ticker: 1 to 10 letters or digits, without the $";
  if (typeof c.image !== "string" || !existsSync(join(root, c.image))) return `image: ${c.image ?? "(none)"} isn't there; put the coin's picture in assets/`;
  if (c.description !== undefined && (typeof c.description !== "string" || c.description.length > 500)) return "description: up to 500 characters";
  if (typeof c.buy_sol !== "number" || !(c.buy_sol >= 0)) return "buy_sol: SOL for the first buy, 0 or more";
  return null;
}

/**
 * A launch's signature from the audit log, for a coin whose launch was sent but whose coin.json wasn't written (a
 * retry of `npm run launch` then finds it already launched). The latest confirmed one wins.
 */
export function launchSignature(mint: string, home = HOME): string | null {
  const log = join(home, "audit.jsonl");
  if (!existsSync(log)) return null;
  let found: string | null = null;
  for (const line of readFileSync(log, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { tool?: string; mint?: string; outcome?: string; signature?: string };
      if (e.tool === "execute_launch" && e.mint === mint && e.outcome === "confirmed" && e.signature) found = e.signature;
    } catch {
      // A line cut short by a crash: skip it.
    }
  }
  return found;
}
