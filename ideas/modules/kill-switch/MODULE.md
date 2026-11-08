# Module: Kill switch

## Summary

A second pair of eyes on the agent's wallet. The policy caps what the agent may do; the kill switch catches what the
caps don't, and stops everything by creating Highwire's STOP file. While STOP exists, Highwire signs nothing: no
trades, claims, order fills or posts. Only the user deletes it, after looking. Every agent that runs live should have
one.

## How it works

`src/kill-switch.ts` exports `checkKillSwitch()`, which the loop calls first on every wake-up. While the policy is live,
it reads the wallet's balance (`getBalance`), Highwire's audit log (`~/.highwire/<project>/audit.jsonl`), and the
wallet's recent transactions on-chain (`getSignaturesForAddress`, then `getTransaction` for any it hasn't seen), and
stops the agent when:

- **The wallet signed a transaction Highwire didn't send**: one whose signature isn't in the audit log. Highwire logs
  every send before it goes out, so this means the key signed somewhere else. Incoming transfers don't count; the
  wallet didn't sign them.
- **It spends too fast**: more than `max_sol_per_hour` sent in the last hour.
- **Sends keep failing**: `max_failed_per_day` failed sends in the last day.
- **The policy keeps saying no**: `max_refused_per_hour` refusals of the agent's own calls in an hour, a sign it's
  trying things it shouldn't. The order runner's retries of a refused fill don't count: that's the policy working.
- **The wallet is nearly empty**: under `min_balance_sol`.

The decision is `checkKill(facts)`, a pure function. Stopping writes the STOP file with every reason in it, shows a
notification on a Mac, and records the stop in `kill-switch-state.json` next to the wallet. An RPC that doesn't answer
never stops anything. When the user deletes STOP, it counts afresh from then, so the same old failures don't stop it
again. `npm run kill-switch` runs one check by hand.

## Policy

Nothing. The kill switch only reads, and only ever narrows what the agent can do.

## Settings

`kill-switch.json`, checked every time it's read:

```json
{ "min_balance_sol": 0.02, "max_sol_per_hour": 0.5, "max_failed_per_day": 3, "max_refused_per_hour": 5, "foreign_signatures": true }
```

- `min_balance_sol` (0 to 100): set it under any reserve the agent keeps on purpose.
- `max_sol_per_hour` (0.001 to 1000): above the most one wake-up's work spends, under the policy's daily cap.
- `max_failed_per_day` (1 to 100).
- `max_refused_per_hour` (1 to 1000).
- `foreign_signatures` (true or false): leave it on unless the wallet is shared with another app on purpose.

## Wiring it in

1. In `src/agent.ts`, import `checkKillSwitch` from `./kill-switch.ts`.
2. Call `await checkKillSwitch()` first on every wake-up, inside a `try`/`catch`, and log its `line` when it changed
   since the last wake-up.
3. If it returns `stopped: true`, skip the rest of that wake-up.

## Rules

- Never delete STOP, and never write code that does. Resuming is the user's step.
- Never loosen `kill-switch.json` without the user asking.
- When it stops the agent for a transaction Highwire didn't send, tell the user plainly: if that wasn't them, someone
  else may have the key, and STOP doesn't stop them. They should move what's left to a wallet only they control.

## Done when

- `npm test` passes (`src/kill-switch.test.ts` covers each reason, older entries not counting, the order runner's
  refusals not counting, and a fresh count after STOP is deleted).
- `npm run typecheck` passes.
- With a dry-run policy, `npm run kill-switch` says it watches once the policy is live.
