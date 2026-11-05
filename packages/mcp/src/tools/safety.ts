import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bpsToPct, coinUrl, evaluateRisk, summarizeSafety } from "highwire-core";
import { run } from "../result.ts";
import { READ_ONLY, mint, type Deps } from "./shared.ts";

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
