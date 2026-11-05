import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CoinDetail } from "../higher/api.js";
import { coinUrl } from "../higher/constants.js";
import { bpsToPct, summarizeSafety } from "../higher/format.js";
import type { MintInfo } from "../solana/rpc.js";
import { run } from "../lib/result.js";
import { READ_ONLY, mint, type Deps } from "./shared.js";

// The verdict combines on-chain mint and freeze authority, top-10 holder
// concentration (caution at 30%, danger at 60%) and higher.fun's own safety data.
// Any danger, or three cautions, makes it HIGH_RISK. RugCheck-style APIs don't
// know brand-new LaunchLab mints, so higher.fun's data does that job here.

export type Verdict = "CLEAN_ON_CHECKS" | "CAUTION" | "HIGH_RISK";

export interface Flag {
  level: "danger" | "caution";
  reason: string;
}

export function evaluateRisk(coin: CoinDetail, onchain: MintInfo | null | { error: string }) {
  const flags: Flag[] = [];
  const danger = (reason: string) => flags.push({ level: "danger", reason });
  const caution = (reason: string) => flags.push({ level: "caution", reason });

  if (onchain && !("error" in onchain)) {
    if (onchain.mintAuthority) danger(`mint authority is still active (${onchain.mintAuthority}): supply can be inflated`);
    if (onchain.freezeAuthority) danger(`freeze authority is still active (${onchain.freezeAuthority}): holders can be frozen`);
  } else if (onchain === null) {
    danger("the mint account wasn't found on chain");
  }

  const grade = coin.safety?.grade ?? coin.trustGrade;
  if (grade === "D" || grade === "F") danger(`higher.fun safety grade ${grade}`);
  else if (grade === "C") caution("higher.fun safety grade C");

  const top10 = coin.top10HoldingBps;
  if (top10 !== null && top10 !== undefined) {
    if (top10 >= 6000) danger(`top 10 holders own ${bpsToPct(top10)}% (very concentrated)`);
    else if (top10 >= 3000) caution(`top 10 holders own ${bpsToPct(top10)}% (elevated)`);
  }
  if ((coin.creatorHoldingBps ?? 0) >= 1000) caution(`the creator holds ${bpsToPct(coin.creatorHoldingBps)}%`);

  const s = coin.safety;
  if (s) {
    if ((s.bundleHeldBps ?? 0) >= 1000) caution(`bundled wallets still hold ${bpsToPct(s.bundleHeldBps)}%`);
    if ((s.snipers?.heldBps ?? 0) >= 1000) caution(`snipers still hold ${bpsToPct(s.snipers?.heldBps)}%`);
    if ((s.dev?.soldEarlyBps ?? 0) > 0) caution(`the dev sold ${bpsToPct(s.dev?.soldEarlyBps)}% early`);
  }
  if (coin.tickerFlagged) caution("higher.fun flagged this ticker (it may copy a well-known coin)");

  const dangers = flags.filter((f) => f.level === "danger").length;
  const verdict: Verdict = dangers > 0 || flags.length >= 3 ? "HIGH_RISK" : flags.length > 0 ? "CAUTION" : "CLEAN_ON_CHECKS";
  return { verdict, flags };
}

export function registerSafetyTools(server: McpServer, { api, rpc }: Deps) {
  server.registerTool(
    "rug_check",
    {
      title: "Rug check",
      description:
        "Safety check before anyone trades a coin: on-chain mint and freeze authority, holder concentration, " +
        "higher.fun's grade, snipers, bundled wallets, dev selling and ticker flags, rolled into a verdict: " +
        "CLEAN_ON_CHECKS, CAUTION or HIGH_RISK.",
      inputSchema: { mint },
      annotations: { title: "Rug check", ...READ_ONLY },
    },
    ({ mint }) =>
      run(async () => {
        const [coin, onchain] = await Promise.all([
          api.coin(mint),
          rpc.mintInfo(mint).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) })),
        ]);
        const { verdict, flags } = evaluateRisk(coin, onchain);
        return {
          mint,
          ticker: coin.ticker,
          url: coinUrl(mint),
          verdict,
          flags,
          onchain:
            onchain && !("error" in onchain)
              ? { tokenProgram: onchain.tokenProgram, mintAuthority: onchain.mintAuthority, freezeAuthority: onchain.freezeAuthority }
              : onchain ?? { error: "mint not found" },
          higherSafety: summarizeSafety(coin.safety),
          top10HoldPct: bpsToPct(coin.top10HoldingBps),
          creatorHoldsPct: bpsToPct(coin.creatorHoldingBps),
          disclaimer:
            "Not financial advice. A clean result doesn't mean a coin is safe. Show the user these findings before any trade or launch.",
        };
      }),
  );
}
