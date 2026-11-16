import { PublicKey } from "@solana/web3.js";
import { GENESIS_HASHES } from "highwire-agent";
import { Chain, solToLamports } from "highwire-core";
import type { LinkStakeConfig } from "highwire-relay";
import { linkBattleOutcome, readLinkConfig } from "highwire-wager/chain";

// The settings that turn on link battles' practice-stake desk (docs/link-wager.md 4.2), read apart from the relay so
// they can be tested: what's set, what's missing, and what's malformed each have one answer, and none of them takes
// anything else down.

type Env = Record<string, string | undefined>;

/**
 * A desk's settings, or undefined (the desk off) if reading them throws. Logs why, without a value: a setting can be a
 * secret.
 */
export function settingOrOff<T>(what: string, read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch (err) {
    console.error(`line: ${what} are off: a setting couldn't be read (${err instanceof Error ? err.name : "error"})`);
    return undefined;
  }
}

/**
 * Practice stakes on link battles: devnet only, whatever The Line's desk is on. On only with rated link battles, a
 * program listed for devnet, and both keys in the site's environment, each a 32-byte Ed25519 secret in hex:
 * LINK_STAKE_TICKET_KEY signs pairings, LINK_STAKE_RESULT_KEY signs results. They are different keys, neither moves
 * money, and neither may ever reach a response, a log or the repository. LINK_STAKE_TICKET_KEY_ID and
 * LINK_STAKE_RESULT_KEY_ID are the ids the program's config holds for them (default 1); LINK_STAKE_TIERS the tiers in
 * devnet SOL (default 0.1 and 0.25); LINK_STAKE_MIN_QUEUE and LINK_STAKE_PER_PAIR_WEEK the pairing rules (default 2
 * and 2); LINK_STAKE_RPC_URL a devnet RPC (the public one throttles reads).
 *
 * Values are trimmed (a pasted key often ends in a newline). A key that's set and isn't 64 hex characters turns the
 * desk off and says so, never what it was. Throws on a tier that isn't an amount or an RPC URL that isn't one: the
 * caller (`settingOrOff`) turns that into "off".
 */
export function linkStakeConfig(source: Env, programId: string | null, rated: boolean): LinkStakeConfig | undefined {
  const env = (name: string) => source[`LINK_STAKE_${name}`]?.trim() || undefined;
  const [ticket, result] = [env("TICKET_KEY"), env("RESULT_KEY")];
  if (!programId || !rated || (!ticket && !result)) return undefined;
  const hex = (k: string | undefined): k is string => !!k && /^[0-9a-f]{64}$/i.test(k);
  if (!hex(ticket) || !hex(result)) {
    console.error(`line: link battles' stakes are off: ${!ticket || !result ? "one of the two keys isn't set" : "a key isn't 64 hex characters"}`);
    return undefined;
  }
  const stakes = { chain: new Chain({ cluster: "devnet", rpcUrl: env("RPC_URL") }), program: new PublicKey(programId) };
  // As for The Line's desk: an RPC on another cluster would answer "no such battle" for every live one. On a mismatch
  // every read fails, and a desk that can't read the program's config pairs nobody.
  let genesis: Promise<void> | null = null;
  const onDevnet = () =>
    (genesis ??= stakes.chain.connection.getGenesisHash().then((g) => {
      if (g !== GENESIS_HASHES.devnet) {
        console.error("link: the stake RPC isn't on devnet: nothing is paired and staked battles aren't read until it is");
        throw new Error("the stake RPC isn't on devnet");
      }
    })).catch((err: unknown) => {
      genesis = null;
      throw err;
    });
  const whole = (name: string, fallback: number) => Math.max(1, Math.floor(Number(env(name) ?? fallback)) || fallback);
  return {
    programId,
    ticketSecret: Uint8Array.from(Buffer.from(ticket, "hex")),
    ticketKeyId: Number(env("TICKET_KEY_ID") ?? 1),
    resultSecret: Uint8Array.from(Buffer.from(result, "hex")),
    resultKeyId: Number(env("RESULT_KEY_ID") ?? 1),
    tiers: (env("TIERS") ?? "0.1,0.25").split(",").map((t) => solToLamports(Number(t.trim()))),
    minQueue: Math.max(2, whole("MIN_QUEUE", 2)),
    perPairPerWeek: whole("PER_PAIR_WEEK", 2),
    chain: {
      status: async (id) => {
        await onDevnet();
        return linkBattleOutcome(stakes, id);
      },
      // With the keys and tiers, so the desk can tell it's the program it was set up for before it signs anything.
      config: async () => {
        await onDevnet();
        const c = await readLinkConfig(stakes);
        return { paused: c.paused, ticketKeyId: c.ticketKeyId, resultKeyId: c.resultKeyId, ticketKey: c.ticketKey, resultKey: c.resultKey, tiers: c.tiers };
      },
    },
  };
}
