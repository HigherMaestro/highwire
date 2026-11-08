import { ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { AGENT_CODE, AGENT_MEMO_PREFIX, COMPUTE_UNITS, MEMO_PROGRAM_ID } from "../higher/constants.ts";
import { ValidationError } from "../lib/errors.ts";
import type { Chain } from "./chain.ts";
import { finish, priorityFee, type Finished } from "./envelope.ts";

// The registration transaction (docs/x-posting.md 5.1, step 4): the wallet sends the memo "highwire agent <code>" to
// prove to Highwire's relay that it holds the wallet. No transfer: it costs only the network fee. Only the local
// signer executes it, for a code it requested itself; the sign page refuses it (assertSafe allows the memo only when
// the caller expects that exact code, and the sign page never does), and it never gets a sign link.

export interface RegistrationRequest {
  wallet: PublicKey;
  code: string;
  simulate?: boolean;
}

export async function buildAgentRegistration(chain: Chain, req: RegistrationRequest): Promise<Finished> {
  if (!AGENT_CODE.test(req.code)) throw new ValidationError("A registration code is 16 lowercase base32 characters.");
  const microLamports = await priorityFee(chain, [req.wallet]);
  const memo = new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from(`${AGENT_MEMO_PREFIX}${req.code}`, "utf8") });
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: req.wallet,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.register }), memo],
    }).compileToV0Message(),
  );
  return finish({
    chain,
    wallet: req.wallet,
    kind: "register",
    simulate: req.simulate,
    txs: [{ tx, label: "register with Highwire's relay", expect: { wallet: req.wallet, allowLaunchLab: false, allowCpmm: false, agentCode: req.code } }],
  });
}
