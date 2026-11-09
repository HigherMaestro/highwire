import { lstatSync } from "node:fs";
import { agentPaths, holdProcessLock, loadPolicy, lockHolder, WagerRunner, WagerSecrets, type LocalSigner, type WagerAction } from "highwire-agent";
import { buildWagerMove, lamportsNumber, listWalletSeries, type Chain, type WagerMoveRequest } from "highwire-core";
import { serverOptionsFromEnv } from "./env.ts";
import { createDeps } from "./server.ts";
import { signerFromEnv } from "./signer-env.ts";

// `highwire line run|series`: The Line's wager series for the wallet in HIGHWIRE_KEYPAIR_PATH. `run` is the reveal
// daemon (docs/wager-mode.md 7.3): until Ctrl-C it reveals every committed move and owed fallback, applies passed
// deadlines, settles, and cancels or refunds, through the local signer and inside the policy. One at a time.

export const LINE_USAGE = `highwire line: The Line's wager series, for HIGHWIRE_KEYPAIR_PATH's wallet

  highwire line run      the reveal daemon: reveal every committed move and owed fallback, apply passed deadlines,
                         settle finished series, until Ctrl-C. Wagering needs it running: a commit nobody reveals
                         forfeits its match
  highwire line series   the wallet's open and live series on-chain

It acts only through the local signer, inside the policy ("wager" in actions, and a wagers section). STOP halts it,
and then open matches are forfeited; STOP-WAGERS stops new stakes and lets it finish what's open.`;

type Env = Record<string, string | undefined>;

export interface LineIo {
  out: (line: string) => void;
  err: (line: string) => void;
  signal: AbortSignal;
  env?: Env;
}

function argsFor(action: WagerAction): WagerMoveRequest["args"] {
  if (action.kind === "reveal") return { kind: "reveal", pull: action.pull, nonce: action.nonce };
  if (action.kind === "revealFallback") return { kind: "revealFallback", fallback: action.fallback, salt: action.salt };
  return { kind: action.kind };
}

/** Builds one daemon action and sends it through the signer. */
export async function actOnSeries(chain: Chain, signer: LocalSigner, seriesId: string, action: WagerAction, tool = "highwire line run"): Promise<string> {
  const built = await buildWagerMove(chain, { wallet: signer.publicKey, seriesId, args: argsFor(action) });
  const r = await signer.execute(chain.connection, { tool, intent: { action: "wager", cluster: chain.cluster, solOut: 0n, wager: { kind: action.kind } }, envelope: built.envelope });
  const sig = r.transactions[0]?.signature;
  return `${r.status}${sig ? ` ${sig}` : ""}${r.transactions[0]?.error ? ` (${r.transactions[0].error})` : ""}`;
}

export async function runLine(argv: string[], io: LineIo): Promise<number> {
  const env = io.env ?? process.env;
  const [cmd] = argv;
  if (cmd !== "run" && cmd !== "series") {
    io.out(LINE_USAGE);
    return cmd === undefined || cmd === "--help" ? 0 : 2;
  }
  const signer = signerFromEnv(env, io.err);
  if (!signer) {
    io.err(`highwire line ${cmd}: set HIGHWIRE_KEYPAIR_PATH to the signer's keypair file, as for the MCP server.`);
    return 2;
  }
  const paths = agentPaths(env);
  const deps = createDeps({ ...serverOptionsFromEnv(env), signer });
  try {
    if (cmd === "series") {
      const all = await listWalletSeries(deps.chain, signer.publicKey);
      const pid = lockHolder(paths.wagerRunner);
      io.err(pid !== null ? `The reveal daemon is running (pid ${pid}).` : "The reveal daemon isn't running: start it with `highwire line run`.");
      if (!all.length) io.out("No open or live series.");
      for (const s of all) {
        const h = s.header;
        const me = h.playerA === signer.wallet ? "A" : "B";
        const score = s.series ? `${s.series.results.filter((r) => r?.winner === me).length}-${s.series.results.filter((r) => r?.winner && r.winner !== me).length}` : "";
        io.out(`${h.seriesId}  ${h.status.padEnd(4)}  ${lamportsNumber(h.stake)} SOL a side  ${s.series?.ending ? "over, to settle" : s.series ? `match ${s.series.match + 1}, ${score}` : "waiting for B"}`);
      }
      return 0;
    }
    const release = holdProcessLock(paths.wagerRunner, "highwire line run");
    try {
      const policy = loadPolicy(paths.policy);
      io.err(
        `Watching ${signer.wallet}'s wager series on ${deps.chain.cluster}, ${policy.live ? "live" : 'dry run ("live": false: nothing is sent, so nothing is revealed)'}. ` +
          `${policy.actions.includes("wager") && policy.wagers ? "" : 'The policy doesn\'t allow wagers ("wager" in actions and a wagers section), so every action will be refused. '}Ctrl-C to stop.`,
      );
      const runner = new WagerRunner({
        wallet: signer.wallet,
        list: () => listWalletSeries(deps.chain, signer.publicKey),
        act: (id, action) => actOnSeries(deps.chain, signer, id, action),
        secrets: new WagerSecrets(paths.wagerSecrets),
        stopped: () => {
          try {
            lstatSync(paths.stop);
            return true;
          } catch {
            return false;
          }
        },
        log: (l) => io.err(`${new Date().toISOString().slice(11, 19)}  ${l}`),
      });
      await runner.run(io.signal);
      return 0;
    } finally {
      release();
    }
  } catch (err) {
    io.err(`highwire line: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
