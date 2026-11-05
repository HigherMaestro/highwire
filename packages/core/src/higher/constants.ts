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

/** The same programs and higher.fun's platform configs on devnet, from the web bundle. */
export const DEVNET = {
  launchLabProgram: "DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6",
  launchLabAuth: "5xqNaZXX5eUi4p5HU4oz9i5QnwRNT2y6oN7yyn4qENeq",
  launchLabSolConfig: "7ZR4zD7PYfY2XxoG1Gxcy2EgEeGYrpxrwzPuwdUBssEt",
  cpmmProgram: "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb",
  cpmmAuth: "CXniRufdq5xL8t8jZAPxsPZDpuudwuJSPWnbcD5Y5Nxq",
  cpmmConfig: "5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy",
  lockCpmmProgram: "DRay25Usp3YJAi7beckgpGUC7mGJ2cR1AVPxhYfwVCUX",
  lockCpmmAuth: "7qWVV8UY2bRJfDLP4s37YzBPKUkVB46DStYJBpYbQzu3",
  classicPlatform: "6UuHHt8Dv4j4edbWf1DcY34WUNhBF48tAQaMxwVvFJtz",
  rewardsPlatform: "5YMKfjGk6sigE6baKyGGCHDQjJTEHHVLSF3cXNvLKKfJ",
} as const;

export const CLUSTERS = ["mainnet", "devnet"] as const;
export type Cluster = (typeof CLUSTERS)[number];
export type ClusterAddresses = { readonly [K in keyof typeof MAINNET]: string };

export const ADDRESSES: Record<Cluster, ClusterAddresses> = { mainnet: MAINNET, devnet: DEVNET };
export const DEFAULT_RPC_URLS: Record<Cluster, string> = {
  mainnet: DEFAULT_RPC_URL,
  devnet: "https://api.devnet.solana.com",
};

/** Raydium publishes LaunchLab's default curve parameters here; its SDK reads them when building a launch. */
export const LAUNCH_CONFIGS_URLS: Record<Cluster, string> = {
  mainnet: "https://launch-mint-v1.raydium.io/main/configs",
  devnet: "https://launch-mint-v1-devnet.raydium.io/main/configs",
};

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
    summary: "Cheapest. On the curve, no trading fee to the creator or higher.fun, only Raydium's 0.25%.",
    platformFeeBps: 0,
    creatorFeeBps: 0,
    totalTradeFeeBps: RAYDIUM_TRADE_FEE_BPS,
    platformTokenSharePct: 1,
    liquidityAtGraduation: { burnedPct: 100, lockedPct: 0 },
    creatorEarnsAfterGraduation: true,
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

/**
 * After graduation every coin trades in a Raydium CPMM pool on higher.fun's fee tier: 0.25% to LPs and Raydium, plus a
 * 0.05% pool creator fee on the SOL side that the coin's creator claims (Raydium keeps 5% of it). Read from the CPMM
 * config account on-chain; see docs/higher-reference.md.
 */
export const GRADUATED_POOL = {
  tradeFeeBps: 25,
  creatorFeeBps: 5,
  creatorKeepsPct: 95,
} as const;

// Limits higher.fun's own web app applies when it builds transactions (its "Rally" module). We use the same ones.
/** The most the launch fee may be. The API quotes 0.02 SOL today. */
export const LAUNCH_FEE_CAP_LAMPORTS = 50_000_000n;
/** Priority fee: the 75th percentile of recent fees on the accounts touched, clamped to this range. */
export const PRIORITY_FEE_MICRO_LAMPORTS = { min: 50_000, max: 2_000_000 } as const;
export const COMPUTE_UNITS = { create: 600_000, curveTrade: 300_000, poolSwap: 300_000, claim: 200_000 } as const;

/** SPL Memo v2. Every transaction Highwire builds carries one memo with HIGHWIRE_MEMO, so its transactions can be counted on-chain. */
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const HIGHWIRE_MEMO = "highwire";
export const DEFAULT_SLIPPAGE_BPS = 200;
/** A creator lock on a New school coin: 1-10% of supply, a 7-day cliff after graduation, then 30 days linear. */
export const CREATOR_LOCK = { minPct: 1, maxPct: 10, cliffSeconds: 604_800, unlockSeconds: 2_592_000 } as const;
/** An Old school coin locks 1% of supply for higher.fun: a 1-day cliff after graduation, then 30 days linear. */
export const CLASSIC_RESERVE = { pct: 1, cliffSeconds: 86_400, unlockSeconds: 2_592_000 } as const;

export function platformFor(cluster: Cluster, mode: FeeMode): string {
  return mode === "classic" ? ADDRESSES[cluster].classicPlatform : ADDRESSES[cluster].rewardsPlatform;
}

/** The fee mode a LaunchLab platform config belongs to, or null when it isn't one of higher.fun's. */
export function feeModeOfPlatform(cluster: Cluster, platformId: string): FeeMode | null {
  if (platformId === ADDRESSES[cluster].classicPlatform) return "classic";
  if (platformId === ADDRESSES[cluster].rewardsPlatform) return "rewards";
  return null;
}

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
