# PRD: Holder rewards

Status: **draft, 2026-11-15. Nothing is built.** Planning ahead of wager mode's mainnet switch, which waits on counsel
(docs/wager-mainnet.md 7). Not legal advice: section 10 is the list to take to counsel, and nothing here ships before
their written answer to it.

Holder rewards let an agent that wins SOL in the arena share a set part of its week's winnings with the people who hold
its coin. The agent sends that part to its coin's holder-airdrop wallet on higher.fun, and higher.fun's own airdrops
carry it to holders. It gives a coin a reason to exist beyond its launch, an agent's owner a reason to enter it, and a
holder a reason to follow its matches.

**The short version.**
- **What it is:** each week, a fighter's net SOL winnings from staked play, times a share its owner set in advance,
  sent in one transaction to the coin's airdrop wallet on higher.fun. Holders claim it there, as they claim the
  0.25% of trades higher.fun already passes them.
- **Highwire holds no one's money and keeps no list of holders.** The agent's own local signer sends, inside its
  owner's policy. higher.fun's system decides who the holders are and pays them.
- **It needs higher.fun.** Three things only they can confirm or provide (6): that SOL arriving in an airdrop wallet from
  outside is paid out like their own; how they decide a holder's share; and a way to prove a wallet is a coin's.
- **It reverses the arena's first rule.** Today "nothing of value is ever awarded for results" and no page gives a
  reason to buy a fighter's coin. With this, results are worth money to holders. Every document and page that says
  otherwise changes in the same release (2), and not before counsel's answer (10).
- **It only exists where winnings exist:** wager mode on The Line, on mainnet. Free play awards nothing and stays so.
- **The work is small.** A policy section, one tool, a weekly standing order, the week's arithmetic read from the
  chain, and the pages. No new program, and nothing for an auditor beyond the client.

## 1. An example

A fighter stakes at the 0.25 SOL tier with a 2.5% fee, and its owner set the holders' share to 50%.

| The week | SOL |
|---|---|
| Won 3 series: each pays 0.4875 for 0.25 staked | +0.7125 |
| Lost 1 series | −0.2500 |
| **Net winnings** | **+0.4625** |
| Holders' share at 50% | 0.23125 |
| Kept by the owner | 0.23125 |

On Monday the agent sends 0.23125 SOL to its coin's airdrop wallet with a memo naming the week. A holder with 2% of
the coin, by higher.fun's count, can claim about 0.0046 SOL of it. A week that nets zero or less sends nothing.

## 2. What changes from today

| Where | Today | With holder rewards |
|---|---|---|
| `AGENTS.md`, docs/arena.md 10 | "Nothing of value is ever awarded for results", "no page or tool suggests buying a fighter's coin" | free play: unchanged. Staked play: a fighter may share winnings with holders, and its page says what it has shared |
| docs/wager-mode.md 5.5 | "no winnings routed to buybacks or holders" | routed to holders, on the terms here; buybacks still no (5.6) |
| docs/wager-mode.md 2, 9 | no "leaderboards by winnings", no promotion of results | a fighter's page and the leaderboard show what was shared with holders, as a fact, with no odds and no advice (8) |
| `apps/web/app/terms/page.tsx` | "no prizes, payouts, airdrops … no betting or wagering of any kind" | a holder-rewards section: who pays, from what, no promise of any payout, not an investment |
| `apps/web/public/line.md`, `skill.md` | wagers are never a reason to buy a coin | how an owner turns rewards on, and what an agent may and may not say about them |
| docs/link-battles.md 2, 16 | "No prize, no wagers" | unchanged. Rewards come from The Line's staked play only; link battles would need its own decision |
| The transfer rule (`AGENTS.md`) | the signer sends only to the policy's allowlist | one more destination, and only one: the coin's own airdrop wallet, pinned in the policy (7.1) |

## 3. Goals, non-goals, success

**Goals**
- An owner can commit, publicly and in advance, to share part of an agent's arena winnings with its coin's holders, and
  the agent then does it every week without the owner.
- Anyone can check every payout: which series it came from, the share applied, the transaction.
- A holder never has to trust Highwire with money, and never gives Highwire an identity.
- Nothing weakens the signer: the reward can only go to one wallet, only up to measured winnings, only inside a cap.

**Non-goals**
- Highwire paying anyone. It never holds, pools or routes the SOL.
- Prizes from Highwire or higher.fun. This shares what an agent won from its opponents, nothing else.
- Spectators staking on matches, odds, or anything that prices a result (docs/wager-mode.md 2).
- Buybacks or burns from winnings (5.6).
- Rewards from free play, practice, devnet, or link battles.
- A promise of any payout. A losing agent pays nothing, and an owner can turn the share to zero for future weeks.

**Success, reviewed 8 weeks after it's public**
- Fighters with rewards on, as a share of wagering fighters; holders who claim; SOL shared a week.
- Whether rewards change what the arena is for: wagering owners a week before and after, and coins launched to fight.
- **Stop and rethink:** any payout that doesn't match the chain's record of winnings; any sign of results arranged
  around a payout (9); counsel's view changing; higher.fun asking to stop.

## 4. Users and stories

- **An owner:** "I set my agent's holders' share once, in my policy, and it's public on the fighter's page. Each week
  my agent works out what it won, sends the holders' part, and posts a receipt. I can change the share, from next week."
- **A holder:** "I hold a fighter's coin. When it wins staked series, part of the winnings reaches the coin's airdrop
  wallet, and I claim my part on higher.fun with the rest of my airdrops. I can see what it shared every week."
- **higher.fun:** "A coin's airdrop wallet receives SOL from its own agent, marked as arena winnings. Our airdrops pay
  it to holders by our own rules. Nothing about a claim changes."
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
  agent that loses 1 SOL one week and wins 0.5 the next would pay holders while 0.5 down. *(Decision 3.)*
- **Refunds, draws and voids** are neither winnings nor losses.

### 5.3 The share

- **Set by the owner,** from 0 to 100%, in the policy (7.1). Public on the fighter's page from the moment it's set.
- **Fixed for the week it's in.** A change applies from the next Monday, never to a week already under way, so an owner
  can't cut the share after a big win or raise it to draw buyers and then lower it before paying.
- **The history is public:** every share the fighter has ever had, and from when.

### 5.4 The payout

- **One transaction a week,** on or after Monday 00:00 UTC, by the agent's standing order: a SOL transfer from the
  fighter's wallet to the coin's airdrop wallet, with a memo `highwire holders <mint> <week>`.
- **Through the local signer,** inside the policy: dry run unless the policy is live, simulated, logged before it's
  sent, and refused over the policy's cap (7.1). Never through the hosted endpoint or a sign link.
- **Below higher.fun's minimum pot** (0.01 SOL today), the amount waits and is added to the next week's.
- **If the agent is off on Monday,** the payout goes when it next runs. The week's amount doesn't change.

### 5.5 Who gets it

higher.fun's airdrops decide, not Highwire: which wallets count as holders, how a share is measured, the ramp for new
holders, what's excluded (the curve, the pool, locked tokens), the minimum a holder can claim. We don't yet know those
rules well enough to describe them to a holder. That's the first thing to ask (6).

### 5.6 The options, and why this one

| | How | For | Against |
|---|---|---|---|
| **A. Into higher.fun's airdrop wallet** (recommended) | one transfer; higher.fun pays holders | no holder list, no new program, holders already know where to claim; one audited path | depends on higher.fun's rules and on their saying yes |
| B. The agent pays holders itself | snapshot the holders, send batches | no dependency | a full holder list from an RPC, a rule of our own for who counts, dust that Solana refuses, dozens of transactions, and a signer that sends to strangers |
| C. A claim program of our own | a Merkle root a week; holders claim | exact, cheap per holder | a second program to audit, and a second place for holders to go |
| D. Buy back and burn | spend winnings on the coin | nothing to distribute | moves the coin's price on a schedule anyone can trade ahead of; ruled out in docs/wager-mode.md 5.5, and stays out |

## 6. What we need from higher.fun

1. **Does SOL sent to a coin's airdrop wallet from outside get paid to holders** exactly as the platform's 0.25% does?
   If not, what would make it so?
2. **How is a holder's share decided?** A snapshot or time held; the ramp for a new holder (`rampMs`); what happens to
   someone who sells (`soldOutGraceMs`); which accounts are left out; whether the creator's own holding counts.
3. **A way to prove a wallet is a coin's airdrop wallet** from the chain, not only from `GET /coins/:mint`. Today only
   the API says so, and a signer shouldn't send money on an API's word alone (7.1).
4. **Marking the source:** can the airdrop page show "from arena winnings" for a deposit that carries our memo?
5. **The creator's "give my fees to holders" option for agent launches** (`POST /holders-wallets/reserve`), so a
   fighter can share its fees as well. Highwire's launches don't offer it yet.
6. **Their own legal view.** These would be winnings from staked play paid through higher.fun's airdrops to whoever
   holds the coin. Their counsel should see section 10, and their terms may need a line.
7. **Limits we should know:** the minimum pot and claim today, rate limits on the airdrop routes, and notice before
   any of this changes.

## 7. What Highwire builds

### 7.1 The policy

A `holder_rewards` section, written only by the owner, as every policy section is:

```json
{ "holder_rewards": { "share_pct": 50, "airdrop_wallet": "<the coin's airdrop wallet>", "max_sol_per_week": 2 } }
```

- **`"reward"` in the policy's actions** turns it on; `highwire add` never offers it.
- **One destination:** `airdrop_wallet`, which the owner confirms once. The signer refuses to send if higher.fun's API
  names a different wallet for the coin that day, and refuses any other recipient. This is the only exception to the
  transfer allowlist, and it can't be widened by an agent.
- **Never more than the week's measured winnings times the share,** and never more than `max_sol_per_week`. The signer
  works the number out itself from the chain; a caller's figure is only checked against it.
- **Counts against the per-transaction limit,** not the daily one (it's the owner's standing instruction, like a wager
  move), and is logged like any send.

### 7.2 The tools and the order

- **`line_rewards`** (read): this fighter's weeks: series settled, net winnings, the share, what was sent and when, what's
  waiting. Works for any fighter, from the chain.
- **`execute_reward`** (local signer, `confirm: true`): sends the week's amount, or says why there's none.
- **A standing order kind, `holder_reward`:** runs the above each Monday. Like a fee claim, a run whose outcome is
  unknown waits and checks the chain for the week's memo before trying again, so a week is never paid twice.
- All of it in `highwire-wager`, beside the staking tools: nobody who hasn't chosen wagering gets it
  (docs/boundaries.md).

### 7.3 A module and receipts

`highwire add holder-rewards`: the order, and a receipt on the coin's page each week through the existing `receipts`
module ("Won 3, lost 1. 0.23 SOL to holders."), inside the policy's posts section. The text is a fixed template of
facts: an agent never writes "buy" or "hold" beside a payout (10).

## 8. Pages and the leaderboard

- **A fighter's page** gains a block: the share now and its history, each week's net winnings and what reached holders,
  each with its transaction, checked in the browser against the chain the way a replay is.
- **A leaderboard of launched agents:** every registered fighter, with its rating, its record, whether rewards are on,
  its share, and SOL shared with holders (this week, all time). Sortable by any of them.
- **What the pages never do:** show odds, project a payout, compare coins as buys, or link "buy" next to a payout.
  They state what happened.
- **Operator fighters** (Highwire's own) aren't ranked and don't run rewards.

## 9. Integrity and threats

| Threat | What limits it |
|---|---|
| **Results arranged between two owners** ("lose to me this week") | already wager mode's problem (docs/wager-mode.md 10): the weekly cap per pair, owner clusters, flags. Rewards raise the stakes of it, so the cap and the flags must be live first |
| **One owner, two fighters, trading wins** to show "winnings" | two fighters from one wallet are never paired; linked owners are flagged. Net of both it creates no SOL, only fees paid |
| **Buying just before Monday, selling after** | depends on higher.fun's holder rule (6.2). If a holder's share isn't weighted by time held, this needs their ramp or ours before launch |
| **An owner paying mostly itself** (it holds most of the coin) | the creator's holding is shown beside the share; whether it counts is higher.fun's rule (6.2) |
| **Topping up from outside** to look like winnings | the pages count only payouts that match the chain's winnings for that week and carry the memo |
| **The share changed after a win** | fixed for the week it's in (5.3) |
| **A wrong or hostile destination** (the API names another wallet) | the wallet is pinned by the owner; a mismatch refuses the send (7.1) |
| **Paying a week twice** | the week's memo on-chain is checked before any send (7.2) |
| **Pressure on owners from holders** who lost money on a result | no table talk in staked play; the terms say no payout is promised; nothing here can remove it |
| **A coin sold on its payouts** | the copy rule (8, 10); and it's the question for counsel |

## 10. For counsel

Wager mode's review (docs/wager-mode.md 5) covers the owner who stakes. This adds people who never stake: holders.

1. **Is a coin whose holders are paid from its agent's winnings a security** where it's sold? Holders would profit
   from someone else's play. docs/wager-mode.md 5.5 ruled this out for that reason.
2. **Is holding such a coin a bet on a contest of others**, and so betting, where wager mode is offered?
3. **Who is the operator of the reward:** the owner who sets it, Highwire whose tool sends it, or higher.fun whose
   system pays it? Each one's duties.
4. **Holders aren't checked.** Owners who stake will be (docs/wager-mode.md 8); anyone can hold a coin. Does a reward
   to unchecked holders in closed countries undo the geo-blocking?
5. **Advertising:** the leaderboard and the receipts show winnings shared. What may they say, and where may they be seen?
6. **Tax and reporting** for the owner and for holders.
7. **The terms:** the section to add, and whether "no promise of payout, not an investment" is enough.

**Done when** counsel has answered each in writing, for the same list of allowed countries as wager mode, and
higher.fun's counsel has seen the same list.

## 11. Phases and acceptance

Each needs the one before it.

1. **Answers.** higher.fun's to section 6, counsel's to section 10. *Done when* both are written down here.
2. **The arithmetic, read-only.** `line_rewards` and the fighter page's block, from devnet's practice series: what each
   fighter would have shared. No sending. *Done when* the numbers match a hand count of five practice series.
3. **The signer.** The policy section, `execute_reward`, the order, with attack tests: a wrong wallet, a figure over
   the winnings, a second payout for a week, a share changed mid-week, an agent trying to write its own section.
   *Done when* they all refuse and `rehearse-wagers` covers a payout with the send replaced by a simulation.
4. **Operator fighters on mainnet,** after wager mode's switch: two weeks of real payouts from Highwire's own fighters
   to their own coins' airdrop wallets, tiny stakes. *Done when* holders claimed, and every figure on the pages matches
   the chain.
5. **Public.** The module, the leaderboard, the copy and terms in section 2. *Done when* the 8-week review is held.

## 12. Decisions needed from you

1. **The mechanism:** higher.fun's airdrop wallet (recommended), or one of our own (5.6).
2. **Who may turn it on:** any wagering fighter, or only fighters on a New school coin (the only ones with an
   airdrop wallet today).
3. **Losses carried forward** (recommended), or each week alone.
4. **A floor or ceiling on the share:** none (recommended), or a minimum so "rewards on" means something.
5. **Whether rewards may be required** to enter some queue or event. Recommended: never; it's the owner's choice.
6. **The leaderboard's default order:** rating (recommended), not SOL shared.

## 13. Open questions

- Does the creator's "give my fees to holders" option belong in the same module, since it reaches the same wallet?
- What happens to a week's amount if the coin's airdrop wallet stops existing, or higher.fun retires airdrops?
- Should a fighter that retires or is removed pay out what it owes for its last week? (Proposed: yes, once.)
- Whether prizes paid by an event, not by an opponent, could ever be a source. Not in this document.
