import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { COMPUTE_UNITS, TOKEN_DECIMALS } from "../higher/constants.ts";
import { ValidationError } from "../lib/errors.ts";
import type { Chain } from "./chain.ts";
import { finish, priorityFee, type Finished } from "./envelope.ts";

// build_transfer: SOL, or a higher.fun coin, from the wallet to another wallet.
// Only the local signer executes these, and only to addresses on the user's
// allowlist: the sign page refuses transfers, since a sign link can come from
// anyone (see sign-link.ts).

export interface TransferRequest {
  wallet: PublicKey;
  to: PublicKey;
  /** SOL to send, in lamports. Give this or `mint` and `amount`. */
  lamports?: bigint;
  /** A higher.fun coin to send, and how much in base units. */
  mint?: PublicKey;
  amount?: bigint;
  simulate?: boolean;
}

export async function buildTransfer(chain: Chain, req: TransferRequest): Promise<Finished> {
  const { wallet, to } = req;
  if (to.equals(wallet)) throw new ValidationError("The recipient is the wallet itself.");
  const sendsSol = req.lamports !== undefined;
  if (sendsSol === (req.mint !== undefined) || (req.mint !== undefined && req.amount === undefined)) {
    throw new ValidationError("A transfer sends either SOL (lamports) or a coin (mint and amount).");
  }
  if ((req.lamports ?? req.amount ?? 0n) <= 0n) throw new ValidationError("The amount must be more than zero.");

  const microLamports = await priorityFee(chain, [wallet]);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.transfer }),
  ];
  let label: string;
  if (sendsSol) {
    ixs.push(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: to, lamports: req.lamports! }));
    label = "send SOL";
  } else {
    const mint = req.mint!;
    // Only higher.fun coins: market() refuses anything that didn't launch on its LaunchLab platforms.
    await chain.market(mint);
    const info = await chain.connection.getAccountInfo(mint);
    if (!info) throw new ValidationError(`mint ${mint.toBase58()} doesn't exist on ${chain.cluster}`);
    const program = info.owner;
    const from = getAssociatedTokenAddressSync(mint, wallet, true, program);
    const dest = getAssociatedTokenAddressSync(mint, to, true, program);
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(wallet, dest, to, mint, program),
      createTransferCheckedInstruction(from, mint, dest, wallet, req.amount!, TOKEN_DECIMALS, [], program),
    );
    label = "send tokens";
  }
  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: wallet, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message(),
  );
  return finish({
    chain,
    wallet,
    kind: "transfer",
    simulate: req.simulate,
    txs: [
      {
        tx,
        label,
        expect: {
          wallet,
          allowLaunchLab: false,
          allowCpmm: false,
          transfer: sendsSol ? { to, lamports: req.lamports } : { to, mint: req.mint, amount: req.amount },
        },
      },
    ],
  });
}
