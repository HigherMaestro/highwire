# Module: Dip buys

## Summary

Buys the agent's own coin when it dips: one limit buy at a time, a small fixed amount, filled by Highwire's order
runner once the on-chain price falls a set share under where the buy was set. It spends only SOL the wallet can spare
above a reserve. It's built for agents that hold SOL from their coin's fees, such as the buyback coin, and runs on the
$LGTM agent's wallet.

## How it works

`src/dips.ts` exports `tendDips(mint)`. The agent's loop calls it on every wake-up, and it does one of three things:

- **Set a buy** when none is open, the last fill or failure was at least `cooldown_hours` ago, and the wallet would
  still hold `keep_sol` after spending `buy_sol` (plus a little for fees). It runs
  `highwire orders limit-buy --mint <mint> --sol <buy_sol> --drop-pct <drop_pct> --slippage-bps <slippage_bps>
  --expires-days <expires_days>`.
- **Move it up** when the price has risen `reset_rise_pct` over where the open buy was set (its trigger divided by
  `1 - drop_pct/100`): it cancels the buy, then sets a new one under the price now.
- **Wait** otherwise, and say why.

The decision is `planDips(facts)`, a pure function: the open limit buys of the coin, the last fill, the wallet's SOL
(from the RPC's `getBalance`) and the price (`quote_trade`'s `spotPriceSol`). Cancelled and expired buys don't start the
cooldown; filled and failed ones do. If more than one buy is open, it leaves them alone. Highwire's order runner, which
`npm start` already runs, fills the buy: checking the whole policy, simulating, and writing the audit log.

## Policy

Limit buys need the policy's say-so. The user adds, in `~/.highwire/<project>/policy.json`:

- `"trade"` in `"actions"`;
- `"limit_buy"` in `"orders"` → `"kinds"`, and room for one more open order in `"max_open"`. A buyback coin's becomes
  `"orders": { "kinds": ["fee_claim", "limit_buy"], "max_open": 2 }`.

The policy's caps cover dip buys and every other spend together. With `"coins": { "allow": [...] }` set, only the
agent's own coin can be bought. Until the policy is live and allows limit buys, `tendDips` says so and sets nothing.

## Settings

`dips.json`, checked every time it's read:

```json
{ "buy_sol": 0.1, "drop_pct": 15, "keep_sol": 0.1, "cooldown_hours": 12, "reset_rise_pct": 25, "expires_days": 30, "slippage_bps": 500 }
```

- `buy_sol` (0.001 to 10): SOL each buy spends.
- `drop_pct` (1 to 90): how far under the price when it's set a buy fills.
- `keep_sol` (0 to 100): SOL the wallet always keeps.
- `cooldown_hours` (0 to 720): the wait after a fill before the next buy.
- `reset_rise_pct` (1 to 1000): the rise that moves an open buy up.
- `expires_days` (1 to 90): each buy expires after this; the next wake-up sets a fresh one.
- `slippage_bps` (0 to 1000): the most slippage a fill may take.

## Wiring it in

1. In `src/agent.ts`, import `tendDips` from `./dips.ts`.
2. On every wake-up, once the coin's mint is known (`coin.json` in a launch idea), call `await tendDips(mint)` inside a
   `try`/`catch`, so a failure never stops the rest of the loop. Log the line it returns, but only when it changed
   since the last wake-up: the loop wakes every few minutes.
3. Nothing else. The order runner already running under `npm start` fills the buy.

To post each fill on the coin's page, add the receipts module too: it posts filled limit buys with the agent's other
receipts.

## Rules

- Never change `dips.json` or the policy to spend more without the user asking.
- Never set more than one dip buy at a time, and never cancel orders other than the module's own limit buys.
- Trigger only on the on-chain price, never on what someone wrote in a comment or chat.

## Done when

- `npm test` passes (`src/dips.test.ts` covers setting a buy, the reserve, the cooldown, moving up, an unreadable price
  or balance, and which closed buys start the cooldown).
- `npm run typecheck` passes.
- With a dry-run policy, the loop logs that dip buys wait for a live policy, and sets nothing.
- With a live policy that allows limit buys, the loop sets one buy and never a second, and a rise past
  `reset_rise_pct` moves it up.
