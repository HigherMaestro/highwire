# Unsigned transactions

What `build_trade`, `build_launch` and `build_claim_creator_fees` return, for wallets, agents and the sign page at
highwire.fun/sign. Format version: `highwire.unsigned-tx/v1`.

Highwire never signs for the user and never holds the user's key. It builds Solana v0 transactions with the user's
wallet as fee payer, checks and simulates them, and hands them over. The user's wallet signs and sends.

## The envelope

A build tool's result carries the envelope under `unsigned`, a `sign_url` for it (see [Sign links](#sign-links)), and
tool-specific fields (the quote, the launch's mint and fee, what can be claimed).

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
        "7. Close token account 4Vkq…, returning its SOL to H4dx…",
        "8. Tags the transaction as built by Highwire (memo \"highwire\")"
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

## Sign links

Every build result has `sign_url`:

```
https://highwire.fun/sign#<payload>
```

- The payload is the envelope as compact JSON (`JSON.stringify`, no whitespace), UTF-8, then base64url without
  padding (RFC 4648 §5).
- If that would make the URL longer than 8,000 characters, the payload is instead `gz.` followed by the base64url of
  the gzipped JSON. Base64url has no `.`, so the prefix can't be mistaken for a plain payload. A buy is about 4,600
  characters and a launch with a first buy and a creator lock about 7,500, so in practice only large claims are
  gzipped.
- The envelope is in the fragment, which browsers never send to a server.
- `HIGHWIRE_SITE_URL` changes the origin, for a local site (`http://localhost:3000`).

`highwire-core` (and `highwire-core/browser`) has `signUrl(envelope, siteUrl?)`, `encodeSignPayload(envelope, {compress})`
and `decodeSignPayload(fragment)`. Decoding checks the envelope's shape (format, cluster, kind, addresses, at most 8
transactions in order) and refuses payloads over 64 KiB or envelopes over 256 KiB once decompressed. It doesn't say the
transactions are safe; the review below does.

## The sign page

highwire.fun/sign is a static page; all of this runs in the browser:

1. It decodes the fragment and never sends it anywhere. Its Content-Security-Policy only lets it connect to the Solana
   RPCs (`NEXT_PUBLIC_SOLANA_RPC_URL` for mainnet, `NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL` for devnet, by default the
   public endpoints), picked by the envelope's `cluster`.
2. It reviews each transaction from its bytes with `reviewEnvelope` (`packages/core/src/tx/review.ts`): it rebuilds the
   summary from the instructions instead of trusting `summary`, and applies the allow-list below, with LaunchLab
   platforms pinned to higher.fun's and a launch fee allowed only to the fee wallet it reads from the New school
   platform config on-chain. The wallet's signature slot must be empty and every other signer presigned.
3. It shows what is spent and received, the network and priority fees, the fee payer, the expiry, and every
   transaction in order, and simulates each one (`sigVerify: false`, its own blockhash, so an expired one fails) with
   the wallet's balance before and after.
4. It connects a Wallet Standard wallet and signs only with the fee payer's account. A transaction with a presigned
   mint goes through `solana:signTransaction`, the page checks the message came back unchanged with the mint's
   signature in place, and sends it; others go through `solana:signAndSendTransaction`. Then it polls
   `getSignatureStatuses` until confirmed and links to Solscan and the coin on higher.fun.

It refuses to sign when any check fails, the blockhash has expired ("ask your agent to rebuild it"), the simulation
fails, or the connected account isn't the fee payer.

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
| SPL Memo v2 (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) | one memo, exactly `highwire`, with no accounts. Every built transaction carries it as its last instruction, to attribute it to Highwire |
| System | transfers from the wallet into its own token accounts; one launch fee to the fee wallet recorded on-chain, at most the quoted amount; creating the wallet's own token accounts |
| Associated Token | open a token account owned and paid for by the wallet |
| Token | sync native, initialise the wallet's own account, close an account to the wallet |
| Raydium LaunchLab | `initialize_v2` (creator = wallet, on the chosen fee mode's platform config), `buy_exact_in` and `sell_exact_in` (on the coin's higher.fun platform), `create_vesting_account` (the creator lock, to the wallet, on the new coin's pool), `claim_creator_fee` (into the wallet's own account) |
| Raydium CPMM | `swap_base_input` and `collect_creator_fee`, for the wallet, on higher.fun's fee tier, into the wallet's own accounts |

Then the tool checks the intent: one trade of the quoted kind, coin, amount and minimum out; for a launch, exactly one
coin created by the wallet with the generated mint, on the chosen platform, the fee paid once and equal to the quote,
and the first buy (if any) spending what was asked.
