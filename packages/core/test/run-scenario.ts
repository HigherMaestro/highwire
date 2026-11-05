import { createHttpConfig } from "../src/lib/http.ts";
import { HigherApi } from "../src/higher/api.ts";
import { Chain } from "../src/tx/chain.ts";
import { buildClaimCreatorFees, graduatedCoinsOf } from "../src/tx/claim.ts";
import { buildLaunch } from "../src/tx/launch.ts";
import { walletPositions } from "../src/tx/positions.ts";
import { buildTrade } from "../src/tx/trade.ts";
import { solToLamports, tokensToBase } from "../src/tx/units.ts";
import { CREATOR, CURVE_COIN, GRADUATED_COIN, GRADUATED_HOLDER, LAUNCH_MINT, LAUNCH_URI, TRADER, type Scenario } from "./scenarios.ts";

/** Runs one scenario against whatever fetch it's given: the real network when recording, a recording in tests. */
export async function runScenario(name: Scenario, fetch: typeof globalThis.fetch) {
  const chain = new Chain({ cluster: "mainnet", fetch });
  const api = new HigherApi(createHttpConfig({ baseUrl: "https://api.higher.fun", fetch, retries: 0 }));
  const max = solToLamports(5);
  switch (name) {
    case "buy-curve":
      return buildTrade(chain, { wallet: TRADER, mint: CURVE_COIN, side: "buy", amountIn: solToLamports(0.01), slippageBps: 200, maxLamports: max });
    case "sell-curve":
      return buildTrade(chain, { wallet: TRADER, mint: CURVE_COIN, side: "sell", amountIn: tokensToBase(100_000), slippageBps: 200, maxLamports: max });
    case "buy-graduated":
      return buildTrade(chain, { wallet: TRADER, mint: GRADUATED_COIN, side: "buy", amountIn: solToLamports(0.01), slippageBps: 300, maxLamports: max });
    case "sell-graduated":
      return buildTrade(chain, { wallet: GRADUATED_HOLDER, mint: GRADUATED_COIN, side: "sell", amountIn: tokensToBase(100_000), slippageBps: 300, maxLamports: max });
    case "launch-rewards":
      return buildLaunch(chain, api, {
        wallet: TRADER,
        name: "Highwire Sim",
        ticker: "HWSIMX",
        description: "Simulation only",
        metadataUri: LAUNCH_URI,
        mode: "rewards",
        creatorLockPct: 5,
        devBuyLamports: solToLamports(0.05),
        slippageBps: 500,
        mint: LAUNCH_MINT,
      });
    case "claim":
      return buildClaimCreatorFees(chain, CREATOR, await graduatedCoinsOf(api, CREATOR));
    case "positions":
      return walletPositions(chain, api, GRADUATED_HOLDER);
    case "positions-mints":
      return walletPositions(chain, api, GRADUATED_HOLDER, { mints: [GRADUATED_COIN, CURVE_COIN] });
  }
}
