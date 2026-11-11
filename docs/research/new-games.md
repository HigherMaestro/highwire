# Two more games for the arena: The Lot and Three wires

Status: **prototypes in the simulator, 2026-11-10. Nothing is built for the referee or the wager program.** The rules
are in `packages/core/scripts/games/`, outside what `highwire-core` ships, and `npm run games:sim` plays them. Every
number here comes from that script; the "LLM-like" players are hand-written habits, as in docs/arena.md 4.5, not models.

The question behind both: The Line solves exactly in under a second and the solution is open source, so between
rational players a staked match is a fair coin (docs/wager-mode.md 4.1). Would a second game be harder to solve, and
how would language-model-like play fare in it against a Reader-style player?

**The short version.**
- **No game fixes the coin flip.** Both games are symmetric and zero-sum, so two equilibrium players split evenly in
  them too. A harder game only changes who can reach the equilibrium.
- **The Lot is solved, just less cheaply:** 4.4 minutes on a laptop at the draft's size, and days of computing at the
  largest size costed. Its *Even* is as free as The Line's once someone publishes the table.
- **Three wires has no cheap exact solution:** 52 days on one thread at the very least, by the method that solves The
  Line. That isn't safety: nobody here built the approximate methods a specialist would use, and an edge that takes
  solver engineering goes to bot builders, the market wager mode already worries about.
- **The Lot is gentler on LLM-like play.** Its true Reader beats the three LLM-like players by +0.30 to +0.61, against
  +0.61 to +0.85 on the wire. It draws less (5%), runs shorter (7.8 rounds), and needs **randomness on-chain**, which
  The Line's program doesn't have. A design for it that takes input from the two players only is in 1.5; two adversarial
  reviews broke its first version and found more (1.6).
- **Three wires isn't a finished game yet.** Cautious players draw each other more than half the time, naive play
  loses in three rounds, and long matches end in a scramble for the few points of energy each side regains.
- **Recommendation:** neither goes into the program before its audit. If one is pursued, The Lot is nearer to ready.
  What's worth doing before the audit is making room for a second game in the series account (below).

## 1. The Lot

A sealed-bid game after Goofspiel, with a budget instead of cards.

### 1.1 Rules (`lot-draft-1`)

- **The prizes:** nine, worth 1 to 9. One is on offer each round. Nobody knows the order in advance: the next prize is
  drawn from those left when the round before it resolves.
- **Energy:** each side starts with 30. Nothing comes back.
- **A round:** both sides secretly bid (0 to their energy). The bigger bid takes the prize; a tie burns it. Both pay
  what they bid.
- **Winning:** more prize value wins. The match ends as soon as the side behind can't catch up, so at most nine rounds;
  level at the end is a draw.

### 1.2 How solvable

Backward induction over every set of prizes left, pair of energies and lead, with the next prize as a chance move
(`solveLot`):

| Prizes | Energy | Matrix games | Solved in |
|---|---|---|---|
| The Line, for comparison | 30 | 72,000 | under 1s |
| 1 to 7 | 20 | 1,918,644 | 9s |
| 1 to 8 | 24 | 8,142,800 | 48s |
| **1 to 9 (the draft)** | **30** | **35,790,678** | **4.4 minutes, 341 MB** |
| 1 to 11 | 45 | 582,019,416 | not run: an hour at the very least |
| 1 to 13 | 60 | 6,827,054,364 | not run: 11 hours at the very least, more likely days |

The estimates use the 8-prize row's time per game, and bigger energies mean bigger matrices, so they're floors. All of
it is one thread of TypeScript; compiled and in parallel it's far less. **Making The Lot bigger buys days, once**, and
then the table is a download.

### 1.3 How it plays

The draft, 1,000 matches a pairing, with the exact *Even* and a *Reader* built on it the way the house's is
(`npm run games:sim -- --exact --prizes 9 --energy 30`). *Scout* is a Reader that needs no solver: a model of the
opponent's bids and a rough guess at a state's value.

| | even | reader | scout | random | steady3 | fair | outbid | rounder | storyteller | chaser |
|---|---|---|---|---|---|---|---|---|---|---|
| **Even** | -0.01 | 0.00 | 0.23 | 0.97 | 0.37 | 0.16 | 0.83 | 0.12 | 0.22 | 0.64 |
| **Reader** | 0.05 | 0.02 | 0.18 | 0.92 | 0.88 | 0.79 | 0.93 | 0.49 | 0.30 | 0.61 |
| **Scout** | -0.23 | -0.16 | 0.02 | 0.97 | 0.96 | 0.40 | 0.94 | 0.16 | 0.01 | 0.73 |

| Pairing | Draws | Rounds | Decided early | Round-1 winner wins |
|---|---|---|---|---|
| Even v Even | 6% | 7.8 | 62% | 57% |
| Reader v Reader | 5% | 7.9 | 60% | 47% |
| The Line, Even v Even (docs/arena.md 4.2) | 11% | 10.5 | | 59% |

- **Reader still beats everyone**, but by less than on the wire: +0.30 to +0.61 against the LLM-like three (the wire:
  +0.61 to +0.85) and +0.79 to +0.93 against fixed play (the wire: +0.95). *Storyteller* ("little on the small prizes,
  save for the big ones") is a habit a model falls into unprompted, and it holds Reader to +0.30.
- **Why:** each round's prize is different, so there is less to read from nine rounds, and the order is luck.
- **A player without the solver is second-rate:** scout loses to Even by 0.23 and to Reader by 0.16. The solution is
  worth having, and it takes minutes to compute.
- **Two identical fixed players draw every time** (`fair` v `fair`: every prize burned), as two `steady2`s do on the wire.
- **Fewer draws and fewer rounds** than the wire: about a quarter fewer rounds, so that many fewer transactions.

### 1.4 What it would need on-chain

- **Moves fit as they are:** one number a round, the wire's commit and reveal.
- **The draw is new**, and it's the part that has to be right: 1.5.
- **State:** the prizes left (9 bits), two scores and 32 bytes of entropy, in place of the node.
- **No fallbacks in the program.** A missed commit forfeits the match (1.5), so a fallback is the owner's daemon
  committing an ordinary bid when its agent hasn't. `zero` and `steady:<n>` carry over; a fallback that knows the prize
  (`fair`) would be the natural one. A fallback stays private, where the wire's becomes public once played.

### 1.5 The draw, and what was tried against it

The order has to be random, and it has to hold up against players who have read every line of this repository. So
nothing in the design is secret but the seeds and nonces before they're revealed, and nobody but the two players
supplies any input. `packages/core/scripts/games/lot-series.ts` is the protocol; `test/lot-attacks.test.ts` attacks it.

**How it works**
- **Two seeds start it.** A commits to its seed's hash when it opens the series. B posts its seed in the clear when it
  accepts, with A's still hidden. A then reveals. A can't change its seed, and B can't see A's when it picks its own.
- **Nothing is drawn until both seeds are in.** If A doesn't reveal in time it forfeits the match and the window opens
  again, so no prize ever comes from B's seed alone.
- **Each match has its own entropy**, from the two seeds and the match's number. How one match ends can't change a
  draw in a later one.
- **Every round feeds it.** Both sides commit to a bid with a 32-byte nonce, then both reveal. The two nonces are mixed
  into the match's entropy and the next prize is drawn from the result. Each nonce was fixed before the other was
  visible.
- **Walking away forfeits.** The side that reveals second can work out the draw before it reveals. Its only other move
  is not revealing, which forfeits the match, as on the wire (docs/wager-mode.md 7.2.1). **A missed commit forfeits
  too**, so there is no round in which one side alone supplied the randomness.
- **A commitment names its match** as well as its round, when it's sent and in its hash.
- **Anyone can check it:** the seeds and nonces are in the transactions, so a replay recomputes every prize (`auditDraws`).

**What an attacker might try** (each is a test; the last column is what happens)

| Attempt | Result |
|---|---|
| Reveal early, so the opponent sees a nonce before committing its own | refused: no reveal until both commitments are in |
| Replace a commitment after sending it | refused |
| Reveal a different bid or nonce than committed | refused; with no valid reveal, a forfeit |
| Copy the opponent's commitment, to reveal the same nonce after it | the copy names the other side and can't be opened: a forfeit |
| Reuse a commitment from another round, match or series | doesn't open here |
| See the draw, then refuse to reveal | forfeits the match, at every point of a match |
| Skip a commit, so only the opponent's nonce feeds the draw | forfeits the match |
| Call timeout early to force the opponent's forfeit; move after a deadline | refused |
| Hide a bid above the energy left in a commitment | can't be revealed: a forfeit |
| Grind a nonce for a wanted prize (64 tries a round, 3,000 rounds) | hits 1 in 9, as chance does |
| B grinds its seed for the first prize | 1 in 9 |
| A changes or withholds its seed | refused; withholding loses the match, and the window opens again |
| Lose a match by forfeit, not by revealing, to change the next match's opening | the same opening either way |
| Land a commitment from the last match in this one | refused: it names the other match |
| Race to reveal first or second | the draw is the same either way |

Each count of prizes left draws evenly (20,000 draws a count). Ten deliberate breaks of the protocol each fail at least
one test: the draw ignoring one nonce, a commitment that doesn't name its side, an early reveal allowed, a missed
reveal made a void, an early timeout allowed, a biased reduction, entropy running on from match to match, a commit
that doesn't check its match, a missed seed drawing from B's alone, and a clock checked only against the phase.

**Why not something else**
- **Slot hashes:** the block's leader can bias one, and whoever sends the transaction picks which slot it lands in.
- **A randomness oracle:** it removes the moment where the second revealer sees the draw first, and adds a party that
  can withhold selectively, a fee a draw, and an outage that stalls every series, against docs/wager-mode.md 3 ("if the
  referee disappears, every open match refunds or settles on its own"). Not looked up for this draft.
- **A seed from Highwire:** an insider would know or steer the order, which the on-chain match exists to prevent.

**What this doesn't settle**
- **Tests show these attacks fail against this model. They can't show that no attack exists**, and 1.6 is the proof:
  the first version passed its own tests and was wrong. The program would be a second implementation in Rust: it
  needs the wire's parity fixtures and the audit, and this is one more thing for both.
- **A machine that's down forfeits matches** where the wire would play its public fallback, and each forfeit opens the
  next match at once: six minutes offline loses a series from any score.
- **Weak randomness on a player's own machine** lets its opponent predict its nonce and so steer the draw. It only
  hurts the player with the weak generator; the daemon draws its nonces from the system's (`wager-secrets.ts`), and a
  third-party client that doesn't is its owner's risk.
- **Two players colluding** can fix the order between them. They could already fix the result; that's for the
  collusion checks (docs/wager-mode.md 10), not the draw.
- **A validator keeping a reveal out of every block** for the whole window would force a forfeit, as on the wire. The
  window is at least a minute, which is many leaders.
- **Not modelled here:** the chess clock's bank, retiring, stakes and payouts (1.6 on the clock).

### 1.6 What two adversarial reviews found

Two reviewers with no part in the design were given the code and told to cheat it: one the protocol (encodings, the
state machine, deadlines), one the incentives (payoffs across a series, timing, ordering). Both found real problems.

**Fixed in the model**

| Finding | What it was | Now |
|---|---|---|
| **The loser of a match picked the next opening** | The entropy ran on from match to match. In a round that lost it the match anyway, a side could reveal or withhold: both lost the match, each led to a different first prize for the next. It took the better of two, free: its wanted prize opened 21% of the time, not 11% | each match's entropy comes from the seeds and its number alone |
| **A commitment could land in the next match** | `commit` checked the round, not the match. A copy sent for match 1 was accepted as match 2's same round, couldn't be opened there, and forfeited it | a commitment names its match |
| **B's seed alone, if A missed** | with A's seed missing, every later draw started from a seed B chose: about 9 tries to pick an opening | nothing is drawn until both seeds are in |
| **The clock** | an act's time was checked against its phase's start, not the act before | never before the last act |
| **The audit** | accepted records out of order, repeated or beyond the series | refused, with the reason |

The first was worth little (0.05% to 0.5% of a stake a series, on 5 to 8 prizes), and it was exactly the case 1.5
claimed couldn't happen: "walking away forfeits" is only a penalty when the match isn't already lost.

**Not fixed: they're about the game, not the draw**
- **Bidding for the series beats the match's equilibrium, by 8% to 10% of the stake a series** (exact, on 5 to 8
  prizes; the draft's size wasn't run). The solver treats a drawn match as half a win. In a best-of-5 it rarely is: a
  side one match up with one to play wins the series on a draw, so it steers for burned prizes. A player that solves
  each match for the series' score beats one on the published mix, breaking no rule. So **Even is not a series'
  equilibrium**, here and very likely on the wire, which draws more often (11%) and wasn't tested. Two ways out:
  settle a level match by a draw from the entropy, which makes a draw worth half a win again and adds luck; or solve
  and publish the mix per series score.
- **Stalling is free.** With no clock across rounds, a side that uses every window in full stretches a two-minute
  series to over two hours. The wire's bank would have to charge reveals as well as commits, and running out would
  have to forfeit the match, since there's no fallback to play.
- **The solver throws on some states.** `solveMatrix` reports an "unbounded game" (a numerical failure) in a few
  reachable states where the side to move has less energy: 2 at 7 prizes, 30 at 8. A daemon that asked it for a bid
  and didn't catch that would miss its commit. The wire's own solve doesn't hit it.

**One finding reaches the wire.** The Line's series (`src/arena/series.ts`, the wager program's twin) also checks a
commitment's round and not its match, and its instruction carries no match. Checked: a copy of a match-1 round-1
commitment is accepted as match 2's round 1, and forfeits it. It needs a signed commit that hadn't landed (a retry),
arriving at the same round of the next match, so it's narrow. It's a change to the program, not to this prototype.

## 2. Three wires

The Line three times over, from one budget (a round-by-round Colonel Blotto).

### 2.1 Rules (`wires-draft-1`)

- **Three wires**, each of five places, `-2 … +2`, each node starting in the middle.
- **Energy:** 30 each, regaining 3 at the start of every round after the first, up to 30.
- **A round:** both sides secretly split a pull across the wires (three numbers, adding up to at most their energy).
  On each wire the bigger pull moves the node one place; a tie leaves it. Both pay everything they pulled.
- **Taken wires:** a node that reaches an end stays there, and can't be pulled again.
- **Winning:** taking two wires wins at once. After 10 rounds, the side with more wires on its half wins; equal is a draw.

### 2.2 How solvable

A move is a split, not a number. At 30 energy a side has 5,456 of them, so one state's matrix game has 30 million
cells where the wire's has under a thousand:

| Energy | Splits a side | Cells in one round's matrix | Solved in |
|---|---|---|---|
| 9 | 220 | 48,400 | 0.1s |
| 12 | 455 | 207,025 | 4.2s |
| 15 | 816 | 665,856 | 13.7s |
| 30 (the draft) | 5,456 | 29,767,936 | not run |

The whole draft is 10 rounds, 25 ways the nodes can stand and 961 pairs of energies: at most 2.2 × 10¹¹ cells. At the
15-energy row's time per cell that's **52 days on one thread, as a floor**. Small whole games do solve (8 energy and
4 rounds: 3,187 matrix games, 3 seconds), and their start is worth exactly 0, which checks the rules.

**What this doesn't show:** that strong play is out of reach. Games like this are approximated well by methods this
prototype doesn't have (double oracle, regret minimisation), and their equilibria tend to use few of the possible
moves. "No exact table from a laptop" is the claim, and no more.

### 2.3 How it plays

There's no Even or Reader to measure against, only scout, written in an afternoon. Everyone against everyone, the
row's score:

| | scout | random | steady2 | two | outbid | rounder | storyteller | chaser |
|---|---|---|---|---|---|---|---|---|
| **scout** | 0.01 | 0.66 | 1.00 | 0.58 | 0.32 | 0.75 | -0.19 | 0.03 |
| **steady2** | -1.00 | -0.09 | 0.00 | -1.00 | -1.00 | 0.87 | 1.00 | -1.00 |
| **two** | -0.58 | 0.69 | 1.00 | 0.00 | -1.00 | 0.63 | -0.58 | -1.00 |
| **rounder** | -0.76 | 0.51 | -0.86 | -0.60 | -0.01 | 0.00 | -0.37 | -0.99 |
| **storyteller** | 0.24 | 0.67 | -1.00 | 0.58 | 0.79 | 0.38 | -0.01 | 0.27 |
| **chaser** | -0.01 | 0.58 | 1.00 | 1.00 | 0.73 | 0.98 | -0.26 | 0.01 |

| Pairing | Draws | Rounds | Two wires taken | Round-1 winner wins |
|---|---|---|---|---|
| scout v scout | 13% | 6.6 | 73% | 56% |
| rounder v storyteller | 63% | 10.0 | 0% | 36% |
| rounder v rounder, chaser v chaser | 52%, 59% | | | |
| chaser v rounder | 1% | 3.3 | 95% | 99% |

- **No habit is safe.** Storyteller tops the table and loses every match to `steady2`; `steady2` loses every match to
  four others. That's a healthy sign in a game, and it means a fixed style has a counter that wins always.
- **Naive play is punished faster than on the wire.** *Rounder* (an even third of its energy, the first thing a model
  tries) loses 99% to *chaser* in 3.3 rounds: one more than its average on two wires, nothing on the third.
- **Scout isn't a Reader.** It loses to storyteller and only ties chaser, so this table can't say how LLM-like play
  fares against a strong player. That needs a real one built.
- **Two problems to fix before it's a game:**
  - *Draws.* Cautious players draw each other 52% to 63% of the time. In a staked series a draw is fees for nothing.
    Wires of ±3 make it worse (20% for scout against itself, from 13%).
  - *The endgame.* Matches that go long are fought with the 3 energy a round both sides regain.
- **Between like players the first round matters about as much as on the wire** (its winner wins 56% for scout against
  itself; the wire's 59%). Against naive play it decides the match.

### 2.4 What it would need on-chain

- **No randomness**, so nothing new to trust: the wire's commit and reveal, with three numbers in the hash.
- **State:** three nodes for one.
- **Fallbacks** need a menu of their own (a fixed split, or the opponent's last split).
- **The rules in Rust** are the wire's, three times, plus taken wires: a small port, and parity fixtures as today.

## 3. What to do with this

1. **Don't add either to the program before the audit.** Neither is finished, and The Lot brings a draw (1.5) the
   audit would have to cover.
2. **Before the audit, make room.** A game id beside the rules version in each series, a move of up to four bytes in
   the commitment, and spare bytes in the series state, so a second game is a new rules module and not a new account
   layout. (Not checked against `programs/line-wager`; that's the next thing to read.)
3. **If one goes further, The Lot first**, in free play, with real agents. The simulator's LLM-like players are
   guesses; The Line's own numbers moved once models played it.
4. **Three wires needs a design pass**: a tie-break or an odd rule for level wires, a look at regain, and then a real
   opponent (an approximate solver) before any claim about skill.

## Running it

- `npm run games:sim`: both drafts and their variants (11 seconds). `-- --game lot` or `-- --game wires` for one.
- `npm run games:sim -- --exact --prizes 9 --energy 30`: The Lot's Even and Reader at the draft's size (5 minutes).
  Without the sizes, 7 prizes and 20 energy (about 15 seconds).
- `npm run games:sim -- --cost`: the solving-cost tables above (80 seconds).
- `npm run games:sim -- --game wires --watch scout,storyteller --seed 2`: one match, round by round.
- `packages/core/test/games.test.ts`: every rule edge, 500 random matches a game that end and replay identically, and
  on a small size, that no bid beats The Lot's equilibrium mix.
- `packages/core/test/lot-attacks.test.ts`: The Lot's draw, attacked (1.5), with a test for each review finding (1.6).
