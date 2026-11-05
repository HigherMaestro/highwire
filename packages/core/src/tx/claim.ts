import {
  CpmmConfigInfoLayout,
  CpmmPoolInfoLayout,
  getPdaCreatorVault,
  makeCollectCreatorFeeInstruction,
  TxVersion,
} from "@raydium-io/raydium-sdk-v2";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { HigherApi } from "../higher/api.ts";
import { COMPUTE_UNITS } from "../higher/constants.ts";
import { WSOL, type Chain } from "./chain.ts";
import { UnsafeTransactionError } from "./decode.ts";
import { finish, priorityFee, withoutLookupTables, type BuiltTx, type Envelope } from "./envelope.ts";
import { lamportsNumber, tokensNumber } from "./units.ts";

// build_claim_creator_fees. A creator earns in three places:
// 1. Curve creator fees (New school, 0.25% of each curve trade) pile up in one
//    LaunchLab vault per creator, across all their coins: claim_creator_fee.
// 2. After graduation, every coin's CPMM pool charges a pool creator fee on the
//    SOL side for the coin's creator: collect_creator_fee, per pool.
// 3. A New school creator's third of the locked-LP fees: the LP lock's Fee Key
//    belongs to higher.fun, which pays creators off-chain (the API's
//    pendingPayout). Nothing to sign for that one.

export interface CreatorFees {
  curve: { lamports: bigint; vault: string } | null;
  pools: { mint: string; poolId: string; lamports: bigint; tokens: bigint; pool: ReturnType<typeof CpmmPoolInfoLayout.decode> }[];
  /** Coins created by the wallet that we checked. */
  checkedCoins: number;
}

const big = (v: { toString(): string }) => BigInt(v.toString());

/** Reads what the wallet can claim right now. `mints` are the graduated coins it created. */
export async function readCreatorFees(chain: Chain, wallet: PublicKey, graduatedMints: PublicKey[]): Promise<CreatorFees> {
  const vault = getPdaCreatorVault(chain.key("launchLabProgram"), wallet, WSOL).publicKey;
  const vaultBalance = await chain.connection.getTokenAccountBalance(vault).then(
    (r) => BigInt(r.value.amount),
    () => 0n, // no vault yet: nothing earned on the curve
  );
  const pools: CreatorFees["pools"] = [];
  const ids = graduatedMints.map((m) => chain.graduatedPoolId(m));
  for (let i = 0; i < ids.length; i += 99) {
    const chunk = ids.slice(i, i + 99);
    const [cfg, ...infos] = await chain.connection.getMultipleAccountsInfo([chain.key("cpmmConfig"), ...chunk]);
    if (!cfg) throw new UnsafeTransactionError("higher.fun's CPMM fee tier is missing");
    // Raydium keeps creatorFeeShareRate (per million) of each pool creator fee.
    const share = big(CpmmConfigInfoLayout.decode(cfg.data).creatorFeeShareRate);
    infos.forEach((info, j) => {
      if (!info || !info.owner.equals(chain.key("cpmmProgram"))) return;
      const pool = CpmmPoolInfoLayout.decode(info.data);
      if (!pool.configId.equals(chain.key("cpmmConfig")) || !pool.poolCreator.equals(wallet)) return;
      const solIsA = pool.mintA.equals(WSOL);
      if (!solIsA && !pool.mintB.equals(WSOL)) return;
      const net = (v: bigint) => (v * (1_000_000n - share)) / 1_000_000n;
      const a = net(big(pool.creatorFeesMintA));
      const b = net(big(pool.creatorFeesMintB));
      const lamports = solIsA ? a : b;
      const tokens = solIsA ? b : a;
      if (lamports > 0n || tokens > 0n) {
        pools.push({ mint: (solIsA ? pool.mintB : pool.mintA).toBase58(), poolId: chunk[j]!.toBase58(), lamports, tokens, pool });
      }
    });
  }
  return { curve: vaultBalance > 0n ? { lamports: vaultBalance, vault: vault.toBase58() } : null, pools, checkedCoins: graduatedMints.length };
}

/** Graduated coins a wallet created, from the higher.fun API (up to 500). */
export async function graduatedCoinsOf(api: HigherApi, wallet: PublicKey): Promise<PublicKey[]> {
  const out: PublicKey[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await api.userCoins(wallet.toBase58(), cursor);
    for (const c of res.items) if (c.status === "graduated") out.push(new PublicKey(c.mint));
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return out;
}

export interface ClaimResult {
  claimable: {
    curveSol: number;
    pools: { mint: string; poolId: string; sol: number; tokens: number }[];
  };
  envelope: Envelope | null;
}

export async function buildClaimCreatorFees(
  chain: Chain,
  wallet: PublicKey,
  graduatedMints: PublicKey[],
  opts: { simulate?: boolean } = {},
): Promise<ClaimResult> {
  const fees = await readCreatorFees(chain, wallet, graduatedMints);
  const claimable = {
    curveSol: fees.curve ? lamportsNumber(fees.curve.lamports) : 0,
    pools: fees.pools.map((p) => ({ mint: p.mint, poolId: p.poolId, sol: lamportsNumber(p.lamports), tokens: tokensNumber(p.tokens) })),
  };
  if (!fees.curve && fees.pools.length === 0) return { claimable, envelope: null };

  const microLamports = await priorityFee(chain, [wallet]);
  const wsolAta = getAssociatedTokenAddressSync(WSOL, wallet, true);
  const unwrap = createCloseAccountInstruction(wsolAta, wallet, wallet);
  const txs: BuiltTx[] = [];

  if (fees.curve) {
    const raydium = await chain.raydium(wallet);
    const { transaction } = await raydium.launchpad.claimCreatorFee({
      computeBudgetConfig: { units: COMPUTE_UNITS.claim, microLamports },
      programId: chain.key("launchLabProgram"),
      mintB: WSOL,
      feePayer: wallet,
      txVersion: TxVersion.V0,
    });
    if (!(transaction instanceof VersionedTransaction)) throw new Error("expected a v0 transaction from claimCreatorFee");
    // Unwrap the claimed SOL, as higher.fun's site does.
    const tables = await chain.lookupTables([transaction]);
    const msg = TransactionMessage.decompile(withoutLookupTables(transaction, tables).message, { addressLookupTableAccounts: tables });
    msg.instructions.push(unwrap);
    txs.push({ tx: new VersionedTransaction(msg.compileToV0Message(tables)), label: "claim curve creator fees", expect: { wallet, allowCpmm: false } });
  }

  if (fees.pools.length > 0) {
    const { blockhash } = await chain.connection.getLatestBlockhash("confirmed");
    const a = chain.addresses;
    const perPool = (p: CreatorFees["pools"][number]): TransactionInstruction[] => {
      const pool = p.pool;
      const ataA = getAssociatedTokenAddressSync(pool.mintA, wallet, true, pool.mintProgramA);
      const ataB = getAssociatedTokenAddressSync(pool.mintB, wallet, true, pool.mintProgramB);
      return [
        createAssociatedTokenAccountIdempotentInstruction(wallet, ataA, wallet, pool.mintA, pool.mintProgramA),
        createAssociatedTokenAccountIdempotentInstruction(wallet, ataB, wallet, pool.mintB, pool.mintProgramB),
        makeCollectCreatorFeeInstruction(
          new PublicKey(a.cpmmProgram),
          wallet,
          new PublicKey(a.cpmmAuth),
          new PublicKey(p.poolId),
          new PublicKey(a.cpmmConfig),
          pool.vaultA,
          pool.vaultB,
          pool.mintA,
          pool.mintB,
          ataA,
          ataB,
          pool.mintProgramA,
          pool.mintProgramB,
        ),
      ];
    };
    const compile = (groups: TransactionInstruction[][]) =>
      new VersionedTransaction(
        new TransactionMessage({
          payerKey: wallet,
          recentBlockhash: blockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1_400_000, COMPUTE_UNITS.claim * groups.length) }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
            ...groups.flat(),
            unwrap,
          ],
        }).compileToV0Message(),
      );
    const fits = (groups: TransactionInstruction[][]) => {
      try {
        return compile(groups).serialize().length <= 1232;
      } catch {
        return false;
      }
    };
    let batch: TransactionInstruction[][] = [];
    for (const p of fees.pools) {
      const next = [...batch, perPool(p)];
      if (batch.length > 0 && !fits(next)) {
        txs.push({ tx: compile(batch), label: "collect CPMM pool creator fees", expect: { wallet, allowLaunchLab: false } });
        batch = [perPool(p)];
      } else batch = next;
    }
    if (batch.length > 0) txs.push({ tx: compile(batch), label: "collect CPMM pool creator fees", expect: { wallet, allowLaunchLab: false } });
  }

  const done = await finish({ chain, wallet, kind: "claim", txs, simulate: opts.simulate });
  return { claimable, envelope: done.envelope };
}
