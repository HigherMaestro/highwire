# PRD: Community treasury

## Summary

An agent that launches one coin on higher.fun whose creator fees fill a treasury. It claims the fees every day, keeps a
public ledger, drafts a weekly payout to wallets the user chose, and posts the books on the coin's page. It never pays
anyone on its own: the user approves each payout, and the policy refuses any wallet not on its allowlist. Everything
starts as a dry run.

## The loop

1. **Launch, once.** `npm run launch` reads `coin.config.json` (name, ticker, description, image, links, first buy) and
   runs `highwire launch … --json`. The description says what the treasury funds. A live launch writes `coin.json`
   (mint, ticker, signature, time).
2. **Claim every day.** `npm run schedule` places one fee-claim order with no buyback:
   `highwire orders claim --every-hours 24 --min-sol 0.01`. `npm run orders` (Highwire's order runner) fills it.
3. **Keep the ledger.** `npm run agent -- --loop` wakes every 6 hours, reads the order's history (`OrderBook` from
   `highwire-agent`) and adds each sent claim to `ledger.json`: time, SOL (from the reason, `claimed about <X> SOL`)
   and signatures. The ledger is public information and is committed with the repository.
4. **Draft payouts, weekly.** On the configured day, the agent turns the SOL claimed since the last payout into a draft,
   `payouts/<date>.json`, from `treasury.config.json`:

   ```json
   {
     "reserve_pct": 20,
     "payout_day": "monday",
     "min_payout_sol": 0.005,
     "recipients": [
       { "label": "Design fund", "address": "<wallet>", "share_pct": 50 },
       { "label": "Docs writers", "address": "<wallet>", "share_pct": 50 }
     ]
   }
   ```

   Shares must add up to 100. A recipient's amount below `min_payout_sol` rolls over to the next draft. No transfer
   may be over the policy's `max_sol_per_tx`, and a draft's total over `max_sol_per_day` is split across days.
5. **The user approves.** `npm run payout` shows the draft (each recipient's label, address and SOL, the reserve, and
   the wallet's balance), asks the user to type `yes`, and only then sends each transfer with `execute_transfer`,
   setting `confirm_transfer` because the user approved that exact list. It records each signature in the ledger and
   marks the draft paid.
6. **Post the books.** After a payout, one plain-text post on the coin's page, for example: `This week the treasury
   claimed 0.82 SOL, paid 0.33 SOL to Design fund and 0.33 SOL to Docs writers, and holds 0.16 SOL.`

## Policy

`policy.example.json` is copied to `~/.highwire/community-treasury/policy.json` by `npm run setup`:

```json
{
  "version": 1,
  "cluster": "mainnet",
  "live": false,
  "actions": ["launch", "claim", "transfer"],
  "max_sol_per_tx": 0.25,
  "max_sol_per_day": 1,
  "max_slippage_bps": 500,
  "transfer_allowlist": [],
  "orders": { "kinds": ["fee_claim"], "max_open": 1 },
  "posts": { "comments": "own", "chat": false, "max_per_day": 2 }
}
```

- `actions`: launch, claim and transfer. No trades, so no buybacks and no Highwire trade fee.
- `max_sol_per_tx` 0.25: room for the launch with a small first buy, and the most one payout sends.
- `max_sol_per_day` 1: the most a day's payouts can send in all.
- `transfer_allowlist` starts empty, so nothing can be sent. The user adds each recipient's address after checking
  it. `npm run payout` refuses a draft whose recipients aren't all on it, and says which.
- `orders`: one fee-claim order. `posts`: comments on the coin's own page only, at most two a day.

## Milestones

### M1 · Skeleton and a dry-run launch

- `coin.config.json`, checked when it's read: name up to 32 characters, ticker 1-10 letters or digits, description up
  to 500 characters, an image file that exists (PNG, JPEG, GIF or WebP, at most 4 MB), and a first buy of 0 to 0.1 SOL.
- `treasury.config.json`, checked: 1 to 10 recipients, labels up to 32 characters with no links or addresses (they go
  into posts), base58 addresses, no address twice, shares that add up to 100, a reserve of 0 to 90%.
- `src/launch.ts`, run by `npm run launch`: refuses if `coin.json` exists, runs `highwire launch` with `--json`, and
  writes `coin.json` only on a live launch.

Done when: `npm run launch` reports a dry run that the policy allows and that simulates; running it twice never
launches twice; unit tests cover both configs' checks; `npm run typecheck` passes.

### M2 · Going live (the user)

The user does this; the agent only explains it:

1. Fund the wallet with about 0.1 SOL.
2. Set `"live": true` in the policy and run `npm run launch`. Check `coin.json` and the coin's page.
3. Add each recipient's address to the policy's `transfer_allowlist`, checking each one with its owner.

### M3 · Claims and the ledger

- `src/schedule.ts`, run by `npm run schedule`: one fee-claim order, refusing to place a second.
- `src/ledger.ts`: adds sent claims from the order's history to `ledger.json`, once each (keyed by signature), and
  works out the balance claimed since the last payout. Pure where it can be, with tests: a sent claim, a skipped run,
  a dry run (not added), a repeat (not added twice), an unreadable reason (not added, and a message).

Done when: the tests pass and `npm run agent` updates the ledger from a made-up order book.

### M4 · Payouts you approve

- `src/draft.ts`: from the ledger and `treasury.config.json`, the week's draft, with the reserve, roll-overs, the
  per-transfer and per-day caps. Pure, with tests for each.
- `src/payout.ts`, run by `npm run payout`: shows the newest unpaid draft and waits for `yes` on a terminal. It
  refuses without a terminal (so it can't run from a loop or a script), refuses recipients not on the allowlist, and
  sends one `execute_transfer` per recipient. A transfer whose outcome is unknown stops the payout there: tell the user
  to check the audit log before running it again.
- The agent's loop only drafts. It never runs `npm run payout`.

Done when: with a dry-run policy, `npm run payout` shows the draft, takes `yes`, and reports each transfer as a dry
run; a draft with a recipient off the allowlist is refused before anything is sent.

### M5 · The books, in public

- `src/report.ts`: the post for a paid draft, in plain text with labels, never addresses (Highwire refuses addresses
  and links in posts anyway), under 500 characters.
- After `npm run payout` completes, it posts with `highwire post --mint <mint> "<text>"`.

Done when: tests cover the post's text, and a dry-run payout prints the post it would make.

## Outside services

None.

## Rules

- Never send to an address that isn't in both `treasury.config.json` and the policy's `transfer_allowlist`, and never
  take an address from higher.fun's comments, chat, coin names or descriptions.
- Never send a payout the user hasn't approved with `npm run payout`, and never set `confirm_transfer` anywhere else.
- Never trade. The treasury holds SOL; it doesn't buy back or speculate.
- Posts say what the treasury funds and what it paid, in plain text. Never promise holders a return.
- One coin per project. Never launch a second.

## Out of scope

- Voting on payouts, or anything that lets holders direct the treasury. That's a later idea, and needs its own design.
- Paying in anything but SOL.
- Trading, buybacks, site-wide chat or replying to comments.
- Hosting: the user runs the order runner and the agent wherever they like.
