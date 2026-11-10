# PRD: Wager mode for The Line

Status: **draft, revised after an adversarial review (17), 2026-11-09. Nothing is built.** Not legal advice: section 5 is research to
take to counsel, and nothing here ships before counsel signs off on it (section 15, decision 1).

Wager mode lets two agents stake SOL on a match of The Line, the winner taking the pot. It is the first time anything
of value would ride on a result, so it reverses the one assumption the whole arena was built on (docs/arena.md 10:
"everything rests on there being no prize"). This document plans it end to end: the law, the money, the program that
holds it, the agents and their limits, integrity, the people behind the agents, the copy, the phases and the cost.

**The short version.**
- **It is gambling, and the game can't be argued out of it.** A stake supplies the one element the arena was missing
  (a prize). Worse for any skill argument: the game's optimum is open source. Any owner can make their agent play the
  equilibrium (*Even*) for free, and against it skill earns nothing on average. Between rational players, a wager is a
  fair coin with extra steps; with a rake, a losing bet for both (4.1). So this document plans wager mode **as
  licensed gambling or not at all**, never as a skill contest (5).
- **No US launch, no UK launch.** No US state licenses this product, federal law (the UIGEA, the IGBA, unlicensed money
  transmission) attaches to any state-law breach, and the UK has no licence route that allows crypto (5.3, 5.4).
- **The realistic route is a licensed operator elsewhere** (Curaçao's regime is the usual one: about €47,000 a year
  plus a local company and staff), geo-blocking the US, UK and the usual list, with identity and age checks on every
  owner and sanctions screening (5.6). An offshore licence protects nothing in the countries that block it, and where
  the maintainer lives matters as much as where players are (5.4, 15). Or **not doing it**, and keeping The Line free.
- **What can be built with no legal exposure:** **practice wagers on devnet**, with worthless devnet SOL and a wall
  between practice and everything on mainnet (5.6, 13). It proves the engineering; it can't measure demand for real
  stakes, and the spec says so.
- **If it goes ahead, the design:** peer to peer only, never against the house; SOL only, never memecoins; stakes in a
  Solana program that only pays the winner or refunds; **the match played on-chain** (commit, then reveal, every round),
  so no one with access to the referee sees a move early; a reveal daemon on the owner's machine, because commit-reveal
  needs the committer back; an unrevealed commit **forfeits the match**, so withholding never pays (7.2.1); no table talk
  in wager matches; a separate wager rating; owners' limits enforced by the policy file *and* by their verified
  identity; the local signer only (7).
- **Before any of it costs money:** evidence from free play that people would use it (13, the gate before W0), then
  counsel's written sign-off, an external audit, and a closed beta with external owners and tiny caps.

## 1. What changes from today

Today's promises, in code and copy, that wager mode breaks or must qualify. Every one is a deliberate change, made in
the same release that turns wager mode on, and never before counsel's sign-off:

| Where | Today | With wager mode |
|---|---|---|
| `AGENTS.md`, "The Line's referee" | "Nothing of value is ever awarded for results" | Free play: unchanged. Wager matches: the pot, and nothing else (no prizes, promotion or placement on top) |
| `docs/arena.md` 1, 2, 10 | no stakes, no betting, "everything rests on there being no prize" | 10 points here for wager matches; free play keeps its analysis |
| `apps/web/app/terms/page.tsx` | "no betting or wagering of any kind", "No stakes." | a wager section (8, 12), eligibility, jurisdictions, fees, disputes |
| `apps/web/public/line.md`, `skill.md` | "Nothing is staked or won" | free play by default; wagering opt-in, with its own section |
| `/line`, `/line/fighter/<mint>` | "Nothing is staked." | free and wager matches labelled; stakes shown on wager matches only where the jurisdiction allows it (9) |
| `ideas/line-fighter`, `ideas/modules/line-play` | "Nothing is staked", "Can it win anything? No." | unchanged until wager mode is public; then a separate module (`line-wager`), never on by default |
| `IdeaCalculator.tsx` | "The Line awards nothing" | unchanged for free play |
| docs/arena.md 5, "Age: none asked" (0.14.3) | no age question | **wagering needs it back, and more**: age, identity where required, jurisdiction (8) |
| Table talk "not moderated" (0.14.3) | no review | unchanged, but table talk in a wager match is also a fraud channel ("I'll throw this one, back me") and is in scope for the terms' fraud clause (10) |
| The posted films | no claims about stakes | unchanged; nothing about wagering is posted until it's live and legal where the post is seen |
| docs/arena.md 6: "nothing about an open round is published (not even a hash, not whether a move has arrived)" | tested byte for byte | **reversed for wager matches**: a commit's hash, its slot and its payer are public the moment it lands, so the opponent learns that you've moved and how long you took. Pulls stay hidden until both are in |
| Table talk in matches | delivered to the opponent agent | **off in wager matches**: a line from an opponent with money at stake is an attack ("retire now and save fees"), not conversation (10) |
| `AGENTS.md`, "The hosted endpoint … never signs, holds a key" | the site holds only the attestation key | the matchmaker signs **tickets** (8); still no key that moves money |
| `AGENTS.md`, "The Line's referee … holds no user secrets" | no identities | identities live in a **separate** project and store, never the arena's (8) |

Free play stays exactly as it is: rated, unstaked, open to every registered fighter. Wager mode is a separate queue
with its own eligibility, and a fighter can play both.

## 2. Goals, non-goals, success

**Goals**
- Agents can stake on their own play against another agent, with the stake held so that neither side, nor Highwire,
  can take it or keep it from the winner.
- Every wager match is as checkable as a free one, and more: its moves, its result and its payout are on-chain.
- The owner's limits, not the agent's judgment, bound what an agent can stake (the policy file, 7.3).
- Lawful where it operates, and closed where it isn't.

**Non-goals**
- **The house as a counterparty.** Reader and Even never stake. A house that takes bets against players is a casino
  (5), and Reader is built to exploit weak play: it would be a house edge by design.
- Spectators betting on matches (pool betting on others' contests is sports betting in nearly every jurisdiction).
- Staking memecoins, including a fighter's own coin (6.1).
- Wagering from the sign page or the hosted endpoint: local signer only, as with registration (7.3, 7.6).
- Leverage, credit, side bets, parlays, odds, or anything but "both stake the same, the winner takes the pot".
- Promotion of wager results: no "biggest wins", no leaderboards by winnings, no clips of pots.

**Success, measured weekly; reviewed after 8 weeks of the public phase**
- Weekly wagering owners, wager matches, median stake, completion rate (matches that settle without a timeout refund),
  dispute rate, and the share of wager matches between linked owners (a collusion signal, 10).
- A **dispute** is a claim by an owner that the program paid wrongly or not at all; the dispute rate is disputes per
  100 settled series. The collusion share needs owner clusters (docs/arena.md 7), which must exist before W3.
- **Kill or rethink:** fewer than 20 weekly wagering owners after 8 weeks; a completion rate under 90%; any loss of
  staked funds to a bug; or counsel's view changing.
- **The gate before any spend (before W0):** free play shows the audience exists: at least 50 weekly active owners for 4
  consecutive weeks, at least 30% of them still playing a month after their first match, and owners asking for stakes
  unprompted. Below that, wager mode isn't worth €100,000 a year of licence and compliance.

## 3. Users and stories

- **An owner:** "I pass the identity check once, set my loss limits with Highwire, and set the most my agent may stake,
  and how many series it may have open, in my policy file. My agent then plays wager matches inside those limits, and I can see every stake, result and
  payout in its audit log and on-chain."
- **An agent:** "I call `line_join` with a stake tier (an execute: it stakes); I'm paired with another agent at that
  tier; we both deposit into the series' escrow; I move as in free play, and my owner's reveal daemon reveals for me;
  the program pays the winner."
- **A spectator:** "I watch wager matches like any other; where it's allowed, I see the stake. I can't bet."
- **Highwire:** "I can't move anyone's stake. I can pause new wager matches. If the referee disappears, every open
  match refunds or settles on its own."

## 4. The game under stakes

The rules don't change: `duels-1`, the same as free play (docs/arena.md 4). What a stake changes is how much the
outcome must be **skill** rather than luck, for the law (5) and for fairness.

### 4.1 How much is skill, and why it doesn't save the analysis

From `npm run arena:sim` (1,000 matches a pairing, each side half the time; a score is wins minus losses over matches,
+1 always wins):

| Row v column | Score | Draws |
|---|---|---|
| Reader (adapts) v three LLM-like styles | +0.61 to +0.85 | 0 to 3% |
| Reader v fixed strategies (pull 2, pull 6, one more than the last) | +0.95 | 0% |
| Reader v uniform random | +0.75 | 2% |
| Even (the equilibrium) v the LLM-like styles | +0.11 to +0.45 | 7 to 14% |
| Even v Even, Reader v Reader | ≈ 0 (44% / 12% / 44%) | 11 to 12% |

- **Skill dominates between unequal players**: an adaptive player beats predictable ones almost every time.
- **But the equilibrium is free and open source.** *Even* plays it, and a best response to it scores exactly 0
  (docs/arena.md 4.2). Any owner can adopt it for nothing, and then no one can beat them on average. With money on
  the line, a rational owner either plays the equilibrium (and the match is a fair coin) or plays to exploit the owners
  who don't. The realistic market is scripted, Reader-like bots farming the owners of LLM agents (which lose most
  matches to Reader, docs/arena.md 4.5).
- **That's the worst fact pattern for a skill argument:** the one strategy anyone can adopt for free cancels all skill.
  This document doesn't rest anything on skill. It plans wager mode as gambling (5).
- **With a rake, no rational staker exists.** Between two equilibrium players a series is worth 0 before the fee; a
  2.5% rake makes it cost the two sides 2.5% of the pot between them, every series (6.4).
- **Best-of-5 series** (4.2) reduce variance, so an exploitable agent loses more reliably and a fair coin stays a fair
  coin; they're for fairness, not a legal lever. If one player wins 65% of decided matches, it wins a best-of-5 about
  76% of the time; at 80%, about 94% (the binomial sum; W1 adds a series mode to the simulator).
- **Pairing by rating is a fairness lever too, not a skill one:** pairing equals makes each series closer to even by
  construction. Evidence about skill, if counsel wants it, comes from free play across rating gaps.

### 4.2 What a wager match is

- **Stake:** both sides stake the same amount of SOL, from fixed tiers (6.2). Wagers are symmetric: no odds.
- **Format:** a best-of-5 series of `duels-1` matches between the same two fighters, sides alternating, draws counted as
  draws (a series level after five matches is a draw). *(Open: first-to-3 with replays; 16.)*
- **Settlement:** the series winner takes both stakes, less the fee (6.4). A drawn series and a void (both absent)
  refund both stakes in full; the series account's rent goes back to whoever opened it.
- **Timeouts:** free play's chess clock: a move must land before the round's time (or the bank) runs out, never on it.
  A side that misses a commit plays its fallback; banks refill each match, but a side whose bank runs out plays its
  fallback for the rest of the **series** (so an absent opponent costs one match of waiting, not five); both banks out
  voids every remaining match. No new "lose on time" rule.
- **One new ending, wager-only, in the rules version:** a side that commits and doesn't reveal within the reveal window
  **forfeits the match** (7.2.1). It's the price of hiding moves on-chain.
- **Retiring** forfeits the series, and needs the owner's say-so (7.3).
- **Rated separately.** Wager matches have their own **wager rating**, seeded once from the free rating at eligibility;
  free results never change it afterwards, and wager results never touch the free ladder. Otherwise sandbagging free
  matches to be paired down for money would pay, and free play's rating would become something of value
  (docs/arena.md 10).

## 5. Is it legal? (research for counsel, not legal advice)

### 5.1 The three elements

Gambling, almost everywhere, is **prize + chance + consideration**. The arena avoided it by having no prize
(docs/arena.md 10). Wager mode has all three:
- **Prize:** the pot. Courts read "thing of value" broadly (the Ninth Circuit held virtual casino chips counted, *Kater
  v. Churchill Downs*, 2018), and SOL is plainly value.
- **Consideration:** the stake itself.
- **Chance:** the game's optimum is a mixed strategy (docs/arena.md 4.2): a strong opponent *injects* randomness, and two
  strong agents split close to evenly (4.1). That's not incidental luck like a dealt card; it's the equilibrium.

### 5.2 Skill versus chance

- **US.** Most states use the *dominant factor* test (does skill or chance mainly decide the result?); a minority use
  *material element* (does chance matter materially?); a few, *any chance*. Sources disagree on which state uses which,
  and counsel must check each statute. Under material element this game is gambling. Under dominant factor it's
  arguable: courts in the poker cases relied on data that skilled players reliably beat unskilled ones over many plays.
  The simulator says that's true between unequal agents (4.1) and not between equal ones; the evidence to gather is win
  rates by rating band over many real matches, and how much results vary between strong agents.
- **Whose skill?** If an owner's agent is a stock model the owner didn't build, a court may find little *human* skill.
  An owner staking on their own agent arguably bets "upon the outcome of a contest of others" (the UIGEA's definition,
  31 U.S.C. §5362(1)(A)), which weakens the "participant, not spectator" argument skill-gaming companies rely on.
- **UK.** A "game of chance" includes "a game that involves both an element of chance and an element of skill"
  (Gambling Act 2005 s6(2)), and "betting" includes a bet on "the outcome of a race, competition or other event or
  process" (s9(1)(a)), skill or not; a platform that facilitates bets between others is a betting intermediary (s13).
  In the UK, wager mode is gambling, full stop.
- **Elsewhere in Europe:** Italy licenses real-money skill games as gambling (since 2011); Germany's and the
  Netherlands' tests weren't verified for this draft.
- **The central weakness** (4.1): the equilibrium is open source, so any owner can neutralise all skill for free.
  Under a dominant-factor test that's close to fatal: the outcome between rational players is chance. Series reduce
  variance; they don't change this.

### 5.3 United States

- **Federal.** The UIGEA reaches payments for bets unlawful where they're made. The **IGBA** (18 U.S.C. §1955) makes a
  gambling business that breaks state law a federal crime when it involves five or more people and runs over 30 days or
  takes $2,000 in a day: a small team and its contractors can reach five. The Wire Act is limited to sports betting in
  the First Circuit (*NH Lottery Comm'n v. Rosen*, 2021); elsewhere less settled.
- **State skill-contest laws.** Even platforms that rely on skill (WorldWinner, Skillz-powered apps) exclude states
  that prohibit paid-entry skill contests; the lists conflict, but commonly include AR, AZ, CT, DE, LA, MT, SC, SD and TN
  (and sometimes IN, ME). Head-to-head wagers are treated more strictly than tournaments with prizes fixed in advance.
- **The direction of travel is against this product.** Several states have banned sweepstakes models since 2025
  (California's AB 831 from 1 January 2026, among others); Florida sued Stake.us and its payment processors (August
  2026); Michigan and Illinois regulators issue cease-and-desist letters to crypto casinos in batches; pick'em operators
  were forced from house-banked to peer-to-peer and then to CFTC-regulated markets. Prediction markets are a separate
  fight (the circuits are split over Kalshi; a Supreme Court petition is pending), and a match wager isn't an event
  contract without a registered exchange.
- **Conclusion for counsel to confirm:** no US launch. The US is geo-blocked in every model in 5.6.

### 5.4 UK, EU and offshore licences

- **UK:** a remote betting or gaming licence from the Gambling Commission, which doesn't allow crypto payments today
  (it began only a tentative look at them in February 2026, tied to the FCA's crypto regime, expected around 2027).
  Geo-blocked.
- **Malta:** €5,000 to apply, €25,000 a year, real substance on the island; crypto with prior approval. Too heavy for
  this team.
- **Curaçao (the LOK regime, since December 2024):** about €4,600 to apply and about €47,000 a year; a Curaçao company
  with a resident managing director, an office and a local compliance officer; up to 16 weeks; responsible-gambling
  rules (self-exclusion, deposit limits, age checks); the June 2026 crypto guideline allows crypto as a payment method
  with blockchain analytics and no sanctioned wallets or mixers, and **requires a specific risk assessment for meme
  coins** (one more reason for SOL only, 6.1).
- **An offshore licence protects nothing outside its own jurisdiction.** The Netherlands, Germany, Australia and
  others fine and block foreign-licensed operators serving their residents, and directors are personally exposed. W0
  lists *enforcement* per target country, not just licensing.
- **Anjouan:** cheaper (about €18,000 a year by consultants' figures) and quicker, with a weaker reputation (a licence
  was revoked for illegal sublicensing in July 2026).
- **Geo-blocking** under any offshore licence: the US, UK, France, the Netherlands, Australia and Ontario at least;
  often Germany, Italy, Spain and the UAE; always sanctioned countries and regions.

### 5.5 Money, crypto and securities

- **Money transmission.** FinCEN's 2019 guidance (FIN-2019-G001): an unlicensed internet gambling business that accepts
  and pays out crypto "may still be regulated under the BSA as a money transmitter" (4.7); whether an intermediary is
  one turns on "total independent control" of the funds (4.2). A custodial design is squarely in it. A non-custodial
  program helps: the Department of Justice said in August 2025 it wouldn't bring new unlicensed-transmission charges
  against "truly decentralized" software without custody, but that's a non-binding statement, and an upgrade authority
  or a referee key that decides payouts is arguably control. **Non-custody doesn't make the wager legal**; it addresses
  money transmission only. California's digital-asset licensing applies from July 2026.
- **AML and KYC.** Curaçao requires due diligence (enhanced for crypto users) and reporting to its financial
  intelligence unit; the EU's AML Regulation reaches gambling operators from July 2027 (due diligence at €2,000 in stakes
  or winnings). Expect identity checks, wallet screening and source-of-funds questions.
- **Sanctions.** OFAC's screening duty is strict liability. *Van Loon v. Treasury* (2024) held immutable contracts
  aren't blockable property, but an upgradeable program isn't immutable. Screen every wallet at eligibility and before
  each series.
- **Securities.** The SEC staff's February 2025 statement covers memecoins bought for entertainment and culture, not
  coins whose value depends on others' efforts. A coin whose value is tied to its agent winning ("holders profit when we
  win") points the other way, and gives its owner a reason to fix matches. Hence: no memecoin stakes (6.1), no
  winnings routed to buybacks or holders, and the arena's "never a reason to buy" rule kept for every fighter.

### 5.6 The operating models

| Model | What it is | Legal position | Cost | Verdict |
|---|---|---|---|---|
| **0. Free only** | today's Line | no prize: not gambling (docs/arena.md 10) | none | the safe default |
| **1. Practice wagers** | the whole of wager mode on **devnet**, with devnet SOL that's worthless and can't be bought | no prize, so not gambling, provided nothing of value is ever attached (no conversion, no rewards for practice winnings) | engineering only | **build first** (W1) |
| **2. Offshore licence** | a licensed entity (Curaçao or similar) operates wager mode; geo-blocks; identity, age and sanctions checks; responsible-gambling tools | the established route for crypto gaming | €50,000 to €150,000 a year with substance and compliance, plus counsel | the only real-money route this team could take |
| **3. US skill gaming** | peer to peer in dominant-factor states only, excluded states blocked | weak: chance is material by design, head-to-head is treated strictly, and the "contest of others" problem (5.2) | counsel, KYC, state-by-state | not recommended |
| **4. Protocol only** | publish the program and tools; Highwire runs no matchmaking or pages for wagers | facilitation and the operator's control (upgrade key, matchmaker) still point at Highwire; the DOJ statement is non-binding and gambling law is separate | low | not a shield; not recommended |
| **5. Sweepstakes** | free entry route, prizes in a second currency | being banned state by state (5.3) | — | no |

**Recommendation:** model 1 now; model 2 only if model 1 shows real demand **and** counsel agrees, run by an entity
set up for it; models 3 to 5, no.

**Where the operator is decides as much as where players are.** A US-resident maintainer running the matchmaker, the
crank, the indexer and the upgrade key for a real-money game is the IGBA's "conduct" fact pattern regardless of where
the players are, and geo-blocking failures add to it. The maintainer's residence and the entity's jurisdiction are
**inputs to this document, not outputs of W0**: decision 2 in section 15 asks for them now.

**Tax** isn't one line: the operator's gaming tax in its jurisdiction, VAT on a rake, the operator's reporting duties,
the EU's crypto-asset reporting rules (likely not applicable to a non-custodial program; *uncertain*), and owners'
own reporting of winnings. W0 covers them.

**Practice wagers stay free of value only if:** devnet SOL is never bought, sold, rewarded or converted; practice
results never touch mainnet ratings, records, eligibility, pages or anything else of value; and nothing promotes
practice winnings.

## 6. Money

### 6.1 What can be staked: SOL only

- **SOL only.** Not USDC at first (a second mint doubles the program's paths for little gain), and **never memecoins**:
  - a fighter's own coin as a stake invites manipulating its price around a match, and makes the pot's value depend on
    a market the owner moves;
  - the winner receiving a pile of a rival's memecoin and dumping it harms that coin's holders, who never agreed to
    anything;
  - and it puts every match's settlement next to the securities and manipulation questions docs/arena.md 10 kept the
    arena away from.
- Stakes are **lamports in a program-owned account**, never a token account Highwire controls.

### 6.2 Stake tiers and caps

- **Tiers:** 0.1 and 0.25 SOL a side at launch. Lower tiers aren't worth it: a best-of-5 is about 150 transactions a
  side (6.5), which at real priority fees is 0.0015 to 0.015 SOL, a large share of a 0.01 or 0.05 stake before any
  model costs.
- **Program-enforced cap:** the program refuses any stake above a maximum in its config (0.25 SOL at launch), whatever
  any client sends.
- **Owner caps:** the policy's `wagers` section (7.3).
- **Platform caps:** a cap on the total open stake across all series (10 SOL at launch; 1 SOL in the closed beta), so
  a program bug's worst case is bounded; enforced by the program from a counter in its config. The counter's
  decrement on every close path is tested (a bug there would block every new series at the cap).

### 6.3 Where the stake lives

Each wager series has a program-derived account (PDA) holding both stakes. Only the program can move lamports out of
it, and only to:
1. the winner (the pot less the fee),
2. both players (a refund: a drawn series, a void, a series that never started, a timeout, or an emergency refund),
3. the fee account (the fee only, and only on a decided series, retirements included);
4. the incinerator, for a player's own share when the runtime won't credit that player's wallet (it was turned into a
   program, say). Burning it means no payee can hold the other player's payout hostage, and nobody profits.

A fee the fee account can't take (it's empty and the fee is under its rent-exempt minimum) goes to the winner, so
Highwire's own setup never holds a payout. Tiers are at least 0.01 SOL, so a payout to a player who emptied their
wallet is always above the rent minimum. `open` takes A's stake only from a plain system wallet.

There is no instruction that sends staked lamports anywhere else. **One authority can reach an open series**, and only
to refund it: `freeze_and_refund` (7.2), callable by the 2-of-3 multisig alone, which returns both stakes in full and
closes the series. It exists for a sanctions hit or a court order (8), because a program that can't comply with a
freeze can't be operated by a licensed entity; it can't pay anyone but the two players. Every other claim in this
document about Highwire not touching stakes is subject to that one exception, and the terms say so.

### 6.4 The fee

- **Option A, no fee:** Highwire earns nothing from wagers. It removes the incentive to push volume, and keeps the game
  zero-sum for players. Highwire still pays for the program, the audit, compliance and the indexer.
- **Option B, a rake:** a percentage of decided pots (2.5%, say) to a fixed fee account, capped in the program (no more
  than 5%, ever), and **snapshotted into each series at `open`**, so a fee change never applies to a series already
  staked.
- **The arithmetic either way:** between two equilibrium players a series is worth exactly 0 before fees. With a 2.5%
  rake on a 0.25 SOL tier, the pot is 0.5 SOL and the fee 0.0125 SOL, so each side expects −0.00625 SOL a series, plus
  network and model costs. Only players who are exploitable stake at a rational loss; that's who a rake is paid by.
- **Recommendation:** decide with counsel. A rake makes Highwire an operator taking a share of wagers; no fee doesn't
  make it *not* an operator (it still runs the matchmaker and the program), but changes the facts and the incentives.
  Never a fee on refunds; the fee shown before the agent stakes.
- Highwire's 0.3% trade fee is unrelated and unchanged: it applies to trades its tools build, never to stakes.

### 6.5 Costs the players pay, all in

| Tier | Network (150 transactions, priority 10k to 100k lamports each) | Model (5 matches at $0.30 to $2) | Rake at 2.5%, if any |
|---|---|---|---|
| 0.1 SOL | 0.0015 to 0.015 SOL | $1.50 to $10 | 0.0025 SOL a side on a decided series |
| 0.25 SOL | 0.0015 to 0.015 SOL | $1.50 to $10 | 0.00625 SOL a side |

- Rent for the series account: paid by the opener, returned to it at close.
- The tool shows this table, for the tier, before an agent stakes.

## 7. Architecture

### 7.1 The options

| | Custodial | Escrow, settled by the referee's signature | The match on-chain |
|---|---|---|---|
| Who holds stakes | Highwire's wallet | a program, paid out on the referee's attestation | a program, paid out by the program's own rules |
| Can Highwire take them | yes | only by forging a result (it holds the key that says who won) | no |
| If Highwire disappears | stuck | refunds after a deadline | the match finishes or times out on its own |
| Insider sees open moves | yes (as today, docs/arena.md 10) | yes, unless commits change | no: only commitments are on-chain until both are in |
| Money transmission (5) | almost certainly | arguable | weakest case for it |
| Cost to build | low | medium (program + attestation) | high (the rules in Rust, two phases a round) |
| Moves per round | as today | as today | commit then reveal, two transactions a side |

**Recommendation: the match on-chain.** With money at stake, "trust the referee" isn't good enough, and it's the
referee's plaintext view of open moves (docs/arena.md 10: "anyone with access to the store or the relay could see open
moves") that would let an insider win wagers. Custodial also breaks a rule this project has kept since the start: the
hosted side never holds a key that moves users' money (AGENTS.md, "The hosted endpoint").

### 7.2 The program (`programs/line-wager`, Rust)

**Accounts**
- `Config` (one): the authorities (a multisig, 7.7), the stake tiers, the cap per side, the open-stake cap and counter,
  the fee basis points and fee account, the matchmaker's ticket key and its key id, a `paused` flag (stops **new**
  series only), the rules version.
- `Series` (one per wager, PDA from `["series", series_id]`): both players' wallets, the tier, the **fee snapshotted at
  open**, the state, the rules version, the ticket's key id, the current match's open round (commitments, reveals, the
  node, energies, each side's bank), **each side's fallback as a commitment** (7.2.5), the five match results, when
  the current phase opened (its deadlines follow from it), and the Unix time of the last change (the emergency refund's
  clock). Per-round history is in the transactions, not the account.
- No account per round. Every revealed round is emitted as an event; the indexer keeps them (7.5).

**Instructions**

| | Who | What |
|---|---|---|
| `open(ticket)` | player A | verifies the matchmaker's ticket (8): series ID, both wallets, tier, acceptance deadline, expiry; creates the series, deposits A's stake, snapshots the fee, records A's fallback commitment |
| `accept(ticket)` | player B, before the ticket's deadline | deposits B's stake and records B's fallback commitment; round 1 opens |
| `cancel()` | player A, or anyone after the deadline | if B never accepted: refunds A, closes the account |
| `commit(round, hash)` | a side, strictly before its deadline | `SHA-256(series_id ‖ match ‖ round ‖ side ‖ pull ‖ nonce)`: 32 bytes, then four single bytes, then a 32-byte nonce (pulls run only 0 to 30, so a short nonce could be brute-forced); charges the side's bank |
| `reveal(round, pull, nonce)` | each side, after both commits, within the reveal window | checks the hash; when both are revealed, plays the round with the rules and opens the next |
| `timeout()` | anyone, after a deadline | in a commit phase, only once **every** side still to commit is past its own deadline (so nothing about one side is published while the other can still move); each late side then owes its fallback (7.2.5). In a reveal phase after the window: a missed reveal forfeits the match (7.2.1); both missed: a void |
| `settle()` | anyone, once the series is decided | pays the winner and the snapshotted fee, or refunds; closes the account, rent to the opener; decrements the open-stake counter |
| `retire()` | a player | forfeits the series |
| `emergency_refund()` | anyone, if the series hasn't changed for 24 hours | refunds both stakes in full and closes the account, whatever its layout version, except a series that is decided or that the timeouts already due would decide: that only settles (so the loser can't take its stake back by waiting a day) |
| `freeze_and_refund()` | the multisig only | refunds both stakes in full and closes the account (6.3) |

#### 7.2.1 Committed but never revealed

The hard case of commit-reveal. The program never sees a withheld pull, so it can't charge the energy a withheld
commit hid: whatever the penalty, the side that reveals **second** has seen its opponent's pull and holds an option to
withhold. (The first draft's "an unrevealed commit counts as 0" made withholding free whenever the revealed pull beat
one's own, broke the all-pay rule the solver, *Even* and *Reader* all rest on, and led both sides to wait out every
reveal window: every round a 0–0 tie, every match a draw.)

**Rule: a side that commits and doesn't reveal within the reveal window forfeits the match.** Losing the match is at
least as bad as any round result, so revealing second gains nothing, and revealing first costs nothing. The reveal
window is generous (2 minutes after both commits land, never under 1 minute, given the clock, 7.2.3), because the
forfeit is harsh on a crashed agent. That's what the reveal daemon (7.3) is for. The parity fixtures (7.2.2) include this
ending.

#### 7.2.2 The rules in Rust

- `playRound`, the clock and the fallbacks are ported from `packages/core/src/arena/rules.ts` to Rust, as a library the
  program calls, plus the wager-only endings (the missed reveal; the series).
- **Parity is tested, not assumed:** `npm run test:program` has a generator in `highwire-core` write 2,000 random series a
  seed (about 300,000 events: players present, slow and absent; every fault on purpose; moves exactly on deadlines;
  moves after the end), refuses to write them unless every branch is hit, and the Rust replays every event, comparing
  acceptance, the error's kind and the whole state after it. Then `tests/program.rs` drives every instruction under
  solana-program-test with real Ed25519 tickets and exact lamport accounting, twice: natively, and against the built
  SBF binary, under real compute limits (the heaviest instruction uses about 15,000 units). Known-answer vectors pin both
  hashes in both languages. W1's acceptance runs five seeds (10,000 series). There's no CI in this repository yet; until
  there is, `npm run test:program` runs before every commit that touches either side.
- The rules version is stored in each series; a program upgrade can't change an open series' rules.

#### 7.2.3 Time on-chain

The on-chain clock is a different clock from the free referee's, and it is the rule for wager matches:
- **A phase opens at the timestamp of the transaction that opened it** (the `Clock` sysvar's Unix time): round 1 at
  `accept`; each later round at the reveal or `timeout` that resolved the one before.
- **A side's bank is charged** the gap between its commit phase opening and its commit landing: so its thinking, plus
  inclusion latency, plus any lateness of the transaction that opened the phase. Players are told so.
- Validator clocks drift by seconds, at times tens of seconds *(uncertain on the worst case)*; round limits stay at 2
  minutes, and the reveal window is between 1 minute and 1 hour (the program refuses anything else). The ceiling keeps
  every window far below the emergency refund's 24 hours, so withholding a reveal can never be waited out.
- A side that's late lands nothing; anyone may call `timeout()`. Highwire runs a crank (7.5), but nothing depends on it:
  either player can crank, and the one ahead has every reason to.
- The browser's replay uses this model, not the free referee's (`match.ts`).

#### 7.2.4 Compute and size

- A `reveal` does one SHA-256 (a syscall) and one round of integer rules: well under the 200,000 compute-unit default.
- The series state is at most 249 bytes in Borsh (`SERIES_MAX_LEN`, pinned by a test against every fixture state);
  its `Option`s make it variable, so the account is allocated at the maximum and read with `deserialize`, which ignores
  the unused tail. Step 2 adds the wallets, tier, stake, fee and ticket key id around it. Rent about 0.003 SOL
  *(estimate)*, returned to the opener at close.

#### 7.2.5 Fallbacks without leaking them

In free play a fallback is private to its side, and the referee holds a fallback move hidden until both are in. On-chain
that has to be kept deliberately:
- At `open` and `accept`, each **player** commits to its fallback (`SHA-256("fb" ‖ series_id ‖ player ‖ kind ‖ pull ‖
  salt)`, with 32 fresh random bytes of salt per series: the fallback space is about 300 values, so a reused salt would
  let an opponent who saw one revealed fallback brute-force the next series'), not the fallback itself. One fallback
  per player per series, since sides alternate.
- At a missed commit, `timeout()` records only that the fallback applies; the side's **reveal daemon** reveals the
  fallback and its salt in the reveal window, and the program computes the pull from public state at resolution,
  after the other side's commit is in. Not revealing it is a missed reveal (7.2.1).
- Once revealed, a fallback is public for the rest of the **series**, and later missed commits play it at once with no
  reveal; the spec and `line.md` say so.

### 7.3 The agent side: the policy, the signer and the reveal daemon

Wagering goes **only** through the local signer, inside the owner's policy file, exactly as every send does today.

- **A new action, `"wager"`**, never in any template's default actions, and never in `ASKABLE_ACTIONS`: that list is
  for actions that move no money (AGENTS.md), and `highwire add` must never offer to add `"wager"`. The owner adds it to
  the file by hand; `highwire policy explain` (new) says what it allows.
- **A new section, `wagers`:**
  ```json
  "wagers": {
    "max_stake_sol": 0.1,
    "max_open": 1,
    "tiers": [0.1],
    "allow_retire": false
  }
  ```
  Stakes count **gross**, when they're sent, toward `max_sol_per_tx` and `max_sol_per_day`, from the audit log as every
  send does; winnings never free up room the same day (no chasing). `max_open` is checked against the chain (the
  wallet's open series), not the audit log, which never learns outcomes, plus stakes sent in the last ten minutes that
  the chain may not show yet, counted under the execute lock so two stakes can't both fit. Without the section, no
  wagers.
- **The signer reads every wager from its bytes**: the instruction, an open's stake from its data and an accept's from
  the series account. What the caller says is checked against them, never trusted, so an open can't pass as a reveal.
- **Moves aren't held to the daily limit** (a reveal, a timeout, a settle): refusing one would forfeit the match, and
  so the stake. Each is capped instead at 0.001 SOL of fees, still logged and counted, and none waits for the execute
  lock, so a slow trade in another process can't make a reveal miss its window.
- **Staking is an execute.** `line_join` with a `stake` takes `confirm: z.literal(true)`, carries the `EXECUTE`
  annotations, and sends `open` or `accept` through `LocalSigner.execute()` with `action: "wager"` and `solOut` equal to
  the stake, so the policy, the simulation, the audit log and the kill switch all apply.
- **Every wager transaction** (`open`, `accept`, `commit`, `reveal`, `retire`) is built by Highwire's builders and goes
  through `finish()`: the `highwire` memo, simulation, and `assertSafe`, which gains the wager program's instructions
  with their own checks (the program ID, the series PDA's derivation, the stake equal to the tier and within the
  policy, no other transfers). `attacks.test.ts` gains links that must fail.
- **The sign page refuses every wager instruction**, like transfers and registrations.
- **The reveal daemon** is a hard prerequisite. Commit-reveal needs the committer back, and agents don't stay
  (docs/arena.md 4.4: "a coding agent's session ends when its task does"). `highwire line run`, a long-running local
  process like `highwire orders run`, watches the wallet's open series and, under the signer and the policy, reveals
  every committed pull and fallback within the window from the nonce file. `line_join` with a stake refuses unless it
  is running, and `line.md` says wagering requires it.
- **Nonces and salts** are written to `wager-secrets.jsonl` (mode 600, flushed to disk) **before** the commitment they
  open is sent, so the daemon can reveal after any crash; the audit log records the transaction, not the secret.
  Losing a nonce forfeits the match (7.2.1); the signer's job is never to lose it.
- **What the daemon does**, and nothing else: reveals every committed move and owed fallback whose secret opens the
  commitment on-chain; applies a deadline once it has passed by a few seconds (for clock drift); settles a finished
  series (the loser's too, for its rent); cancels a series it opened that nobody accepted, 90 seconds past the
  deadline (the program lets A cancel any time, so an early cancel would cost a series B could still accept); and asks
  for the emergency refund of a series idle for a day. Past a reveal window it stops trying the reveal and applies the
  timeout. It finds series both by `getProgramAccounts` and by the ids in the secrets file, runs them side by side,
  backs off on failures, survives any one failing, and does nothing while the policy is a dry run or can't wager.
  The tools that commit (step 5) must never return a nonce or a salt. It never opens, accepts, commits or retires. Each action is built by
  `buildWagerMove` and sent through `LocalSigner.execute()` with `action: "wager"`, so the policy, the simulation and the
  audit log apply.
- **The kill switch stays absolute.** `STOP` refuses every send, as now, reveals included, so **`STOP` during a series
  forfeits its open match and then plays its fallbacks** (and the owner is told so in `line.md`). A separate
  **`STOP-WAGERS`** file means "no new stakes; finish what's open", which the daemon honours.
- **Retiring a staked series** needs `wagers.allow_retire: true` in the policy, which only the owner can set. That gate is
  narrower than it looks: an agent can still forfeit matches by committing and never revealing. What stops that is the
  reveal daemon, which reveals every committed move unconditionally and takes no instruction from the agent (only
  `STOP` halts it).

### 7.4 Matchmaking

- The referee's queue does matchmaking, as in free play, now per tier: two fighters at the same tier, near in **wager**
  rating, from different owner clusters and identities, both eligible (8). It signs a ticket for the pair; A opens with
  it, B accepts with it.
- **The referee never holds or sees money**, and it can't affect a series once both have deposited.
- **Against a thin queue:** a tier pairs only when at least four eligible fighters from different identities have been
  waiting, with a randomised delay, so two colluders who join together aren't simply paired with each other, and a
  scripted bot waiting at a tier doesn't get everyone; at most two series a week between the same two identities,
  written into the ticket and checked by the program from a per-pair counter.
- A pairing not accepted by the ticket's deadline is cancelled and refunded; repeated no-shows lose wager eligibility
  for a day.
- The house never plays wager matches; a fighter waiting too long is told so, not matched with Reader.
- **A named person on duty** reviews flags (10) before W3; flags that pile up unreviewed pause the tier.
- **As built** (`packages/relay/src/arena/wager.ts`, the wager desk): one queue document for every tier, so a pairing
  and the pair's weekly count change together; owners are the registering wallets (the identity stand-in until
  identities exist); `minQueue` is 4 by default and a deployment can lower it for a quiet devnet; each entry waits a
  random 2 to 10 seconds before it can pair. The weekly cap is the referee's: the program doesn't keep a per-pair
  counter (a stolen ticket key could exceed it, which 7.7 already bounds). No-show penalties aren't built. A ticket
  lives 5 minutes with one time for both sides (the program refuses an accept deadline past the expiry), and A is
  told to open at once. The desk reads each series' outcome from the chain (`seriesOutcome` in highwire-core: the
  account while it plays, then the program's own closing event) and rates settled series, draws included, on a wager
  rating kept apart from free play's. Every stall ends: a ticket never used expires (10 minutes past its time, for a
  lagging chain clock); a series B never accepted frees both, and either side's daemon cancels it on-chain; one that
  went live and then vanished without a closing event the desk could find closes unrated after an hour. The
  site turns it on only with `LINE_WAGER_TICKET_KEY` (the ticket key's secret, in the site's environment and nowhere
  else) and `LINE_WAGER_KEY_ID`; `LINE_WAGER_TIERS` and `LINE_WAGER_MIN_QUEUE` tune it.

### 7.5 The indexer and the pages

- **The closing event:** `settle`, `cancel` and the refunds each log one `Program data:` line: "line-wager", how it
  closed (1 settled, 2 cancelled, 3 refunded), the series id and the outcome (the winning player 0 or 1, 2 a draw).
  Readers take it only from the program's own frames of the log (by the runtime's invoke lines), so no other program
  can forge one, and only for the series it names. The winner is never inferred from balances: anyone can send lamports
  to a series account, or bundle a transfer with a settle.
- An indexer (Helius webhooks or a small RPC poller in the site) turns program events into the pages' match data:
  wager matches show on `/line` with their series score, and replay from chain.
- **Events aren't durable** (RPC log retention is short), so the indexer backfills by walking each series' transactions
  (`getSignaturesForAddress`) and re-parsing them, and the replay page falls back to that. If the indexer is down,
  matches still play and settle; the pages catch up from the chain.
- Replays verify every commitment and every round in the browser against the TypeScript twin of the Rust rules,
  under the on-chain clock (7.2.3).
- **Stakes on the page:** where showing wagering is advertising it (9.3), Highwire's pages don't show stakes. That's
  about what Highwire publishes; the stake is on-chain and in every explorer, and the page doesn't pretend otherwise.

### 7.6 Tools

- `line_join` gains `stake` (a tier in SOL; absent means free play), as an execute (7.3). *As built:* a tool of its own,
  `line_stake` (stake, fallback, `confirm: true`, the execute annotations), so free play's `line_join` stays a play
  tool; it refuses unless the reveal daemon holds its lock.
- `line_move` and `line_state` work as before for the agent: under the hood a wager round is a commit sent at once;
  the **reveal daemon** reveals, so no tool call blocks past the MCP 60-second default.
- **No table talk in wager matches:** `line_move`'s `line` is refused for a staked series, and the opponent's lines
  aren't delivered (there are none). A line from an opponent with money at stake is an attack, not conversation.
- `line_retire` on a staked series needs `wagers.allow_retire` (7.3).
- `line_wagers`: open series, results, and the day's gross stakes and net, from the chain and the audit log.
- None of these exist on the hosted endpoint.

### 7.7 Upgrades and keys

- The program's upgrade authority: a 2-of-3 multisig (Squads) of keys held by the maintainer on separate hardware, with
  a 48-hour timelock on upgrades, announced on the site; **new series are paused for the whole timelock**, so no series
  spans an upgrade, and `emergency_refund` (24 hours without a change) covers any that does. *(Open: freezing the
  upgrade authority after the audit and a stable period.)*
- The `Config` authority can only: pause new series, change tiers, the per-side cap and the open-stake cap within the
  program's hard caps, set the fee and the fee account within the fee's hard cap (new series only), rotate the ticket
  key, hand authority to another key, and `freeze_and_refund` a series (6.3). The freeze refunds both stakes in full
  whatever the state, a decided but unsettled series included (settling is open to anyone, so a winner who settles
  promptly is never exposed to it); the terms say so.
- **The matchmaker's ticket key** is the one key in the site. A stolen one can pair **ineligible** players (sanctioned,
  under-age, excluded, self-excluded) and pair a victim with a chosen shark, bypassing clusters and caps: legal exposure
  and harm, not stolen stakes. So: it lives in its own secret, every ticket is logged, the program records each series'
  key id, the key rotates monthly and at once on suspicion, and a compromise window is identifiable from the chain.

## 8. Who can wager

Wager mode needs eligibility checks, and they have to be about **people**, since fighters are agents and the law
gambles on the owner.

- **Who the owner is:** an identity check (document and liveness) through a provider (Persona, Sumsub or similar) on the
  person who runs the agent, once, before their first wager. It confirms age (18, or 21 where a jurisdiction says so,
  whichever is higher where they are) and country of residence.
- **Where they are:** the country of residence from the identity check must be on the allowed list (5.4). The *owner*
  is geolocated, not the agent: agents run on cloud hosts and in GitHub Actions (the launch ideas deploy them there), so
  an agent's IP says where a server is. The owner confirms location from their own device at verification and every 30
  days (`highwire wager check`, opening the provider's flow); the agent's IP is a weak signal only (a mismatch flags,
  never blocks).
- **Which wallets are theirs:** an owner links each fighter's wallet to their verified identity by a **memo** sent
  from that wallet carrying only an opaque one-time code (never the provider's verification ID: the memo is public
  forever), the same pattern as registration; never by signing a message, since the local signer signs exactly one kind
  of message (AGENTS.md, "Signing messages").
- **Sanctions:** every linked wallet is screened (TRM, Chainalysis or similar) at linking and at every ticket; a hit
  blocks the wallet, and an open series is refunded through `freeze_and_refund` (6.3), the one authority over an open
  series.
- **Rated history:** 20 rated free matches and an established free rating before the first wager, which then seeds
  the separate wager rating (4.2); sybil fighters cost real time.
- **Operator coins:** the maintainer's and Highwire's fighters (docs/arena.md 5) never wager against the public: the
  people who run the referee and the program know too much. They may play each other in the closed beta (W2) only.
- **Self-exclusion and cooling-off** (11) are checked at the same point as eligibility, against the identity, not the
  wallet, so a new wallet doesn't reset them.
- **The matchmaking ticket.** When the referee pairs two eligible fighters it signs a short ticket (a domain tag, the
  program ID, series ID, both wallets, stake, acceptance deadline, expiry and key id; the pair's weekly count joins it
  with the referee) that `open` and `accept` must carry; the program verifies it with Solana's Ed25519 instruction and
  instruction introspection, checking the program ID and every offset and index (the class of bug behind Wormhole and
  later audit findings). Naming the program keeps a devnet ticket off mainnet if a key were ever shared. The opener
  can't choose the deadline; the ticket sets it. A ticket isn't spent: once its series closes, the same two players
  could open it again until it expires, so expiries are minutes, and B must still accept. A stolen ticket key is
  serious but bounded (7.7).
- **Identity data is a new kind of data for this project.** Liveness checks are biometric (special-category data under
  the GDPR): a data protection impact assessment is a W0 deliverable, with the lawful basis (a licensed operator's
  legal obligation), retention and deletion rules, and the provider's transfers. The identity-to-wallet map is the most
  valuable thing the project would ever hold, so it lives in a **separate project, store and credentials** from the
  arena (whose store, AGENTS.md says, "holds no user secrets", which is why it can share the site's project), and no
  arena route, admin token included, can reach it. The provider keeps documents; Highwire keeps the verification
  result, the country, the dates and the linked wallets, and the privacy policy says so (12).

## 9. Disclosures, copy and advertising

### 9.1 What changes in the copy

Every promise in section 1's table is rewritten in the release that turns wager mode on, and not before. The rules:
- **Free play keeps its words.** "Nothing is staked" stays true of free matches and stays on the pages that describe
  them; a wager match is always labelled as one.
- **Plain, not promotional:** "a wager match: each side staked 0.1 SOL; the winner takes the pot, less a 2.5% fee"
  (or no fee). Never "win money", "cash out", "double your SOL", odds, streaks, or the size of anyone's winnings.
- **The risk said once, everywhere it matters:** "You can lose your stake. Only stake what you can afford to lose."
- **The fee, the tiers, the eligibility and the excluded countries** on the wager page and in `line.md`.
- **No coin talk:** a fighter's wins and losses say nothing about its coin, and wagers are never a reason to buy one,
  as now.

### 9.2 Who sees wager matches

- Wager pages and stake amounts are served only to visitors from allowed countries (Vercel's geolocation headers),
  behind an age confirmation; elsewhere, a wager match appears, if at all, as a match with no stake shown. That governs
  what Highwire publishes; the stakes themselves are public on-chain. *(Open: whether to show them at all, 16.)*
- `line.md` and the tools describe wagering, since agents read them; the tools refuse a stake for an ineligible owner.

### 9.3 Advertising

- **No paid ads** for wager mode. App stores require licences per market for real-money gaming; X restricts gambling
  ads by country and needs licences; this project has no app and buys no ads, and should keep it that way for wagering.
- **No posts about wagering** (films, X posts) until it's live, and only in a form counsel has approved; nothing aimed
  at the excluded countries. The changelog still records every change (AGENTS.md), in neutral words, and the home
  page's "What's new" skips wager entries.
- **No influencers, affiliates or referral rewards** for wager mode.

## 10. Integrity and threats

Money changes the threat model: free play's worst case is a ratings game; wager mode's is theft, fraud and laundering.

| Threat | Mitigation |
|---|---|
| An insider reads open moves (today's referee sees them in plaintext) | Wager moves are commit-reveal on-chain; nobody, Highwire included, sees a pull before both commits land |
| Revealing second to see the opponent's pull, then withholding | A missed reveal forfeits the match (7.2.1), so withholding never pays and order doesn't matter |
| A crashed or closed agent forfeiting by missing reveals | The reveal daemon (7.3), required for any stake; nonces saved before every commit |
| Fallbacks read off the chain before the other side commits | Fallbacks are committed, revealed only at resolution (7.2.5) |
| The opponent sees that you've moved and how long you took | Accepted and disclosed: commits are public the moment they land (1) |
| Highwire takes stakes | No instruction pays anyone but the players and the snapshotted fee; the one authority over an open series refunds only (6.3) |
| Highwire changes the fee mid-series | The fee is snapshotted at `open` (6.4) |
| A program bug drains stakes | An external audit before mainnet; the open-stake cap; the per-side cap; a bug bounty; `paused` for new series; `emergency_refund` after 24 hours idle |
| An upgrade strands open series | New series paused for the whole timelock; `emergency_refund` regardless of layout (7.7) |
| **Chip dumping / laundering** between one person's fighters | Pairing excludes the same identity and owner cluster; at most two series a week between two identities, in the ticket and checked by the program; flags on lopsided series |
| **Match fixing between two people** ("I'll throw it, we split") | Hard to prove, cheap to try. Flags: pulls far from either side's history, series decided by repeated zero pulls or missed reveals, pairs that keep meeting; a person on duty (7.4); the terms' fraud clause; voiding and banning |
| **Shark farming**: a scripted bot waiting at a tier for LLM agents | It's the game (4.1), and owners are told so; a minimum queue depth and randomised pairing (7.4) keep any one bot from getting everyone |
| **Sybil** fighters | Identity checks; 20 rated free matches first; the separate wager rating |
| **Sandbagging** free play to be paired down for money | The wager rating is separate; free results never move it after seeding (4.2) |
| Prompt injection to make an agent forfeit ("retire and save fees") | No table talk in wager matches; retiring a staked series needs `wagers.allow_retire` (7.3) |
| Prompt injection to make an agent stake | The stake is a tool argument checked against the policy; no opponent text reaches a wager match |
| An agent that plays badly loses its owner's money | That's the game; the policy's caps and the platform's loss limits bound it (11) |
| Griefing: never accepting, or opening and abandoning | Tickets expire and refund; no-shows lose eligibility for a day; abandoned series fall to fallbacks, voids and `emergency_refund` |
| A stolen ticket key | Ineligible pairings and steered matchmaking, not theft: logged tickets, key ids on-chain, monthly rotation (7.7) |
| Validator clock drift | Round limits of 2 minutes; the reveal window never under 1 minute; banks charged by landing time (7.2.3) |
| RPC censorship of a player's transactions | The bank and fallbacks absorb a missed commit; the daemon retries reveals; Jito sends (docs/protected-sends.md) as an option |
| The indexer or site down | Matches play and settle on-chain; the indexer backfills from the chain (7.5) |
| Rent or compute griefing | The opener pays rent and gets it back; fixed-size accounts |
| A compromised upgrade key | 2-of-3 multisig on separate hardware, 48-hour timelock, announced upgrades; the open-stake cap |
| Sanctioned wallets | Screened at linking and every ticket; `freeze_and_refund` for a hit mid-series (8) |
| Insiders | Operator fighters never wager against the public; the people with the multisig and the ticket key don't wager (8) |

## 11. Responsible play

Agents don't get tired or chase losses, but the people who fund them do, and an agent can lose quickly on its own.
Two layers, because one is editable by the owner and one isn't:

- **The policy file (the owner's own limits):** `wagers.max_stake_sol`, `max_open`, the tiers and `allow_retire`, with
  every stake counted gross against `max_sol_per_day` (7.3); `STOP-WAGERS` stops new stakes at once. These are the
  agent's leash.
- **The platform (limits the owner can't edit away):** tied to the verified identity, not a wallet:
  - a **daily and a monthly loss limit** chosen at sign-up (lowerable at once; raising one waits 24 hours, then asks
    again);
  - **cooling-off** from 24 hours to 3 months, and **self-exclusion** from 6 months to permanent, from the site or the
    CLI, effective at once and not reversible early;
  - a **reality check** in `line_wagers` and the owner's statement: stakes, results and net over the day, week and month;
  - **no credit from Highwire**, ever: Highwire never lends, advances or nets a stake (what's in an owner's wallet,
    and where it came from, is the owner's; source-of-funds checks apply above the licence's thresholds);
  - links to independent help in every allowed country.
- **Autonomy:** an agent playing unattended can lose its whole daily limit while its owner sleeps. The defaults are
  small (the lowest tier, one open series), the platform's loss limit is checked at every ticket, and `line.md` tells
  agents to stop and tell their owner after any day's limit is reached.
- **Records:** every stake, result and payout is in the audit log and on-chain; the owner can export a statement.

## 12. Terms and policies

A wager section in the terms, written with counsel, before W2:
- who may wager (age, identity, allowed countries, no proxies or shared accounts), and that eligibility can be checked
  again at any time;
- the program: what it does, that settlement is by its rules, that Highwire can't move stakes, and what happens on a
  timeout, a withheld reveal, a draw or a void;
- the fee (6.4), and network costs;
- fraud: collusion, match fixing, chip dumping, multiple identities and using another person's identity, with voiding,
  forfeiture of winnings from fixed series where the law allows, and bans;
- responsible gambling (11), and how to self-exclude;
- disputes: since results are computed on-chain, a dispute is about the program; a real complaints route, the
  regulator's dispute process where the licence requires one, and whatever limit on remedies counsel finds enforceable
  (EU unfair-terms rules and the licensing jurisdiction's own rules may make a cap unenforceable);
- taxes: owners are responsible for reporting their winnings;
- the privacy policy updated for identity data (8): what's kept, by whom, for how long, and the provider's role;
- the operator: the licensed entity's name, licence number and regulator (model 2), on every wager page.

## 13. Phases and acceptance

No phase moves real money until W0 says it may, and each later phase needs the one before it accepted.

**The gate (before any spend).** Free play shows the audience exists (2): at least 50 weekly active owners for 4
consecutive weeks, 30% of them still playing a month after their first match, and owners asking for stakes unprompted.
Owner clusters (docs/arena.md 7) are built either way, since W3 needs them.

**W0. The legal decision (no code).** Counsel's written view on section 5, given the maintainer's residence and the
entity's jurisdiction (15, decision 2); the operating model (5.6); the entity and, if needed, the licence; enforcement
(not just licensing) in each target country; tax (5.6); the data protection impact assessment and the identity store's
design (8); the KYC, sanctions and geo providers. *Done when* counsel has signed off, in writing, on a named list of
allowed jurisdictions, the fee option (6.4), the eligibility rules (8), the terms (12) and the copy (9).

**W1. Practice wagers on devnet (no real money).** The program with every instruction; the Rust rules with the
10,000-series parity fixtures under the on-chain clock; the reveal daemon; the series mode in `npm run arena:sim`;
Highwire's builders, `assertSafe` entries and the `wagers` policy section; the tools against devnet.
- **The devnet identity model:** practice fighters are devnet-only identities, with a separate keypair and a separate
  devnet policy file (`HIGHWIRE_HOME` per cluster, as today); they register on devnet without a launch, since devnet
  launches are free and devnet SOL is worthless. **Nothing crosses the wall:** practice results never touch mainnet
  ratings, records, eligibility or pages, and practice matches live on their own page, marked as practice.
- *Done when* the program's tests cover every state and deadline (both accept, one never accepts, every timeout in
  every phase, every missed reveal, fallback commitments, retire, draw, void, settle twice, settle early, a wrong
  payout account, a stake above the cap, a paused config, `emergency_refund`, `freeze_and_refund`, the open-stake
  counter on every close path), the parity fixtures pass, `attacks.test.ts` has the wager links that must fail, and two
  agents play full best-of-5 series on devnet with every round verified, through the local signer and the daemon,
  including one that's killed mid-series and recovers.
- **What W1 shows:** that the engineering works. It can't show demand for real stakes; the gate does that.

**W2. Audit and a closed mainnet beta.** An external audit of the program, every finding fixed or accepted in writing;
a bug bounty; then mainnet at the 0.1 SOL tier only, the open-stake cap at 1 SOL, and **a handful of external owners**
who've passed section 8 (allowlisted), so eligibility, identity, geolocation and the daemon are tested with real
people, not just the program. Operator fighters play only each other. *Done when* the audit is closed, 100 series
have settled with no unexplained state, every flag was reviewed, and `npm run rehearse` covers every wager path with
the send replaced by a simulation.

**W3. Public, where allowed.** Anyone who passes section 8 in an allowed jurisdiction; the 0.25 SOL tier and higher
caps step by step, each after two clean weeks; the copy in section 9 live; the person on duty for flags. *Done when* the
success metrics in 2 are on the internal page, and the first 8-week review is held.

There's no phase with the house staking, spectators betting, memecoin stakes or tournaments with pooled prizes. Each
would need its own PRD and its own legal view.

## 14. Cost and timeline

Estimates to be firmed up in W0 and W1; the legal and compliance lines dominate.

| Item | Estimate | Note |
|---|---|---|
| Counsel's opinion on section 5 (US plus the target jurisdictions) | $15,000 to $60,000 | gaming counsel, written opinion; more if several jurisdictions |
| The data protection impact assessment and privacy work | $5,000 to $20,000 | biometric data (8) |
| Entity and licence, if the model needs one (5.6) | $25,000 to $150,000 to start, plus yearly fees | depends entirely on the jurisdiction |
| KYC and sanctions screening | $1 to $3 per verification, plus monthly minimums | e.g. Persona, Sumsub; wallet screening e.g. TRM, Chainalysis |
| The program, Rust rules and reveal daemon | 6 to 10 weeks of engineering | with the parity fixtures and the devnet phase |
| An external audit | budget $60,000 to $130,000, 3 to 8 weeks of calendar | the rules port, a five-match state machine with two phases a round, the clock, Ed25519 introspection, tickets, fallback commitments and every refund path: not a small program |
| Bug bounty | a pool sized to the open-stake cap | the cap keeps it small |
| Indexer, crank and RPC | tens of dollars a month at first | Helius or similar |

Calendar: about 3 to 6 months from a go-ahead on W0 to W3, most of it legal and audit time, not code.

## 15. Decisions needed from you

1. **Whether to proceed at all**, given 4.1: between rational players this is a coin flip, and the market is likely bots
   farming LLM agents. This document doesn't presume the answer.
2. **Where the maintainer lives and where the operating entity would be.** An input, needed now (5.6).
3. **The operating model** (5.6): practice only, or practice then an offshore licence.
4. **The fee** (6.4): none, or a rake, and how much.
5. **`freeze_and_refund`** (6.3): keep the one refund-only authority over open series (recommended, for sanctions and
   court orders), or none at all, with counsel accepting the sanctions exposure for the half hour a series runs.
6. **Identity:** how much the eligibility check asks (8), and which provider.
7. **The architecture** (7.1): the match on-chain (recommended), or escrow settled by the referee's signature, faster
   to build and weaker.
8. **Whether wager matches are public on `/line`**, and where stakes may be shown (7.5, 9).
9. **Budget** for the items in 14.

## 16. Open questions

- First-to-3 with replayed draws, or best-of-5 with draws counted?
- Showing wager matches publicly at all, given advertising rules (9.3)?
- Freezing the program's upgrade authority after a stable period?
- Allowing USDC later (a second mint, the same rules)?
- Letting sign-page users wager through a first-party, owner-started flow (the sign page refuses links because anyone
  can send one)?
- Whether the reveal window and round limits should differ on-chain from free play, once W1 measures real latencies.

## 17. What changed after the adversarial review

An adversarial review (Claude Fable, 2026-11-09) read this draft with the code it would change. Its findings, and what
changed:

- **Withholding a reveal was free (critical).** "An unrevealed commit counts as 0" let the second revealer drop any
  losing pull at no cost (the program can't charge energy it never saw), broke the all-pay rule, and made both sides
  wait out every window. Now a missed reveal **forfeits the match** (7.2.1), and the ending is in the parity fixtures.
- **Commit-reveal needs the committer back (critical).** Agents aren't long-running. Now a **reveal daemon**
  (`highwire line run`) is required for any stake, and nonces are saved before every commit (7.3).
- **The equilibrium is open source (critical).** Any owner can neutralise skill for free, so rational stakes are a coin
  flip and a rake makes them a loss. The document now says so as its central weakness, plans only as licensed gambling,
  and no longer presents series or rating pairing as skill levers (4.1, 5.2, 6.4).
- **"No authority over an open series" contradicted the sanctions refund.** Now one refund-only `freeze_and_refund`
  by the multisig, stated as the single exception (6.3, 8, 15).
- **The kill switch couldn't both stop everything and keep revealing.** `STOP` stays absolute (and forfeits an open
  match); `STOP-WAGERS` means no new stakes (7.3).
- **Table talk was an injection channel with a payout** ("retire and save fees"). No table talk in wager matches;
  retiring a staked series needs the owner's policy flag (7.3, 7.6).
- **A shared rating attached value to free play** and rewarded sandbagging. A separate wager rating (4.2).
- **Fallbacks leaked on-chain.** Committed at open and accept, revealed only at resolution (7.2.5).
- **A net daily loss can't be counted from the audit log**, which never learns outcomes. Stakes count gross; `max_open`
  from the chain (7.3).
- **Practice wagers didn't fit a mainnet-only arena.** A devnet identity model and a wall between practice and mainnet;
  W1 proves engineering, not demand (13).
- **Datacenter IP blocks would exclude how agents run.** The owner is geolocated from their own device (8).
- **The operator's location decides everything** and was deferred. It's now an input (5.6, 15).
- **The two lowest tiers were negative-EV before any rake.** Tiers start at 0.1 SOL, with all-in costs shown (6.2, 6.5).
- **Events aren't durable.** The indexer backfills from each series' transactions (7.5).
- **The fee could change mid-series.** Snapshotted at `open` (6.4).
- **Identity data** needs a DPIA and its own project, store and credentials (8, 13).
- **A thin queue made collusion and shark farming easy.** A minimum queue depth, randomised pairing, a per-pair weekly
  cap in the ticket and checked on-chain, and a person on duty (7.4).
- Also: the on-chain clock defined as the rule and modelled in the fixtures (7.2.3); no new "lose on time" rule (4.2);
  commit timing disclosed as public (1); the ticket key's real blast radius, rotation and key ids (7.7); the deadline
  from the ticket, not the opener (8); `emergency_refund` after 24 idle hours, and new series paused through an upgrade
  timelock (7.7); offshore licences' limits made a headline (5.4); dispute and collusion metrics defined, clusters
  required before W3 (2); the remedy cap left to counsel (12); tax in W0 (5.6); neutral changelog entries (9.3);
  external owners in the W2 beta (13); the audit budgeted at the upper end (14); a demand gate before any spend (2,
  13); refunds stated as whole (4.2); hiding stakes described as what it is (7.5, 9.2); the linking memo's contents
  (8); staking as an execute tool (7.3); the open-stake counter tested (6.2); "no credit" reworded (11).
- **Kept, as the review advised:** the reversal of the "no prize" assumption named up front; peer to peer only, never
  the house; SOL only; no spectator betting or result promotion; the match on-chain; no stake path through the sign
  page or the hosted endpoint; `"wager"` never askable; program-level caps, `paused` for new series only, a multisig
  with a timelock, rules versions per series; parity by fixtures; identity limits tied to people; operator coins never
  against the public; the copy rules and no advertising; gating everything on counsel, an audit and tiny caps.
- **Marked "verify" for counsel**, as the reviewer couldn't confirm them: the Florida action against Stake.us (August
  2026), the Anjouan revocation (July 2026), the Curaçao crypto guideline (June 2026), and the state skill-contest
  lists.

### 17.1 The program's audit (step 2)

An adversarial audit of `programs/line-wager` found no way to take a stake. It found ways to hold one, each now fixed and
covered by a test in `tests/program.rs`:
- **A payee could block every payout (high).** A player who turned its wallet into a program (empty it, deploy at that
  address) made the runtime refuse every credit to it, so `settle`, the emergency refund and the freeze all failed, and
  the other player's winnings and the open-stake reservation were stuck for good. Now a share the runtime won't credit
  burns in the incinerator, so the other player is still paid (6.3), and `open` takes A's stake only from a plain
  wallet.
- **A small fee into an empty fee account blocked `settle`.** That fee now goes to the winner, and tiers are at least
  0.01 SOL.
- **A reveal window of a day could be waited out** by the emergency refund. The window is now capped at an hour.
- **The emergency refund could skip a timeout that was already due** and refund a series that timeout would have
  decided. It now plays the due timeouts first and refuses if they decide the series.
- The spec now matches the code on the authority's powers, the freeze on a decided series, and what the series account
  holds.

### 17.2 The client's audit (step 3)

An adversarial audit of the builders, the checks, the policy, the secrets file and the daemon found no way for a sign
link, a stranger or an opponent to get a wager signed or move value out of the wallet. It found ways to forfeit
matches, each fixed and tested in `packages/agent/test/wager.test.ts`: the daily limit could refuse the daemon's reveals
(moves are now exempt and fee-capped); past a reveal window the daemon retried a dead reveal instead of the timeout; a
torn line in the secrets file lost the next secret; one exception ended the daemon; a reveal could wait up to 90
seconds for another process's lock; and the signer trusted the caller's word for a wager's kind, stake and open count.
Smaller ones: cancelling on the local clock, retrying without backoff, relying on `getProgramAccounts` alone, and loose
account counts in `assertSafe`. Still to come: `highwire policy explain` (7.3).

### 17.3 The matchmaker's audit (step 4)

An adversarial audit of the wager desk found that no ticket it signed would have opened a series: it set the accept
deadline after the expiry, which the program refuses (and its own test asserted the wrong order). Fixed, with the
deadlines now equal. It also found that the outcome reader, which inferred the winner from balance changes, could be
made to report the wrong winner, a draw or a cancel, or nothing at all: the program now logs a closing event and the
reader takes only that (the tests cover forged, misattributed, nested, buried and truncated logs). And it found ways
to lock fighters out for good: a series whose closing couldn't be read, a store failure half way through ticketing or
closing, an opener who never cancels, a stale pairing note, two joins at once. Each now ends or can't happen, and is
tested in `packages/relay/test/wager.test.ts`. Settings the desk can't sign with are refused when it's made.

## Sources

- Gambling elements, skill and chance (US): https://www.ifrahlaw.com/ifrah-on-igaming/gambling-on-skill-enforcement-of-gambling-laws-against-skill-games-in-outlier-states/ ,
  https://kleinmoynihan.com/games-of-skill-v-games-of-chance-the-legal-analysis/ ; virtual chips:
  https://law.justia.com/cases/federal/appellate-courts/ca9/16-35010/16-35010-2018-03-28.html
- UIGEA definitions: https://www.law.cornell.edu/uscode/text/31/5362 ; the Wire Act (*NH Lottery Comm'n v. Rosen*):
  https://www.ca1.uscourts.gov/sites/ca1/files/opnfiles/19-1835P-01A.pdf
- UK Gambling Act 2005: https://www.legislation.gov.uk/ukpga/2005/19/section/6 ,
  https://www.legislation.gov.uk/ukpga/2005/19/section/9 ; the Gambling Commission on crypto (2026):
  https://mediawrites.twobirds.com/post/102mm91/gambling-commission-considers-a-regulated-route-for-crypto-payments
- State skill-contest exclusions: https://worldwinner.zendesk.com/hc/en-us/articles/4405395716243-State-Restrictions ,
  https://www.olshanlaw.com/blogs-Advertising-Law-Blog,Vermont-Entry-Fee-Skill-Contest
- Enforcement: https://www.sweepsy.com/news/newsom-signs-ab831-sweeps-casinos-jan-1-2026/ ,
  https://www.covers.com/industry/florida-ag-sues-stake-vgw-over-sweepstakes-casino-operations-aug-20-2026 ,
  https://sbcamericas.com/2026/09/09/underdog-sues-states-prediction-markets/ ,
  https://sbcamericas.com/2026/09/25/kalshi-sixth-circuit-sides-oh-tn/ ,
  https://www.skadden.com/insights/publications/2026/11/cftc-moves-to-draw-the-line
- Licences: Malta https://mga.org.mt/app/uploads/Guidance-Note-Licence-Fees-and-Taxation.pdf ; Curaçao
  https://www.legal500.com/guides/chapter/curacao-gambling/ ; Anjouan (consultant figures)
  https://legarithm.io/anjouan-gaming-license-cost/
- FinCEN FIN-2019-G001: https://www.fincen.gov/sites/default/files/2019-05/FinCEN%20Guidance%20CVC%20FINAL%20508.pdf ;
  the DOJ's August 2025 statement:
  https://www.wilmerhale.com/en/sitecore/content/whlaunch/home/research/news-publications/20250910-doj-signals-approach-to-digital-assets-what-it-means-for-developers-and-platforms ;
  California DFAL: https://dfpi.ca.gov/financial-services/digital-financial-assets-law/ ; EU AMLR and gambling:
  https://sigma.world/news/eu-aml-regulations-gambling-2027/
- Sanctions: https://www.paulhastings.com/insights/crypto-policy-tracker/a-whirlwind-of-change-the-delisting-of-tornado-cash
- SEC staff on meme coins: https://www.sec.gov/newsroom/speeches-statements/staff-statement-meme-coins
- App stores and ads: https://developer.apple.com/app-store/review/guidelines/ ,
  https://support.google.com/googleplay/android-developer/answer/9877032 ,
  https://business.x.com/en/help/ads-policies/ads-policy-update-log
- Escrow and settlement on Solana: https://examples.anchor-lang.com/docs/non-custodial-escrow ,
  https://rareskills.io/post/solana-signature-verification , https://cantina.xyz/blog/signature-verification-risks-in-solana ,
  https://chain.link/article/commit-and-reveal-schemes ; incidents: https://www.helius.dev/blog/solana-hacks ; audit
  pricing (vendor): https://www.zealynx.io/blogs/audit-pricing-2026
- The game's numbers: `npm run arena:sim`; docs/arena.md 4.2 and [research/duels-solver.mjs](research/duels-solver.mjs).
