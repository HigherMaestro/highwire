import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profileUrl } from "../higher/constants.js";
import { baseToTokens, lamportsToSol, looksLikeImpersonation, summarizeCoin } from "../higher/format.js";
import { run } from "../lib/result.js";
import { READ_ONLY, cursor, solUsd, wallet, type Deps } from "./shared.js";

export function registerProfileTools(server: McpServer, { api }: Deps) {
  server.registerTool(
    "get_wallet_profile",
    {
      title: "Get wallet profile",
      description:
        "A wallet's higher.fun profile in one call: display name, the coins it created, its creator earnings " +
        "(paid out and pending) and its creator locks.",
      inputSchema: { wallet },
      annotations: { title: "Get wallet profile", ...READ_ONLY },
    },
    ({ wallet }) =>
      run(async () => {
        const [user, coins, earnings, locks, usd] = await Promise.all([
          api.user(wallet),
          api.userCoins(wallet),
          api.earnings(wallet),
          api.locks(wallet),
          solUsd(api),
        ]);
        return {
          wallet,
          profile: profileUrl(wallet),
          displayName: user.displayName,
          ...(looksLikeImpersonation(user.displayName) ? { flags: ["display name uses look-alike letters (possible impersonation)"] } : {}),
          bio: user.bio,
          joined: user.createdAt,
          earnings: {
            paidOutSol: lamportsToSol(earnings.paidOut, 6),
            pendingSol: lamportsToSol(earnings.pendingPayout, 6),
          },
          coinsCreated: coins.items.map((c) => summarizeCoin(c, usd)),
          moreCoinsCursor: coins.nextCursor ?? null,
          locks: locks.items.map((l) => ({
            mint: l.mint,
            ticker: l.ticker,
            status: l.status,
            lockedTokens: baseToTokens(l.lockedAmount, 0),
            cliffDays: l.cliffSeconds / 86_400,
            unlockDays: l.unlockSeconds / 86_400,
            unlocksAt: l.unlocksAt,
          })),
        };
      }),
  );

  server.registerTool(
    "get_creator_coins",
    {
      title: "Get creator coins",
      description: "Page through every coin a wallet has launched on higher.fun.",
      inputSchema: { wallet, cursor },
      annotations: { title: "Get creator coins", ...READ_ONLY },
    },
    ({ wallet, cursor }) =>
      run(async () => {
        const [page, usd] = await Promise.all([api.userCoins(wallet, cursor), solUsd(api)]);
        return { wallet, coins: page.items.map((c) => summarizeCoin(c, usd)), nextCursor: page.nextCursor ?? null };
      }),
  );
}
