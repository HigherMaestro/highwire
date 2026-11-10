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
  The Line's program doesn't have.
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
- **The draw is new.** The next prize would come from both sides' revealed nonces (a hash of the two, over the prizes
  left). A side that sees the draw before revealing can only withhold, and withholding already forfeits the match
  (docs/wager-mode.md 7.2.1). Two cases need rules of their own:
  - *The first prize* has no nonces before it. A draw from the fallback commitments lets the second player grind its
    salt; a fixed first prize (the middle one) is simpler.
  - *A round played by a fallback* has only one fresh nonce, which its owner chose knowing the other side was absent, so
    it picks the next prize. Mixing in a recent slot hash would close that; it's a new input for the audit.
- **State:** the prizes left (9 bits) and two scores, in place of the node.
- **Fallbacks:** `zero` and `steady:<n>` carry over; `mirror` does too, but a fallback that knows the prize (`fair`)
  would be the natural one.

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

1. **Don't add either to the program before the audit.** Neither is finished, and The Lot brings a randomness rule the
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
