// A scripted practice stake on a link battle, on devnet (docs/link-wager.md 4.2, steps 7 and 8): two fighters, each
// through its own MCP server, local signer, devnet home and policy, stake on one battle, play it and settle, start to
// finish, using only the tools an agent uses (link_stake, link_state, link_move, link_settle, link_wagers). At the end
// it checks the result four ways: the program's closing event, the referee's practice record, the public list, and
// both wallets' balances.
//
// It signs and sends real devnet transactions from both wallets, inside their devnet policies. Run by the maintainer;
// it never prints a key, a ticket or a signature.
//
//   npm run link-stake-pair -w highwire-wager -- --a ~/.highwire-lgtm-devnet:~/.highwire/buyback-coin/wallet.json \
//     --b ~/.highwire-mc-devnet:~/.highwire/second-fighter/wallet.json [--stake 0.1] [--case knockout|walkaway|void]
//
// Each side is HIGHWIRE_HOME:keypair file. SOLANA_RPC_URL sets the devnet RPC (default devnet's public one).
//
// The three cases are the acceptance run's:
//   knockout   both play (a random legal action each turn) until the game ends it; the winner settles with
//              link_settle, once the battle's ticket has run out.
//   walkaway   side b stops answering after two turns, as an agent that was killed would: it forfeits after two
//              silent minutes, and nothing here settles. A daemon must (`highwire-wager run` for side a, at least).
//   void       neither side answers: after two silent minutes the referee voids the battle, and side a's link_settle
//              refunds both.
// A side that went silent may not stake again for five minutes (the referee's cooldown), so leave that long between a
// walkaway or a void and the next run.
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { agentPaths, loadKeypair, loadPolicy } from "highwire-agent";
import { Chain, DEFAULT_RPC_URLS } from "highwire-core";
import { createDeps, createServer } from "highwire-mcp";
import { linkWagerProgram } from "../src/link-codec.ts";
import { linkBattleOutcome, readLinkBattle, readLinkConfig, type LinkStakes } from "../src/link-tx.ts";
import { wagerSigner } from "../src/signing.ts";
import { registerWagerTools } from "../src/tools.ts";

export type PairCase = "knockout" | "walkaway" | "void";

export interface PairPlayer {
  name: string;
  wallet: string;
  /** Calls one of the fighter's tools; a refusal comes back as `{ error: { error, code } }`. */
  call: (tool: string, args?: Record<string, unknown>) => Promise<any>;
}

export interface PairOptions {
  a: PairPlayer;
  b: PairPlayer;
  /** SOL a side: one of the tiers. */
  stakeSol: number;
  mode: PairCase;
  /** The chain and the program, for reading the battle and how it closed. */
  stakes: LinkStakes;
  /** A wallet's balance, in lamports. */
  balance: (wallet: string) => Promise<number>;
  /** The referee's public answers: a battle's spectators' view, and the list of staked battles played. Read only. */
  watch: (match: string) => Promise<{ live: boolean; ended: { reason: string } | null; turn: number } | null>;
  played: () => Promise<{ match: string; outcome: string | null }[]>;
  log: (who: string, line: string) => void;
  /** Side b stops answering once this many turns have been played (walkaway). Default 2. */
  walkAfterTurns?: number;
  /** How long to wait for a daemon to settle, in ms (walkaway). Default 12 minutes. */
  daemonWaitMs?: number;
  /** Between polls, in ms. Default 3 seconds. */
  pauseMs?: number;
}

export interface PairResult {
  ok: boolean;
  checks: { what: string; ok: boolean; detail: string }[];
  battle: string;
  match: string;
}

const SOL = 1_000_000_000;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const said = (r: any) => (r?.error ? `${r.error.error} (${r.error.code})` : JSON.stringify(r).slice(0, 240));

/** Plays one staked battle between two fighters through their own tools, and checks how it came out. */
export async function runPair(o: PairOptions): Promise<PairResult> {
  const { a, b, log } = o;
  const both = [a, b];
  const pause = o.pauseMs ?? 3_000;
  const checks: PairResult["checks"] = [];
  const check = (what: string, ok: boolean, detail = "") => {
    checks.push({ what, ok, detail });
    log("check", `${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  };

  // ---------------------------------------------------------------- before
  const wagersBefore = await Promise.all(both.map((p) => p.call("link_wagers")));
  for (const [i, w] of wagersBefore.entries()) {
    if (w.error) throw new Error(`${both[i]!.name}: link_wagers: ${said(w)}`);
    if (w.on_chain?.length) throw new Error(`${both[i]!.name} still has a stake on-chain (${w.on_chain[0].battle.slice(0, 8)}: ${w.on_chain[0].due}). Settle it first: link_settle, or wait for its daemon.`);
    if (!w.tiers_sol?.includes(o.stakeSol)) throw new Error(`${o.stakeSol} SOL isn't one of the tiers (${w.tiers_sol?.join(", ")})`);
  }
  const record = (w: any) => ({ win: Number(w.you?.record?.win) || 0, draw: Number(w.you?.record?.draw) || 0, loss: Number(w.you?.record?.loss) || 0 });
  const recordsBefore = wagersBefore.map(record);
  const balancesBefore = await Promise.all(both.map((p) => o.balance(p.wallet)));
  const openBefore = (await readLinkConfig(o.stakes)).openStake;

  // ---------------------------------------------------------------- staking
  let battle = "";
  let match = "";
  const role = new Map<string, string>();
  const staking = Date.now();
  while (!match) {
    if (Date.now() - staking > 20 * 60_000) throw new Error("the two fighters weren't paired and staked within twenty minutes");
    const answers = await Promise.all(both.map((p) => p.call("link_stake", { stake: o.stakeSol, fallback: "first", confirm: true })));
    for (const [i, r] of answers.entries()) {
      const p = both[i]!;
      if (r.error) throw new Error(`${p.name}: link_stake: ${said(r)}`);
      if (r.waiting) {
        log(p.name, `waiting to be paired (${r.waiting_at_this_tier} at this tier, ${r.waited_seconds}s)`);
        continue;
      }
      if (r.battle) battle = r.battle;
      if (r.you && role.get(p.name) !== r.you) {
        role.set(p.name, r.you);
        log(p.name, `paired as ${r.you} in battle ${String(r.battle).slice(0, 8)}`);
      }
      if (r.staked && typeof r.staked === "object") {
        log(p.name, `staked ${r.stake_sol} SOL: ${r.staked.status}${r.staked.confirmed ? ", confirmed" : ""}`);
        if (r.staked.status === "dry_run") throw new Error(`${p.name}'s policy is a dry run ("live": false): nothing was staked`);
        if (r.staked.status !== "sent" || !r.staked.confirmed) log(p.name, `the stake isn't known to have landed: ${said(r.staked)}`);
      }
      if (typeof r.match === "string") match = r.match;
    }
    if (!match) await sleep(pause);
  }
  log("pair", `battle ${battle.slice(0, 8)} is on: match ${match}`);
  const onChain = await readLinkBattle(o.stakes, battle);
  const sideA = both.find((p) => role.get(p.name) === "A");
  const sideB = both.find((p) => role.get(p.name) === "B");
  check("both stakes are in the program's battle account", onChain?.status === "live" && Number(onChain.stake) === Math.round(o.stakeSol * SOL) && onChain.playerA === sideA?.wallet && onChain.playerB === sideB?.wallet, onChain ? `${onChain.status}, ${Number(onChain.stake) / SOL} SOL a side` : "no account");

  // ---------------------------------------------------------------- the battle
  /** Plays one side until the battle ends, or (with `until`) until that many turns are played; then it goes quiet. */
  const play = async (p: PairPlayer, until?: number): Promise<any> => {
    let seen = -1;
    for (;;) {
      const v = await p.call("link_state", { wait: true });
      if (v.error) {
        log(p.name, `link_state: ${said(v)}`);
        await sleep(pause);
        continue;
      }
      if (v.status === "ended") return v;
      if (until !== undefined && v.turn >= until) {
        log(p.name, `stops answering after ${v.turn} turns`);
        return null;
      }
      if (v.turn !== seen) {
        seen = v.turn;
        if (v.turn % 5 === 0) log(p.name, `turn ${v.turn}`);
      }
      if (v.status !== "your_decision") continue;
      const legal: { action: { kind: string }; label?: string }[] = v.view?.legal ?? [];
      if (!legal.length) continue;
      // A random legal action, an attack when there is one: a battle between two of these ends in a knockout.
      const attacks = legal.filter((l) => l.action.kind !== "switch");
      const from = attacks.length ? attacks : legal;
      const pick = from[Math.floor(Math.random() * from.length)]!;
      const m = await p.call("link_move", { action: pick.action, turn: v.turn });
      if (m.error) {
        log(p.name, `link_move: ${said(m)}`);
        await sleep(pause);
      }
    }
  };
  /** The public view, until the battle is over: no agent's call, so nobody is counted as being there. */
  const watchUntilOver = async (ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const v = await o.watch(match).catch(() => null);
      if (v && !v.live) return v;
      await sleep(Math.max(pause, 5_000));
    }
    return null;
  };

  let end: any = null;
  let expected: "decided" | "void";
  let winner: PairPlayer | null = null;
  if (o.mode === "void") {
    log("pair", "neither side answers: the referee voids the battle after two silent minutes");
    const over = await watchUntilOver(6 * 60_000);
    check("with both sides silent the battle was voided", over?.ended?.reason === "void", JSON.stringify(over?.ended ?? null));
    expected = "void";
  } else {
    const [ea, eb] = await Promise.all([play(a), play(b, o.mode === "walkaway" ? (o.walkAfterTurns ?? 2) : undefined)]);
    end = ea ?? eb;
    const result = String(ea?.ended?.result ?? "");
    if (o.mode === "walkaway") {
      check("the side that stopped answering forfeited", ea?.ended?.reason === "forfeit" && result === "won", JSON.stringify(ea?.ended ?? null));
      winner = a;
      expected = "decided";
    } else {
      const agree = (ea?.ended?.result === "won") !== (eb?.ended?.result === "won") || (ea?.ended?.result === "draw" && eb?.ended?.result === "draw") || (ea?.ended?.reason === "void" && eb?.ended?.reason === "void");
      check("both sides read the same ending", Boolean(agree), `a: ${ea?.ended?.reason}/${ea?.ended?.result}, b: ${eb?.ended?.reason}/${eb?.ended?.result}`);
      winner = ea?.ended?.result === "won" ? a : eb?.ended?.result === "won" ? b : null;
      expected = winner ? "decided" : "void";
      log("pair", `the battle ended after ${ea?.turn} turns: ${ea?.ended?.reason}${winner ? `, ${winner.name} won` : ""}`);
    }
  }
  void end;

  // ---------------------------------------------------------------- settling
  if (o.mode === "walkaway") {
    log("pair", "no tool settles: waiting for a daemon (`highwire-wager run`) to send the referee's result");
  } else {
    // Nothing closes a battle before its ticket has run out (five minutes after pairing): keep asking until it's due.
    const settler = winner ?? a;
    const until = Date.now() + 10 * 60_000;
    let waited = false;
    for (;;) {
      const s = await settler.call("link_settle", { confirm: true });
      if (s.error) throw new Error(`${settler.name}: link_settle: ${said(s)}`);
      const row = s.settled?.[0];
      if (!row) {
        log(settler.name, "nothing of its is on-chain any more (a daemon, or the other side, settled first)");
        break;
      }
      if (row.did === "nothing yet") {
        if (!waited) log(settler.name, `not yet: ${row.why}`);
        waited = true;
        if (Date.now() > until) break;
        await sleep(10_000);
        continue;
      }
      log(settler.name, `link_settle: ${row.did}${row.referee_result ? ` (${row.referee_result})` : ""}${row.error ? `: ${row.error}` : ""}`);
      if (row.error || row.note) {
        if (Date.now() > until) break;
        await sleep(10_000);
        continue;
      }
      break;
    }
  }
  let how = "still open";
  const closeBy = Date.now() + (o.mode === "walkaway" ? (o.daemonWaitMs ?? 12 * 60_000) : 2 * 60_000);
  while (Date.now() < closeBy) {
    const st = await linkBattleOutcome(o.stakes, battle).catch(() => null);
    if (st?.state === "closed") {
      how = st.how;
      break;
    }
    await sleep(Math.max(pause, 5_000));
  }
  check(o.mode === "walkaway" ? "a daemon settled it, with no tool call" : "the program's closing event says settled", how === "settled", how);

  // ---------------------------------------------------------------- after
  await sleep(pause);
  const balancesAfter = await Promise.all(both.map((p) => o.balance(p.wallet)));
  const delta = (p: PairPlayer) => balancesAfter[both.indexOf(p)]! - balancesBefore[both.indexOf(p)]!;
  // Fees, and nothing else, beside the stake: well under a hundredth of a SOL.
  const near = (got: number, want: number) => Math.abs(got - want) < 0.005 * SOL;
  const stake = Math.round(o.stakeSol * SOL);
  if (expected === "decided" && winner) {
    const loser = both.find((p) => p !== winner)!;
    check("the winner is up one stake and the loser down one (less fees)", near(delta(winner), stake) && near(delta(loser), -stake), `${winner.name} ${delta(winner) / SOL}, ${loser.name} ${delta(loser) / SOL}`);
  } else {
    check("both wallets are back where they were (less fees)", both.every((p) => near(delta(p), 0)), both.map((p) => `${p.name} ${delta(p) / SOL}`).join(", "));
  }
  // The referee's own books: its practice record (asked a few times: it closes a stake when it next looks at the chain).
  let wagersAfter: any[] = [];
  for (let i = 0; i < 10; i++) {
    wagersAfter = await Promise.all(both.map((p) => p.call("link_wagers")));
    if (wagersAfter.every((w) => !w.error && !w.paired && !w.on_chain?.length)) break;
    await sleep(Math.max(pause, 5_000));
  }
  const gained = (i: number) => {
    const [x, y] = [recordsBefore[i]!, record(wagersAfter[i])];
    return { win: y.win - x.win, draw: y.draw - x.draw, loss: y.loss - x.loss };
  };
  if (expected === "decided" && winner) {
    const [wi, li] = [both.indexOf(winner), both.indexOf(both.find((p) => p !== winner)!)];
    check("the referee's practice record shows the win and the loss", gained(wi).win === 1 && gained(li).loss === 1, `${JSON.stringify(gained(wi))} ${JSON.stringify(gained(li))}`);
  } else {
    const all = [gained(0), gained(1)];
    check("a battle with no winner counts no win and no loss", all.every((g) => g.win === 0 && g.loss === 0), JSON.stringify(all));
  }
  check("neither wallet has anything left staked", wagersAfter.every((w) => !w.error && !w.on_chain?.length), wagersAfter.map((w) => (w.error ? said(w) : `${w.on_chain?.length ?? 0} on-chain`)).join(", "));
  check("the program's open-stake counter is back where it was", (await readLinkConfig(o.stakes)).openStake === openBefore, `${Number((await readLinkConfig(o.stakes)).openStake) / SOL} SOL open`);
  const listed = (await o.played().catch(() => [])).find((x) => x.match === match);
  check("the practice page lists the battle", Boolean(listed), listed ? `outcome ${listed.outcome}` : "not listed");
  return { ok: checks.every((c) => c.ok), checks, battle, match };
}

// ---------------------------------------------------------------- the command

async function main() {
  const { values } = parseArgs({ options: { a: { type: "string" }, b: { type: "string" }, stake: { type: "string" }, case: { type: "string" } } });
  const mode = (values.case ?? "knockout") as PairCase;
  if (!["knockout", "walkaway", "void"].includes(mode)) throw new Error("--case is knockout, walkaway or void");
  const stakeSol = Number(values.stake ?? "0.1");
  const expand = (p: string) => p.replace(/^~(?=\/)/, homedir());
  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URLS.devnet;
  const program = linkWagerProgram("devnet");
  if (!program) throw new Error("the codec lists no devnet program for link battles' stakes");
  const t0 = Date.now();
  const log = (who: string, line: string) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s  ${who.padEnd(14)} ${line}`);

  const player = async (spec: string | undefined, label: string): Promise<PairPlayer> => {
    if (!spec || !spec.includes(":")) throw new Error(`--${label} is HIGHWIRE_HOME:keypair file`);
    const [home, key] = spec.split(":").map(expand) as [string, string];
    const { keypair, warning } = loadKeypair(key);
    if (warning) console.error(`warning (${label}): ${warning}`);
    const paths = agentPaths({ HIGHWIRE_HOME: home });
    // The policy is the owner's, and only read here: checked before anyone is paired, since a stake the signer would
    // refuse holds the other fighter on a ticket nobody can use until it runs out.
    const policy = loadPolicy(paths.policy);
    const need = `"cluster": "devnet", "live": true, "wager" in "actions", and "wagers": { "max_stake_sol": ${stakeSol}, "max_open": 1, "tiers": [${stakeSol}] } (other tiers may stay)`;
    const short = policy.cluster !== "devnet" ? "isn't for devnet" : !policy.live ? 'is a dry run ("live": false)' : !policy.actions.includes("wager") ? 'doesn\'t have "wager" in its actions' : !policy.wagers ? "has no wagers section" : !policy.wagers.tiers.includes(stakeSol) || policy.wagers.max_stake_sol < stakeSol ? `doesn't allow a ${stakeSol} SOL stake` : policy.max_sol_per_tx < stakeSol + 0.01 ? `allows less than ${stakeSol + 0.01} SOL a transaction` : null;
    if (short) throw new Error(`--${label}: the policy at ${paths.policy} ${short}. It needs ${need}. The policy is yours to edit.`);
    const signer = wagerSigner(keypair, paths);
    const server = createServer({ cluster: "devnet", rpcUrl, signer, arena: true, link: true, wagers: registerWagerTools });
    const client = new Client({ name: `link-stake-pair-${label}`, version: "0" });
    const [x, y] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(x), client.connect(y)]);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    if (!tools.includes("link_stake")) throw new Error("this checkout's server has no link_stake: is the program's address in the codec?");
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await client.callTool({ name, arguments: args });
      const body = JSON.parse((res.content as { text: string }[])[0]!.text);
      return res.isError ? { error: body } : body;
    };
    return { name: `${label} ${signer.wallet.slice(0, 4)}`, wallet: signer.wallet, call };
  };
  const a = await player(values.a, "a");
  const b = await player(values.b, "b");
  const connection = new Connection(rpcUrl, "confirmed");
  // Each wallet needs its stake, the battle account's rent (the opener's, back at the close) and fees.
  for (const p of [a, b]) {
    const have = await connection.getBalance(new PublicKey(p.wallet));
    if (have < (stakeSol + 0.01) * SOL) {
      throw new Error(`${p.name} (${p.wallet}) has ${have / SOL} devnet SOL and needs about ${stakeSol + 0.01}. Fund it: solana transfer ${p.wallet} 0.5 --keypair ~/.highwire-devnet/devnet-keypair.json --allow-unfunded-recipient --url https://api.devnet.solana.com`);
    }
  }
  const relayUrl = createDeps({}).relayUrl;
  const get = async (path: string) => {
    const res = await fetch(`${relayUrl}${path}`);
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return res.json() as Promise<any>;
  };
  log("pair", `${a.wallet} and ${b.wallet}, ${stakeSol} SOL a side, case ${mode}, on ${rpcUrl.replace(/\?.*$/, "")}, referee ${relayUrl}`);
  const out = await runPair({
    a,
    b,
    stakeSol,
    mode,
    stakes: { chain: new Chain({ cluster: "devnet", rpcUrl }), program },
    balance: (wallet) => connection.getBalance(new PublicKey(wallet)),
    watch: (match) => get(`/api/link/match/${match}`),
    played: async () => (await get("/api/link/stakes")).played,
    log,
  });
  const failed = out.checks.filter((c) => !c.ok);
  console.log(`\n== ${mode}: battle ${out.battle}`);
  console.log(`watch it: ${relayUrl}/link/match/${out.match}`);
  console.log(`${out.checks.length - failed.length} of ${out.checks.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => f.what).join("; ")}` : ""}`);
  console.log(`took ${Math.round((Date.now() - t0) / 60_000)} minutes`);
  process.exit(out.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`link-stake-pair: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
