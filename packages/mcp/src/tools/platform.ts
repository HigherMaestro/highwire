import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { coinUrl, FEE_MODES, HIGH_MINT, type HigherApi, lamportsToSol, MAINNET, SITE_URL } from "highwire-core";
import { run } from "../result.ts";
import { READ_ONLY, type Deps } from "./shared.ts";

export async function platformInfo(api: HigherApi) {
  const [fee, price] = await Promise.allSettled([api.launchFee(), api.solPrice()]);
  return {
    site: SITE_URL,
    docs: `${SITE_URL}/docs`,
    source: "https://codeberg.org/higherdotfun/launchpad-template",
    x: "https://x.com/higherdotfun_",
    tagline: "Lower Fees, Higher Together",
    howItWorks:
      "Coins launch on a Raydium LaunchLab bonding curve and graduate to a Raydium CPMM pool once the curve raises its target " +
      "(85 SOL today). The creator picks a fee mode at launch and can't change it.",
    launchFee:
      fee.status === "fulfilled"
        ? { sol: lamportsToSol(fee.value.lamports, 4), treasury: fee.value.treasury, note: "Plus under 0.005 SOL of network fees and rent." }
        : { error: "launch fee unavailable right now" },
    solUsd: price.status === "fulfilled" ? price.value.usd : null,
    feeModes: FEE_MODES,
    highCoin: { mint: HIGH_MINT, url: coinUrl(HIGH_MINT) },
    programs: MAINNET,
  };
}

export function registerPlatformTools(server: McpServer, { api }: Deps) {
  server.registerTool(
    "get_platform_info",
    {
      title: "Get platform info",
      description:
        "How higher.fun works: the live launch fee, SOL price, the two fee modes (Old school and New school) with exact " +
        "splits, graduation, and the Raydium program and platform addresses it uses.",
      inputSchema: {},
      annotations: { title: "Get platform info", ...READ_ONLY },
    },
    () => run(() => platformInfo(api)),
  );

  server.registerTool(
    "check_ticker",
    {
      title: "Check ticker",
      description: "Whether a ticker is still free to launch with on higher.fun.",
      inputSchema: { ticker: z.string().min(1).max(10).describe("Ticker without the $") },
      annotations: { title: "Check ticker", ...READ_ONLY },
    },
    ({ ticker }) =>
      run(async () => {
        const t = ticker.replace(/^\$/, "");
        const { available } = await api.ticker(t);
        return { ticker: t, available };
      }),
  );
}
