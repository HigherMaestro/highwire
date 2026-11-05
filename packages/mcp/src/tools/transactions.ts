import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildClaimCreatorFees,
  buildLaunch,
  buildTrade,
  CREATOR_LOCK,
  DEFAULT_SLIPPAGE_BPS,
  FEE_MODES,
  failedSimulation,
  graduatedCoinsOf,
  launchFingerprint,
  lamportsToSol,
  MAX_SLIPPAGE_BPS,
  quoteTrade,
  signUrl,
  solToLamports,
  summarizePositions,
  summarizeQuote,
  tokensNumber,
  tokensToBase,
  walletPositions,
  ValidationError,
  type Envelope,
} from "highwire-core";
import { PublicKey } from "@solana/web3.js";
import { jsonResult, run, runResult } from "../result.ts";
import { BUILD, READ_ONLY, mint, solUsd, wallet, type Deps } from "./shared.ts";

// Quotes, positions and unsigned transactions. The build tools never sign and
// never see a key: they return transactions for the user's own wallet to sign
// (docs/unsigned-transactions.md), plus a sign_url to the signing page on
// highwire.fun. quote_trade and get_wallet_positions are reads. The hosted
// endpoint serves the whole group (HOSTED_TRANSACTION_TOOLS in http.ts).

/** The tools that build transactions. The hosted endpoint charges them more of the rate limit. */
export const BUILD_TOOL_NAMES = ["build_trade", "build_launch", "build_claim_creator_fees"] as const;

const SIGN_NOTE =
  "Give the user sign_url now: highwire.fun/sign shows what this does, re-checks and simulates it in their browser, and " +
  "has their wallet sign it. Trade and claim links work for up to 10 minutes (the page fetches a fresh blockhash; the " +
  "minimum out still holds). A launch link lasts about a minute, since its new mint is already signed. If it has " +
  "expired, build again.";

const side = z.enum(["buy", "sell"]).describe("buy spends SOL for tokens; sell spends tokens for SOL.");
const sol = z.number().positive().max(1_000_000).optional().describe("For a buy: SOL to spend.");
const tokens = z.number().positive().max(1_000_000_000).optional().describe("For a sell: whole tokens to sell (supply is 1B).");

function tradeAmount(args: { side: "buy" | "sell"; sol?: number; tokens?: number }): bigint {
  if (args.side === "buy") {
    if (args.sol === undefined || args.tokens !== undefined) throw new ValidationError("A buy takes `sol` (and not `tokens`).");
    return solToLamports(args.sol);
  }
  if (args.tokens === undefined || args.sol !== undefined) throw new ValidationError("A sell takes `tokens` (and not `sol`).");
  return tokensToBase(args.tokens);
}

/** Wraps an envelope result with its sign link; a failed simulation becomes an error that still shows what was built. */
async function envelopeResult(env: Envelope, siteUrl: string, extra: Record<string, unknown>) {
  const failed = failedSimulation(env);
  if (failed) {
    return jsonResult(
      {
        error: `Transaction ${failed.index + 1} (${failed.label}) failed simulation: ${failed.simulation.error}`,
        code: "simulation_failed",
        next_step:
          "Don't sign it. Common causes: the wallet lacks SOL or tokens, the price moved past the slippage, or the coin " +
          "changed stage. Check the wallet with get_wallet_positions and quote again.",
        summary: failed.summary,
        logs: failed.simulation.logs,
      },
      true,
    );
  }
  return jsonResult({ sign_url: await signUrl(env, siteUrl), sign_note: SIGN_NOTE, ...extra, unsigned: env });
}

export function registerTransactionTools(server: McpServer, deps: Deps) {
  const { api, chain, siteUrl } = deps;
  const onMainnet = chain.cluster === "mainnet";

  server.registerTool(
    "quote_trade",
    {
      title: "Quote a trade",
      description:
        "Quote a buy (by SOL in) or a sell (by tokens in) of a higher.fun coin, wherever it trades now: the LaunchLab bonding " +
        "curve, or its Raydium CPMM pool after graduation. Returns the expected output, the minimum at the given slippage, " +
        "price impact, and the fees split by who receives them under the coin's fee mode. Reads only.",
      inputSchema: {
        mint,
        side,
        sol,
        tokens,
        slippage_bps: z.number().int().min(0).max(MAX_SLIPPAGE_BPS).default(DEFAULT_SLIPPAGE_BPS).describe("Slippage for the minimum out, in bps (100 = 1%)."),
      },
      annotations: { title: "Quote a trade", ...READ_ONLY },
    },
    (args) =>
      run(async () => {
        const q = await quoteTrade(chain, { mint: new PublicKey(args.mint), side: args.side, amountIn: tradeAmount(args), slippageBps: args.slippage_bps });
        return { cluster: chain.cluster, ...summarizeQuote(q) };
      }),
  );

  server.registerTool(
    "get_wallet_positions",
    {
      title: "Get wallet positions",
      description:
        "A wallet's SOL balance and its balances in higher.fun coins, each valued at the coin's last price. Coins are " +
        "recognised on-chain (a LaunchLab pool on higher.fun's platform), so look-alike tokens don't show up.",
      inputSchema: { wallet },
      annotations: { title: "Get wallet positions", ...READ_ONLY },
    },
    (args) =>
      run(async () => {
        const [p, usd] = await Promise.all([
          walletPositions(chain, onMainnet ? api : null, new PublicKey(args.wallet)),
          onMainnet ? solUsd(api) : Promise.resolve(undefined),
        ]);
        return { cluster: chain.cluster, ...summarizePositions(p, usd) };
      }),
  );

  const maxSol = deps.maxSolPerTx;

  server.registerTool(
    "build_trade",
    {
      title: "Build a trade (unsigned)",
      description:
        "Build an unsigned buy or sell for the user's own wallet to sign: the same transaction higher.fun's site builds. " +
        "Quote first with quote_trade and show the user the quote. Set confirm_trade to true only after the user has " +
        "approved this exact trade (coin, side, amount, slippage). The transaction is checked instruction by instruction, " +
        "simulated, and returned as base64 with a plain-language summary and a sign_url for the user to review and sign in " +
        "their own wallet. Highwire never signs and never needs a private key.",
      inputSchema: {
        wallet: wallet.describe("The wallet that will sign and pay (public key only)."),
        mint,
        side,
        sol,
        tokens,
        max_slippage_bps: z.number().int().min(0).max(MAX_SLIPPAGE_BPS).describe("Slippage tolerance in bps, at most 1500 (15%)."),
        max_sol: z
          .number()
          .positive()
          .max(maxSol)
          .describe(`Cap: a buy may spend at most this much SOL; a sell may return at most this much. At most ${maxSol}.`),
        confirm_trade: z.literal(true).describe("Set to true only after the user approved this exact trade."),
      },
      annotations: { title: "Build a trade (unsigned)", ...BUILD },
    },
    (args) =>
      runResult(async () => {
        const built = await buildTrade(chain, {
          wallet: new PublicKey(args.wallet),
          mint: new PublicKey(args.mint),
          side: args.side,
          amountIn: tradeAmount(args),
          slippageBps: args.max_slippage_bps,
          maxLamports: solToLamports(args.max_sol),
        });
        return envelopeResult(built.envelope, siteUrl, { quote: summarizeQuote(built.quote) });
      }),
  );

  server.registerTool(
    "build_launch",
    {
      title: "Build a coin launch (unsigned)",
      description:
        "Build the unsigned transactions that launch a coin on higher.fun from the user's wallet: create it on the chosen fee " +
        "mode (classic = Old school, rewards = New school), pay the launch fee (checked against higher.fun's on-chain fee " +
        "wallet and cap), an optional first buy, and for New school an optional creator lock. Needs metadata_uri: higher.fun's " +
        "image and metadata upload needs a wallet sign-in Highwire can't do, so without it the tool returns the metadata JSON " +
        "to host first. Reuse the same idempotency_key on retries: it keeps the same mint, so the coin (and its fee) can only " +
        "happen once, on any server instance. Set confirm_launch to true only after the user approved the launch, its cost " +
        "and its fee mode. Returns the transactions and a sign_url for the user's wallet.",
      inputSchema: {
        wallet: wallet.describe("The creator's wallet, which signs and pays (public key only)."),
        name: z.string().min(1).max(32).describe("Coin name, up to 32 characters."),
        ticker: z.string().regex(/^[A-Za-z0-9]{1,10}$/).describe("Ticker, 1-10 letters or digits, without the $."),
        description: z.string().max(500).optional(),
        image_url: z.string().url().max(200).optional().describe("https URL of the coin's image, put in the prepared metadata."),
        metadata_uri: z.string().url().max(200).optional().describe("https URL of the coin's hosted metadata JSON."),
        website: z.string().url().max(200).optional(),
        x: z.string().url().max(200).optional().describe("https://x.com/... link"),
        telegram: z.string().url().max(200).optional().describe("https://t.me/... link"),
        fee_mode: z.enum(["classic", "rewards"]).describe(`classic: ${FEE_MODES.classic.summary} rewards: ${FEE_MODES.rewards.summary}`),
        creator_lock_pct: z
          .number()
          .int()
          .min(CREATOR_LOCK.minPct)
          .max(CREATOR_LOCK.maxPct)
          .optional()
          .describe("rewards only: lock this % of supply for the creator (7-day cliff after graduation, then 30 days linear)."),
        dev_buy_sol: z.number().min(0).max(maxSol).optional().describe(`SOL for the creator's first buy, in the same transaction. At most ${maxSol}.`),
        max_slippage_bps: z.number().int().min(0).max(MAX_SLIPPAGE_BPS).default(500).describe("Slippage for the first buy, in bps."),
        idempotency_key: z
          .string()
          .min(8)
          .max(128)
          .describe("A unique, unguessable key for this coin (a random UUID). Reuse it on retries: it fixes the coin's mint address."),
        confirm_launch: z.literal(true).describe("Set to true only after the user approved this launch."),
      },
      annotations: { title: "Build a coin launch (unsigned)", ...BUILD },
    },
    (args) =>
      runResult(async () => {
        const w = new PublicKey(args.wallet);
        const input = { wallet: w, name: args.name, ticker: args.ticker, mode: args.fee_mode };
        const mintKey = deps.launchKeys.get(args.idempotency_key, launchFingerprint(chain.cluster, input));
        const r = await buildLaunch(chain, onMainnet ? api : null, {
          ...input,
          description: args.description,
          imageUrl: args.image_url,
          metadataUri: args.metadata_uri,
          website: args.website,
          x: args.x,
          telegram: args.telegram,
          creatorLockPct: args.creator_lock_pct,
          devBuyLamports: args.dev_buy_sol ? solToLamports(args.dev_buy_sol) : undefined,
          slippageBps: args.max_slippage_bps,
          mint: mintKey,
        });
        if (r.status === "needs_metadata") {
          return jsonResult({ status: r.status, mint: mintKey.publicKey.toBase58(), metadata: r.metadata, next_step: r.nextStep });
        }
        if (r.status === "already_launched") {
          return jsonResult({ status: r.status, mint: r.mint, url: r.url, note: "This idempotency key's coin already exists. Nothing to sign." });
        }
        const costs = r.envelope.transactions.length;
        return envelopeResult(r.envelope, siteUrl, {
          status: r.status,
          mint: r.mint,
          poolId: r.poolId,
          feeMode: { mode: r.mode, label: FEE_MODES[r.mode].label, platformConfig: r.platformId },
          launchFee: r.launchFee,
          devBuySol: r.devBuySol,
          creatorLock: r.creatorLock ? { pct: r.creatorLock.pct, tokens: tokensNumber(r.creatorLock.tokens) } : null,
          ...(chain.cluster === "devnet" ? { note: "Devnet: higher.fun's API serves mainnet only, so no launch fee is charged." } : {}),
          ...(costs > 1 ? { order: "Send the transactions in order; the lock assignment needs the coin to exist first." } : {}),
        });
      }),
  );

  server.registerTool(
    "build_claim_creator_fees",
    {
      title: "Build creator fee claims (unsigned)",
      description:
        "Show what a creator can claim and build the unsigned claim transactions: curve creator fees (New school coins, one " +
        "vault across all the creator's coins) and, after graduation, each coin's Raydium CPMM pool creator fee. A New " +
        "school creator's third of the locked-LP fees is paid by higher.fun off-chain; that is reported, not claimed. " +
        "Returns a sign_url for the user's wallet when there is something to claim.",
      inputSchema: { wallet: wallet.describe("The creator's wallet, which signs (public key only).") },
      annotations: { title: "Build creator fee claims (unsigned)", ...BUILD },
    },
    (args) =>
      runResult(async () => {
        const w = new PublicKey(args.wallet);
        const [graduated, earnings] = onMainnet
          ? await Promise.all([graduatedCoinsOf(api, w), api.earnings(args.wallet).catch(() => null)])
          : [[], null];
        const r = await buildClaimCreatorFees(chain, w, graduated);
        const offChain = earnings
          ? {
              paidOutSol: lamportsToSol(earnings.paidOut, 6),
              pendingSol: lamportsToSol(earnings.pendingPayout, 6),
              note: "Locked-LP fee share, paid by higher.fun to the creator's wallet. Nothing to sign.",
            }
          : null;
        if (!r.envelope) return jsonResult({ claimable: r.claimable, offChainPayouts: offChain, note: "Nothing to claim on-chain right now." });
        return envelopeResult(r.envelope, siteUrl, { claimable: r.claimable, offChainPayouts: offChain });
      }),
  );
}

