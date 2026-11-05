// Facts about higher.fun's live deployment. Sources and dates are in
// docs/higher-reference.md; re-check them there before changing anything.

export const SITE_URL = "https://higher.fun";
export const DEFAULT_API_URL = "https://api.higher.fun";
export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

export const LAMPORTS_PER_SOL = 1_000_000_000;
/** LaunchLab mints use 6 decimals and a 1B supply. */
export const TOKEN_DECIMALS = 6;
export const TOTAL_SUPPLY_TOKENS = 1_000_000_000;

/** Raydium programs and higher.fun's LaunchLab platform configs on mainnet. */
export const MAINNET = {
  launchLabProgram: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
  launchLabAuth: "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh",
  launchLabSolConfig: "6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX",
  cpmmProgram: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  cpmmAuth: "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL",
  cpmmConfig: "D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2",
  lockCpmmProgram: "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE",
  lockCpmmAuth: "3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH",
  /** Platform config for Old school ("classic") coins. */
  classicPlatform: "7mT6fb3m6W2886ymKsShBBcnX3TYb9ZsnkDJtACsVt8V",
  /** Platform config for New school ("rewards") coins; the web app calls it rallyPlatform. */
  rewardsPlatform: "6ngXxsSPUxp9YEX2QBXQP1DEdNud12tobUmnJVN74D5v",
} as const;

/** The $HIGH coin itself. */
export const HIGH_MINT = "7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh";

/** Accounts that hold tokens on behalf of a curve, pool or lock, not a person. */
export const KNOWN_ACCOUNTS: Record<string, string> = {
  // After graduation this vault still holds any creator lock, so it isn't always curve tokens.
  [MAINNET.launchLabAuth]: "Raydium LaunchLab vault (bonding curve, or locked tokens after graduation)",
  [MAINNET.cpmmAuth]: "Raydium CPMM pool vault",
  [MAINNET.lockCpmmAuth]: "Raydium LP lock",
};

export type FeeMode = "classic" | "rewards";

export const RAYDIUM_TRADE_FEE_BPS = 25;

/** Fee modes as the web app encodes them. A creator picks one at launch; it can't change. */
export const FEE_MODES = {
  classic: {
    label: "Old school",
    summary: "Cheapest. No trading fee to the creator or higher.fun, only Raydium's 0.25%.",
    platformFeeBps: 0,
    creatorFeeBps: 0,
    totalTradeFeeBps: RAYDIUM_TRADE_FEE_BPS,
    platformTokenSharePct: 1,
    liquidityAtGraduation: { burnedPct: 100, lockedPct: 0 },
    creatorEarnsAfterGraduation: false,
    platformConfig: MAINNET.classicPlatform,
  },
  rewards: {
    label: "New school",
    summary: "Creator rewards. The creator earns 0.25% of every trade, plus pool fees after graduation.",
    platformFeeBps: 50,
    creatorFeeBps: 25,
    totalTradeFeeBps: 50 + 25 + RAYDIUM_TRADE_FEE_BPS,
    platformTokenSharePct: 0,
    liquidityAtGraduation: { burnedPct: 70, lockedPct: 30 },
    /** Fees on the locked LP split 10 parts creator, 20 parts higher.fun. */
    lockedLpFeeSplit: { creatorParts: 10, platformParts: 20 },
    creatorEarnsAfterGraduation: true,
    optionalCreatorLockPct: { min: 1, max: 10, cliffDays: 7, unlockDays: 30 },
    platformConfig: MAINNET.rewardsPlatform,
  },
} as const;

export const COIN_SORTS = ["new", "trending", "mcap", "graduating"] as const;
export const CANDLE_INTERVALS = ["1m", "5m", "1h", "1d"] as const;
export const WINDOWS = ["24h", "7d"] as const;
export const LEADERBOARD_KINDS = ["traders", "creators"] as const;

export function coinUrl(mint: string): string {
  return `${SITE_URL}/coin/${mint}`;
}

export function profileUrl(wallet: string): string {
  return `${SITE_URL}/profile/${wallet}`;
}
