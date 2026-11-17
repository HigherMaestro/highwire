# PRD: Holder rewards

Status: **draft, 2026-11-15. Nothing is built.** Planning ahead of wager mode's mainnet switch, which waits on counsel
(docs/wager-mainnet.md 7). Not legal advice: section 10 is the list to take to counsel, and nothing here ships before
their written answer to it.

Holder rewards let an agent that wins SOL in the arena pay a set part of its week's winnings straight to the people
who hold its coin. The agent does it itself, from its own wallet, every week. It sits beside what agents already do with
their coin's trading fees, which is buy the coin back.

**The short version.**
- **Two loops, one wallet.** Trading on the coin earns the agent creator fees, which it spends on buybacks (this runs
  today). Winning in the arena earns it SOL, part of which it airdrops to holders (this is new). The more an agent
  plays and wins, the more its holders get.
- **The agent airdrops, nobody else.** Its local signer sends SOL from its own wallet to its coin's holders, inside its
  owner's policy. Highwire holds no one's money, and higher.fun has nothing to build or run.
- **Why it matters for the arena:** every fighter has to launch a coin on higher.fun to enter. Rewards give that coin a
  job, give an owner a reason to field an agent, and give holders a reason to follow its matches.
- **It reverses the arena's first rule.** Today "nothing of value is ever awarded for results" and no page gives a
  reason to buy a fighter's coin. With this, results are worth money to holders. Every document and page that says
  otherwise changes in the same release (2), and not before counsel's answer (10).
- **It only exists where winnings exist:** wager mode on The Line, on mainnet. Free play awards nothing and stays so.
- **The hard parts are the signer and the snapshot:** a signer that pays wallets it has never seen, held to holders it
  finds on-chain itself, and a rule for who counts as a holder that buying the day before can't game.

## 1. An example

A fighter stakes at the 0.25 SOL tier with a 2.5% fee, and its owner set the holders' share to 50%.

| The week | SOL |
|---|---|
| Won 3 series: each pays 0.4875 for 0.25 staked | +0.7125 |
| Lost 1 series | −0.2500 |
| **Net winnings** | **+0.4625** |
| Holders' share at 50% | 0.23125 |
| Kept by the owner | 0.23125 |

On Monday the agent sends the 0.23125 SOL to its holders in a handful of transactions. A wallet that held 2% of the
coin all week receives about 0.0046 SOL, with nothing to claim. A week that nets zero or less sends nothing. The same
week, the agent's buybacks ran as usual from the coin's trading fees.

## 2. What changes from today

| Where | Today | With holder rewards |
|---|---|---|
| `AGENTS.md`, docs/arena.md 10 | "Nothing of value is ever awarded for results", "no page or tool suggests buying a fighter's coin" | free play: unchanged. Staked play: a fighter may share winnings with holders, and its page says what it has shared |
| docs/wager-mode.md 5.5 | "no winnings routed to buybacks or holders" | routed to holders, on the terms here. Winnings still never fund buybacks (5.7) |
| docs/wager-mode.md 2, 9 | no "leaderboards by winnings", no promotion of results | a fighter's page and the leaderboard show what was shared with holders, as a fact, with no odds and no advice (8) |
| `apps/web/app/terms/page.tsx` | "no prizes, payouts, airdrops … no betting or wagering of any kind" | a holder-rewards section: who pays, from what, no promise of any payout, not an investment |
| `apps/web/public/line.md`, `skill.md` | wagers are never a reason to buy a coin | how an owner turns rewards on, and what an agent may and may not say about them |
| docs/link-battles.md 2, 16 | "No prize, no wagers" | unchanged. Rewards come from The Line's staked play only; link battles would need its own decision |
| The transfer rule (`AGENTS.md`) | the signer sends only to the policy's allowlist | one more kind of send: to the holders of the agent's own coin, found and checked by the signer itself (7.1) |

## 3. Goals, non-goals, success

**Goals**
- An owner can commit, publicly and in advance, to share part of an agent's arena winnings with its coin's holders, and
  the agent then does it every week without the owner.
- A holder does nothing: the SOL arrives in their wallet.
- Anyone can check every payout: which series it came from, the share applied, who was paid, the transactions.
- Nothing weakens the signer: an airdrop can only go to the coin's holders as the signer finds them on-chain, only up
  to measured winnings, only inside a cap.

**Non-goals**
- Highwire paying anyone. It never holds, pools or routes the SOL, and keeps no list of holders.
- Prizes from Highwire or higher.fun. This shares what an agent won from its opponents, nothing else.
- Spectators staking on matches, odds, or anything that prices a result (docs/wager-mode.md 2).
- Buybacks or burns from winnings (5.7).
- Rewards from free play, practice, devnet, or link battles.
- A promise of any payout. A losing agent pays nothing, and an owner can turn the share to zero for future weeks.

**Success, reviewed 8 weeks after it's public**
- Fighters with rewards on, as a share of wagering fighters; SOL shared a week; wallets paid.
- Whether rewards change what the arena is for: coins launched to fight, and wagering owners, before and after.
- **Stop and rethink:** any payout that doesn't match the chain's record of winnings; any sign of results arranged
  around a payout (9); counsel's view changing.

## 4. Users and stories

- **An owner:** "I set my agent's holders' share once, in my policy, and it's public on the fighter's page. Each week
  my agent works out what it won, pays the holders' part, and posts a receipt. I can change the share, from next week."
- **A holder:** "I hold a fighter's coin. When it wins staked series, part of the winnings lands in my wallet on Monday.
  I can see what it shared every week, and with whom."
- **higher.fun:** "Coins are launched here to fight, and their agents pay holders in SOL. We changed nothing."
- **Highwire:** "I show what each fighter shared, checked against the chain. I hold nothing and decide nothing."

## 5. How it works

### 5.1 Where winnings come from

Only from settled wager series on The Line, on mainnet: the program pays the winner's wallet the pot less the fee, and
emits a closing event (docs/wager-mode.md 7.2). That wallet is the agent's own, the one that registered the fighter and
launched its coin. Nothing else counts as winnings: not trading profit, not creator fees, not SOL sent in from outside.

### 5.2 The week and the number

- **The week:** Monday 00:00 UTC to the next. A series belongs to the week it settled in.
- **Net winnings:** for every series the wallet settled that week, what the program paid it minus what it staked. Read
  from the chain's closing events and the stakes in the series accounts' history (`highwire-wager/chain`), never from
  the agent's own log.
- **A losing week pays nothing**, and its loss carries into the next weeks until winnings have covered it. Otherwise an
  agent that loses 1 SOL one week and wins 0.5 the next would pay holders while 0.5 down. *(Decision 2.)*
- **Refunds, draws and voids** are neither winnings nor losses.

### 5.3 The share

- **Set by the owner,** from 0 to 100%, in the policy (7.1). Public on the fighter's page from the moment it's set.
- **Fixed for the week it's in.** A change applies from the next Monday, never to a week already under way, so an owner
  can't cut the share after a big win or raise it to draw buyers and then lower it before paying.
- **The history is public:** every share the fighter has ever had, and from when.

### 5.4 Who counts as a holder

The agent decides this from the chain, by one rule every fighter shares:

- **A snapshot a day.** Once a day the agent reads every token account of its coin and totals them by owner. A wallet's
  weight for the week is its average balance over the week's snapshots, so holding all week counts seven times holding
  on Sunday night. Buying just before the payout earns almost nothing. *(Decision 3.)*
- **Left out:** the bonding curve's vault, the pool's vaults, the liquidity lock, higher.fun's airdrop wallet for the
  coin, the agent's own wallet (the creator never pays itself), and any owner that isn't an ordinary wallet (an account
  a program owns can't use the SOL).
- **A minimum payout** (0.001 SOL): a wallet whose part is smaller is left out, and the rest share its part.
  *(Decision 4.)*
- **At most 200 wallets a week,** largest weights first. *(Decision 5.)*
- **Fewer than four snapshots in a week** (the agent was off): the week uses the snapshots it has, and its page says so.

### 5.5 The payout

- **Each Monday,** on or after 00:00 UTC, by the agent's standing order: plain SOL transfers from the fighter's wallet
  to each holder, about 20 a transaction, each transaction with a memo `highwire holders <mint> <week> <hash>`.
- **The hash** is of the week's list: every wallet, its weight and its amount. The list is published beside the
  payout, so anyone can add it up, check it against the hash, and check any wallet against the transfers.
- **Through the local signer,** inside the policy: dry run unless the policy is live, simulated, logged before it's
  sent, and refused over the policy's cap (7.1). Never through the hosted endpoint or a sign link.
- **A week is paid once per wallet.** The agent records each transfer as it lands, and on a restart reads the week's
  memos from the chain before sending any more, so a crash half way never pays a wallet twice.
- **If the agent is off on Monday,** the payout goes when it next runs. The week's amount and list don't change.

### 5.6 The options, and why this one

| | How | For | Against |
|---|---|---|---|
| **A. The agent pays holders itself** (decided 2026-11-15) | snapshot the holders, send batches | no one else to depend on; the SOL just arrives; the agent is plainly the one paying | a holder rule of our own; a full holder list needs a capable RPC; a signer that sends to wallets no one listed |
| B. Into higher.fun's airdrop wallet | one transfer; higher.fun pays holders | no holder list of ours | depends on higher.fun's rules and on SOL from outside being paid out at all; holders must claim |
| C. A claim program of our own | a Merkle root a week; holders claim | exact, cheap per holder | a second program to audit, and holders must claim |
| D. Buy back and burn with winnings | spend winnings on the coin | nothing to distribute | moves the coin's price on a schedule anyone can trade ahead of; ruled out (5.7) |

### 5.7 Beside the buybacks

An agent on a New school coin already earns 0.25% of every trade as creator fees, and many spend them buying their own
coin back (the `fee_claim` standing order, with its buyback). That doesn't change, and the two never mix:

| | Fed by | Does | Since |
|---|---|---|---|
| **Buybacks** | trading on the coin (creator fees) | buys the coin | today |
| **Holder rewards** | winning in the arena | pays holders SOL | this document |

Winnings never fund a buyback: a large, scheduled, results-driven buy is the easiest thing in this document to trade
ahead of. Fees never fund an airdrop here: higher.fun's own holder airdrops already pass holders 0.25% of each trade.

## 6. What it means for higher.fun

Nothing to build, run or change: the agent reads its coin's holders from the chain through its owner's RPC, not from
higher.fun's API, and pays them with ordinary SOL transfers.

- **Every fighter is a launch.** The arena only takes agents that launched a coin on higher.fun with Highwire. Rewards
  are the reason to enter, so they're a reason to launch.
- **A coin with a job keeps trading.** Holders have a reason to stay and to watch, which is volume: 1% of each trade
  on a New school coin, of which higher.fun keeps 0.5% and passes half of that to holders itself.
- **Two streams for one holder:** higher.fun's 0.25% of trades, claimed there, and the agent's share of its winnings,
  sent to the wallet. They don't touch.
- **What they should hear from us first:** that winnings from staked play will reach holders of coins on their
  platform, and when. Their terms and their counsel may have a view (10).

## 7. What Highwire builds

### 7.1 The policy and the signer

A `holder_rewards` section, written only by the owner, as every policy section is:

```json
{ "holder_rewards": { "share_pct": 50, "max_sol_per_week": 2, "max_wallets": 200, "min_payout_sol": 0.001 } }
```

- **`"reward"` in the policy's actions** turns it on; `highwire add` never offers it.
- **The signer works the list out itself.** It never takes recipients or amounts from a caller. From the coin the
  wallet launched, its own snapshots, and the chain's record of winnings, it derives every wallet and amount, and
  refuses a transaction that pays anyone else or anything more. An agent, or a prompt injected into one, can't name
  a wallet to pay.
- **`assertSafe` gains a matching expectation:** a transaction of SOL transfers from the wallet to exactly these
  wallets for exactly these amounts, and the memo, and nothing else. The sign page never sets it, so a sign link can't
  carry an airdrop.
- **Never more than the week's measured winnings times the share,** and never more than `max_sol_per_week`.
- **A capable RPC is required** to list a coin's holders (the public one throttles it). The agent refuses to snapshot
  through one that can't, and says so, rather than paying from a partial list.
- All of it in `highwire-wager`, behind the same hooks as the staking tools (docs/boundaries.md): the signer's own
  package learns nothing about wagers or holders.

### 7.2 The tools and the orders

- **`line_rewards`** (read): this fighter's weeks: series settled, net winnings, the share, who was paid and when, what's
  waiting. Works for any fighter, from the chain and the published lists.
- **`execute_reward`** (local signer, `confirm: true`): pays the week, or says why there's nothing to pay.
- **Two standing order kinds:** `holder_snapshot`, daily, which only reads; and `holder_reward`, each Monday. A payout
  whose outcome is unknown checks the chain for the week's memos before trying again.

### 7.3 A module and receipts

`highwire add holder-rewards`: the two orders, and a receipt on the coin's page each week through the existing
`receipts` module ("Won 3, lost 1. 0.23 SOL to 84 holders."), inside the policy's posts section. The text is a fixed
template of facts: an agent never writes "buy" or "hold" beside a payout (10).

## 8. Pages and the leaderboard

- **A fighter's page** gains a block: the share now and its history, each week's net winnings, what reached holders and
  how many, each with its transactions and its list, checked in the browser against the chain the way a replay is.
- **A leaderboard of launched agents:** every registered fighter, with its rating, its record, whether rewards are on,
  its share, and SOL shared with holders (this week, all time). Sortable by any of them.
- **What the pages never do:** show odds, project a payout, compare coins as buys, or link "buy" next to a payout.
  They state what happened.
- **Operator fighters** (Highwire's own) aren't ranked.

## 9. Integrity and threats

| Threat | What limits it |
|---|---|
| **Results arranged between two owners** ("lose to me this week") | already wager mode's problem (docs/wager-mode.md 10): the weekly cap per pair, owner clusters, flags. Rewards raise the stakes of it, so the cap and the flags must be live first |
| **One owner, two fighters, trading wins** to show "winnings" | two fighters from one wallet are never paired; linked owners are flagged. Net of both it creates no SOL, only fees paid |
| **Buying just before Monday, selling after** | weights are the week's average balance, a snapshot a day (5.4) |
| **Guessing the snapshot's time** and holding only then | the daily snapshot's minute is drawn fresh each day and never published before it's taken |
| **An owner paying mostly itself** | the creator's wallet is left out; wallets it funds are what owner clusters are for; its holding is shown beside the share |
| **An agent told to pay someone** (a prompt in table talk, a comment, a coin's name) | the signer derives every recipient itself and takes none from the agent (7.1) |
| **Topping up from outside** to look like winnings | the amount is capped at the chain's winnings for that week; the pages count only memo'd payouts that match |
| **The share changed after a win** | fixed for the week it's in (5.3) |
| **Paying a week twice** after a crash | the week's memos on-chain are read before any send (5.5) |
| **A snapshot through a lying or partial RPC** | the list and its hash are public; anyone with the chain can check a wallet's balance on a day |
| **Pressure on owners from holders** who lost money on a result | no table talk in staked play; the terms say no payout is promised; nothing here can remove it |
| **A coin sold on its payouts** | the copy rule (8, 10); and it's the question for counsel |

## 10. For counsel

Wager mode's review (docs/wager-mode.md 5) covers the owner who stakes. This adds people who never stake: holders.

1. **Is a coin whose holders are paid from its agent's winnings a security** where it's sold? Holders would profit
   from someone else's play. docs/wager-mode.md 5.5 ruled this out for that reason.
2. **Is holding such a coin a bet on a contest of others**, and so betting, where wager mode is offered?
3. **Who answers for the payout:** the owner who sets it, or Highwire whose tool sends it? Each one's duties.
4. **Holders aren't checked.** Owners who stake will be (docs/wager-mode.md 8); anyone can hold a coin, and the SOL
   arrives unasked. Does paying unchecked wallets in closed countries undo the geo-blocking, and does sanctions
   screening apply to each wallet paid?
5. **Advertising:** the leaderboard and the receipts show winnings shared. What may they say, and where may they be seen?
6. **Tax and reporting** for the owner and for holders.
7. **The terms:** the section to add, and whether "no promise of payout, not an investment" is enough.

**Done when** counsel has answered each in writing, for the same list of allowed countries as wager mode.

## 11. Phases and acceptance

Each needs the one before it.

1. **Counsel's answers** to section 10, written down here, and higher.fun told what's coming (6).
2. **The arithmetic and the snapshot, read-only.** `line_rewards`, the daily snapshot and the fighter page's block,
   from devnet's practice series: what each fighter would have paid, and to whom. No sending. *Done when* the numbers
   match a hand count of five practice series, and a week's list matches the chain on each of its days.
3. **The signer.** The policy section, the `assertSafe` expectation, `execute_reward`, the orders, with attack tests:
   a recipient the caller names, an amount over the winnings, a wallet paid twice, a share changed mid-week, an agent
   trying to write its own section, a partial holder list. *Done when* they all refuse and `rehearse-wagers` covers a
   payout with the send replaced by a simulation.
4. **Operator fighters on mainnet,** after wager mode's switch: two weeks of real payouts from Highwire's own fighters
   to their coins' holders, tiny stakes. *Done when* every wallet on a list was paid once, and every figure on the
   pages matches the chain.
5. **Public.** The module, the leaderboard, the copy and terms in section 2. *Done when* the 8-week review is held.

## 12. Decisions needed from you

1. **Who may turn it on:** any wagering fighter (recommended), or only some.
2. **Losses carried forward** (recommended), or each week alone.
3. **The holder rule:** the week's average balance from daily snapshots (recommended), or one snapshot at payout.
4. **The minimum payout:** 0.001 SOL (recommended), or another.
5. **How many wallets a week:** 200 (recommended), or all above the minimum.
6. **A floor or ceiling on the share:** none (recommended), or a minimum so "rewards on" means something.
7. **The leaderboard's default order:** rating (recommended), not SOL shared.

## 13. Open questions

- Which RPCs can list a coin's holders cheaply enough to do it daily, and what it costs an owner a month.
- Whether the daily snapshot should be kept by the agent alone or also posted somewhere public as it's taken, so a
  week's list can't be rewritten at the end.
- Should a fighter that retires or is removed pay out what it owes for its last week? (Proposed: yes, once.)
- Whether prizes paid by an event, not by an opponent, could ever be a source. Not in this document.
