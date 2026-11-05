# Unsigned transactions

What `build_trade`, `build_launch` and `build_claim_creator_fees` return, for wallets, agents and the signing page
on highwire.fun that will consume it. Format version: `highwire.unsigned-tx/v1`.

Highwire never signs for the user and never holds the user's key. It builds Solana v0 transactions with the user's
wallet as fee payer, checks and simulates them, and hands them over. The user's wallet signs and sends.

## The envelope

A build tool's result carries the envelope under `unsigned`, next to tool-specific fields (the quote, the launch's
mint and fee, what can be claimed).

```json
{
  "format": "highwire.unsigned-tx/v1",
  "cluster": "mainnet",
  "wallet": "H4dxJQN6DRqCPva9yaX2Nt3mAkvgo7pyQZr93fLke1U5",
  "kind": "trade",
  "transactions": [
    {
      "index": 0,
      "label": "buy on the curve",
      "base64": "AQAAAA…",
      "encoding": "base64",
      "version": 0,
      "feePayer": "H4dxJQN6DRqCPva9yaX2Nt3mAkvgo7pyQZr93fLke1U5",
      "signers": ["H4dxJQN6DRqCPva9yaX2Nt3mAkvgo7pyQZr93fLke1U5"],
      "presigned": [],
      "walletSigner": "H4dxJQN6DRqCPva9yaX2Nt3mAkvgo7pyQZr93fLke1U5",
      "recentBlockhash": "6Lx…",
      "lastValidBlockHeight": 371234567,
      "dependsOn": [],
      "summary": [
        "Fee payer and signer: H4dx…",
        "1. Set the priority fee to 50,000 micro-lamports per compute unit",
        "2. Set the compute limit to 300,000 units",
        "3. Open token account Crnn… for mint EE3p…, owned by H4dx…, if it doesn't exist yet",
        "4. Create account 4Vkq… (from a seed of H4dx…) to hold wrapped SOL",
        "5. Initialise token account 4Vkq… for mint So11…",
        "6. Buy coin EE3p… on the LaunchLab curve (pool 7fSY…, platform 6ngX…): pay 0.01 SOL, receive at least 98,496.964305 tokens",
        "7. Close token account 4Vkq…, returning its SOL to H4dx…"
      ],
      "fullyDecoded": true,
      "simulation": { "ok": true, "unitsConsumed": 53590 }
    }
  ],
  "expiresAfterBlockHeight": 371234567,
  "howToSign": "…"
}
```

| Field | Meaning |
|---|---|
| `format` | `highwire.unsigned-tx/v1`. A consumer should refuse any other value. |
| `cluster` | `mainnet` or `devnet`. Send to an RPC on this cluster only. |
| `wallet` | The wallet the transactions were built for. It pays every fee. |
| `kind` | `trade`, `launch` or `claim`. |
| `transactions[]` | In the order they must land. |
| `.base64` | A serialized `VersionedTransaction` (message v0) in standard base64. Its signature slots are 64 zero bytes, except those in `presigned`. |
| `.signers` | Every signer the message requires, in order. The first is the fee payer. |
| `.presigned` | Signers whose signature is already in place. Today only a launch's new mint, which Highwire generates and signs with so the coin can be created; the user never needs that key. |
| `.walletSigner` | The one signature the user's wallet adds. Always equal to `wallet` and `feePayer`. |
| `.recentBlockhash`, `.lastValidBlockHeight` | The blockhash in the message and when it expires (about a minute after the build). |
| `.dependsOn` | Indexes of transactions that must be confirmed first. A launch's creator-lock assignment depends on the create. |
| `.summary` | One line for the fee payer, then one per instruction, in plain language. Show these to the user before they sign. |
| `.fullyDecoded` | `true` when every instruction was recognised. Highwire never returns a transaction that isn't. |
| `.simulation` | `{ok, unitsConsumed}`, or `{ok: false, skipped}` when it depends on an earlier transaction, or `{ok: false, error, logs}`. A build whose simulation failed comes back as a `simulation_failed` error instead of an envelope. |
| `expiresAfterBlockHeight` | Rebuild after this height. |

## Signing it

1. Check `format`, `cluster` and that `wallet` is the connected wallet.
2. For each transaction, in order: decode `base64` into a `VersionedTransaction`, show `summary`, have the wallet sign
   it unchanged (`signTransaction`), and send it. Wait for confirmation before sending one that `dependsOn` it.
3. If sending fails with an expired blockhash, call the build tool again. For a launch, use the same `idempotency_key`:
   the mint stays the same, so the coin can't be created twice.

A consumer should re-check before asking the wallet to sign, the way higher.fun's own site does:
- the fee payer and the only unsigned signer is the connected wallet;
- a signer in `presigned` has a valid signature over the message;
- after signing, the message bytes are unchanged (wallets may add priority fees; refuse that if you want exact
  parity with the summary).

In TypeScript, with `@solana/web3.js`:

```ts
import { VersionedTransaction } from "@solana/web3.js";

for (const t of envelope.transactions) {
  const tx = VersionedTransaction.deserialize(Buffer.from(t.base64, "base64"));
  const signed = await wallet.signTransaction(tx); // keeps any presigned mint signature
  const sig = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash: t.recentBlockhash, lastValidBlockHeight: t.lastValidBlockHeight });
}
```

## What Highwire checks before it returns a transaction

Every instruction must be on this list, or the build fails with `unsafe_transaction`:

| Program | Allowed |
|---|---|
| Compute Budget | set compute limit (at most 1.4M), set priority fee (at most 2,000,000 micro-lamports per CU) |
| System | transfers from the wallet into its own token accounts; one launch fee to the fee wallet recorded on-chain, at most the quoted amount; creating the wallet's own token accounts |
| Associated Token | open a token account owned and paid for by the wallet |
| Token | sync native, initialise the wallet's own account, close an account to the wallet |
| Raydium LaunchLab | `initialize_v2` (creator = wallet, on the chosen fee mode's platform config), `buy_exact_in` and `sell_exact_in` (on the coin's higher.fun platform), `create_vesting_account` (the creator lock, to the wallet, on the new coin's pool), `claim_creator_fee` (into the wallet's own account) |
| Raydium CPMM | `swap_base_input` and `collect_creator_fee`, for the wallet, on higher.fun's fee tier, into the wallet's own accounts |

Then the tool checks the intent: one trade of the quoted kind, coin, amount and minimum out; for a launch, exactly one
coin created by the wallet with the generated mint, on the chosen platform, the fee paid once and equal to the quote,
and the first buy (if any) spending what was asked.
