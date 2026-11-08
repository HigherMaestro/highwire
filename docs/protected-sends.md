# Protected sends

Status: built (unreleased). Owner: the local signer (`highwire-agent`) and the transaction builders (`highwire-core`).

## Why

An agent running live sends its trades through a public RPC. Two things can go wrong that have nothing to do with the
agent's judgement:

- **It gets sandwiched.** A buy sits in the open for a slot or two; a bot buys in front of it and sells into it, and the
  agent fills at the worst price its slippage allows. The dip buyer and the buyback coin buy small amounts on a
  schedule, which makes them easy to spot.
- **A failed send still costs.** A trade that fails on-chain (the price moved past the minimum out) pays its network and
  priority fees anyway, and the agent learns nothing until it confirms.

And one flow has a gap of its own: a fee-claim order claims, then buys back, as two transactions. If the claim lands and
the buy fails or is never answered, the order is left half done, and the runner closes it rather than risk a second
buy.

Protected sends fix the first two by sending through Jito's block engine as a single-transaction bundle, and the third
by putting the claim and the buyback in one transaction.

## What it is not

Not a sniper. Highwire doesn't race other people's transactions: it never reads another wallet's pending transaction,
never aims for the same block as a launch, never bundles around anyone else's trade, and keeps its triggers as they are
(standing orders fire on a fresh on-chain quote, never on a feed message). The only thing that changes is how the
agent's own, already-allowed transaction reaches a validator.

Also out of scope for this version: multi-transaction bundles, tips on the hosted endpoint or in sign links, devnet
(Jito has no devnet block engine), and private-mempool routes other than Jito's.

## How Jito's route works

From Jito's docs ([low-latency transaction send](https://docs.jito.wtf/lowlatencytxnsend/)):

- `sendTransaction` with `bundleOnly=true` sends one transaction as a one-transaction bundle. A bundle lands whole or
  not at all; one that would fail is dropped, and pays nothing.
- A bundle pays a tip: a SOL transfer of at least 1,000 lamports to one of eight tip accounts (`getTipAccounts`). Jito
  recommends the tip inside the main transaction, not a separate tipping transaction, which can be split off in an
  uncled block. Tip accounts must not come from an address lookup table.
- Any instruction that carries a read-only account whose address starts with `jitodontfront` (it needn't exist) makes
  the block engine refuse any bundle that puts something in front of the transaction. Jito says this helps rather than
  guarantees, and only on its own route.
- The default rate limit is one request a second per IP, per region. Tips only count with leaders running Jito-Solana,
  so a bundle may wait a slot or two for one.

## The policy

A new optional `send` section. Without it, nothing changes: sends go through `SOLANA_RPC_URL` as now. Like the rest of
the policy, only the user writes it; no tool can.

```json
"send": {
  "route": "jito",
  "max_tip_sol": 0.0005,
  "fallback": "none"
}
```

| Key | Meaning |
|---|---|
| `route` | `rpc` (today's behaviour) or `jito`. `jito` is mainnet only: on a devnet policy it's refused when the policy loads, not when a trade sends. It covers trades and claims, the sends worth front-running; launches and transfers always go the ordinary way, without a tip |
| `max_tip_sol` | The most one transaction may tip. At most 0.01 SOL (the schema's cap), at least 0.000001 (Jito's 1,000-lamport minimum) |
| `fallback` | `none` (default): if the block engine refuses or doesn't answer, nothing is sent. `rpc`: send it the ordinary way instead, which gives up the protection for that send. Never silent: the result and the audit line say which route it took |

`policy init` doesn't add the section; the README, the docs page's policy table and skill.md say how to. A launch policy
from `policy init --launch` doesn't need it: launches and claims aren't sandwich targets.

The tip counts against `max_sol_per_tx` and `max_sol_per_day` like any other spend. It already would: the signer
charges what the simulation shows leaving the wallet, and the tip is part of that. `max_tip_sol` sits inside the
existing 0.03 SOL rent-and-fee allowance, so no policy that works today stops working.

## Building with a tip

The tip is part of the transaction the builder makes, so it goes through `finish()` and the safety checks like every
other instruction; the signer never edits built bytes.

- `finish()` takes an optional `jito: { tipLamports, tipAccount }`. It adds one System transfer of `tipLamports` from the
  wallet to `tipAccount`, just before the `highwire` memo (after Highwire's trade fee, where there is one), with the tip
  account as a static key, never from a lookup table. On that same transfer it adds `jitodontfront1111…` (a fixed
  address in `constants.ts`) as a read-only, non-signer account. The System program ignores accounts past the two a
  transfer needs; the first rehearsal on mainnet confirms it (open question 1).
- `decode.ts` describes it: "Tip Jito's block engine: 0.00012 SOL to <tip account>" and "Protected from being
  front-run on Jito's route".
- `assertSafe` gains an expectation, `jitoTip: { maxLamports }`. With it: exactly one transfer to an address in
  `JITO_TIP_ACCOUNTS` (the eight, in `constants.ts`), at most `maxLamports` and at least 1,000, as a static key; the
  `jitodontfront` key only on that instruction, read-only. Without it, any transfer to a tip account, or any
  `jitodontfront` key, fails, which is what every build tool and the sign page see.
- The sign page keeps refusing tips: a sign link can come from anyone, and the user's wallet sends its own way. This is
  the local signer's alone, like transfers.
- `attacks.test.ts` gains the links that must fail: a tip to a non-tip account, two tips, a tip over the cap, a tip
  account from a lookup table, the `jitodontfront` key on a swap instruction, and any tip in a sign link.

**Tip size.** The signer asks Jito's tip floor (`https://bundles.jito.wtf/api/v1/bundles/tip_floor`) for the recent
50th percentile and tips 1.2 times it, rounded up to whole lamports, between 1,000 lamports and `max_tip_sol`. If the
floor doesn't answer, it tips `max_tip_sol / 4`. The figure is logged with the send. A fixed tip in the policy is a
possible later option; the floor keeps a quiet day cheap.

**Tip accounts.** The eight addresses are constants, as Jito says they don't change. On its first Jito send in a
process the signer calls `getTipAccounts` and refuses to send if the block engine's list doesn't match the constants,
the same way it checks the RPC's genesis hash against the policy's cluster.

## Sending

`LocalSigner.execute()` keeps every step it has: the policy check, the lock, the fresh simulation (now with the tip in
it), the spend checks, the audit line written before the send. Only the send itself changes, with `route: "jito"`:

1. POST the signed transaction, base64, to `${HIGHWIRE_JITO_URL ?? "https://mainnet.block-engine.jito.wtf"}/api/v1/transactions?bundleOnly=true`.
   The answer is the signature; the bundle id comes in the `x-bundle-id` header.
2. Confirm by signature on the user's own RPC, as now, until the transaction's `lastValidBlockHeight`.
3. If it never shows up and the blockhash has expired, it didn't land and can't: a bundle-only transaction is never in
   the public queue, and an expired blockhash can't be resent. The result says `expired`, nothing was spent, and the
   audit log records it as `not_landed` with the bundle id, so the daily count gives the spend back.

Step 3 is the one real change in behaviour. Today an unanswered send is treated as possibly landed, and an order closes
rather than risk a second fill. With a bundle-only send whose blockhash has passed, the runner knows it didn't land, so
a standing order can wait for its next run instead of closing. The runner only takes that path when the result says
`expired` and the route was `jito`; every other unknown outcome closes the order as today.

The audit line for a send gains `route`, `tip` (lamports) and `bundle`. `get_signer_status` shows the policy's route and
the last tip paid.

## Claim and buy back in one transaction

Separately from the route, a fee-claim order with `buyback_pct` builds one transaction instead of two:
`buildClaimAndBuy(chain, { wallet, mint, buybackPct, slippageBps })`.

- It reads what's waiting for the coin's creator (the curve vault, and the coin's own pool once it's graduated), works
  out the buy as `buyback_pct` of that, and puts the claims, the buy, Highwire's trade fee on the buy, and the memo in
  one transaction. If the buy would fail, the claim doesn't happen either; nothing is half done.
- It claims the curve vault and only the coin's own pool. The curve vault is one per creator across every LaunchLab
  launchpad, so a vault claim can bring in more than this coin earned; the buy is `buyback_pct` of what the claim
  collects as read before the build (as the two-step run does), never of what lands.
- The order's history records it as a `claim` and a `buyback` with the same signature, in the same words as the
  two-step run, so the idea templates and the receipts module read it unchanged.
- `assertSafe` checks it as a claim and a trade together: the claim instructions `claim.ts` already makes, one trade in
  the coin, one fee, nothing else.
- With `route: "jito"` it goes as one protected bundle; with `rpc` it's still one transaction, still all or nothing.
- If it doesn't fit in one transaction (open question 2), the runner keeps today's two-step run for that coin and says
  why in the order's last result.

`execute_claim` gains an optional `buyback_pct` that does the same for an agent claiming by hand. The policy needs
`claim` and `trade` in `actions`, as a fee-claim order with a buyback does today.

## Testing

As everything else: by simulation only, never a send.

- Unit tests, with a fake connection and a fake block engine (a local HTTP server that answers `sendTransaction`,
  `getTipAccounts` and nothing else): the route and fallback rules, `expired` after the blockhash passes, the audit
  fields, a mismatched tip-account list refusing, a 429 from the engine with `fallback: none` sending nothing.
- `assertSafe` and `attacks.test.ts`, as above.
- `npm run simulate`: a buy with a tip and the `jitodontfront` key, and a claim-and-buy, built and simulated on mainnet
  as a public wallet with `sigVerify: false`. This answers open questions 1 and 2.
- `npm run rehearse -w highwire-mcp`: the execute tools with `route: "jito"`, with the send replaced by a simulation of
  the signed bytes, as now. The block engine is never called.

## Docs and release

The policy key in the docs page's table, the README's local-signer section and skill.md; the CHANGELOG; and the buyback
coin and dip buyer ideas' PRDs, which suggest `route: "jito"` in a comment, not in their starting policy (a template's
policy keeps only what it needs, and protected sends are a choice for the user once they're live).

## What the build settled

1. **The `jitodontfront` key on the tip transfer works.** A tipped pool buy with the key on its tip simulates on mainnet
   (`npm run simulate`, 2026-11-08: 994 bytes, 30,428 CU).
2. **A claim and a buy fit one transaction, tip included, with no lookup table:** 1,143 bytes for a graduated coin's
   vault claim, pool collect and pool buy, and 1,155 for a curve coin's vault claim and curve buy (of 1,232). If one
   ever doesn't fit, the runner claims and buys separately, as before.
3. **The tip floor stays.** On a quiet day it tipped 7,264 lamports (the rehearsal, 2026-11-08). A dry run doesn't call
   Jito at all: it tips a quarter of `max_tip_sol` on paper. A live one checks the tip accounts once per process.
4. **Still left out: tips in sign links.** A wallet that sends its own way would ignore the route, so a tip there would
   buy nothing.
5. **For release:** the buyback coin and dip buyer PRDs can suggest `"send": {"route": "jito"}` once the templates pin
   the release that has it.
