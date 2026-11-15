# PRD: Practice stakes on link battles

Status: **a draft, revised 2026-11-15 after the owner's steer: devnet only, with devnet SOL, which is worth nothing.
Nothing is built.** Part 1 is the plan. Part 2 is what would have to change before real money, kept so that day
doesn't start from nothing; none of it is needed for Part 1. Not legal advice.

Two agents stake devnet SOL on a link battle (docs/link-battles.md) and the winner takes the pot. It follows The
Line's practice wagers (docs/wager-mode.md 13, W1; docs/wager-devnet.md), which run on devnet today.

**The short version.**

- **The game decides who won.** The agents play the real game through the referee, exactly as in a free battle. The
  battle ends when one side has no Pokémon left, and both Game Boys must agree on it. That ending is the result.
- **The referee carries the result to the chain.** A Solana program holds both stakes. It can't see a Game Boy, so
  when the battle ends the referee signs "this battle, this winner", and the program checks that signature and pays.
  The site only signs: the winner's own agent sends the transaction, as it already does for The Line's tickets.
- **Devnet SOL is worthless, and stays that way.** No prize means this isn't gambling (docs/wager-mode.md 5.6, model 1),
  provided nothing of value is ever attached: never bought, sold, rewarded or converted, and practice results never
  touch the free ladder.
- **It's a small build.** The Line's program carries its whole game in Rust. This one carries no rules at all: it
  holds stakes, checks two signatures (the pairing, the result) and pays or refunds.
- **How it differs from The Line, and why that's fine here.** The Line's program plays the match itself, so nobody
  trusts the referee. Here the referee reports the result, so the program trusts the referee's key. With nothing of
  value at stake that is the right trade: it keeps the battle exactly as it is today. It would not be good enough for
  real money (Part 2).

---

# Part 1. The plan: devnet

## 1. What a staked battle is

- **Stake:** both sides stake the same amount of devnet SOL, from fixed tiers. Symmetric: no odds.
- **Format:** the fixed mirror format (`colosseum-1`), one battle. (A series is an open question, section 7.)
- **Play:** unchanged. `link_join`, `link_state` and `link_move` through the referee, the same clocks and fallbacks
  (docs/link-battles.md 4.2), the screens and sound public as each turn plays. Nothing about a turn goes on-chain.
- **The result:** the game's. A knockout: the side with a Pokémon left wins. A forfeit (leaving, or two minutes silent
  while asked) loses. The turn cap is a draw.
- **Settlement:** the winner takes both stakes. A draw and every void refund both in full.
- **Never against the house.** Highwire is never a party to a stake.
- **Rated apart.** A staked battle moves a separate practice rating, never the free ladder, as The Line's wager
  rating does (docs/wager-mode.md 4.2).
- **Table talk stays on.** With nothing of value on a turn, an opponent's line is still conversation. (It goes off
  with real money: Part 2.)

## 2. When a battle doesn't finish

Free play voids a battle that goes wrong. Each case needs a rule here too, and the rule shouldn't reward causing it,
even with play money: the habits carry over.

| What happens | Free play today | Staked |
|---|---|---|
| The two games disagree after a turn (a desync) | void | refund both |
| The rig gets stuck, or a turn fails four times | void | refund both |
| The rig's version changes mid-battle (a deploy) | void | refund both |
| A decision the game refuses | void | **the side's fallback plays instead.** A void here would let a losing side trade an illegal move for a refund |
| A side is silent for two minutes while asked | forfeit | forfeit: it loses the stake |
| Both sides silent | void | refund both |
| The turn cap | a draw | refund both |
| **The referee never signs a result** (the site is down, or a battle is lost) | n/a | **after a deadline, either player refunds both.** No one's stake is ever stuck on Highwire |

## 3. How it works

1. **Pairing.** Both agents ask to stake at a tier (`link_stake`). The desk pairs them and signs a **ticket**: the
   battle's id, both wallets, the tier, an expiry. This is The Line's desk (`packages/relay/src/arena/wager.ts`) and
   its ticket key, which signs pairings and never moves money.
2. **Staking.** Player A sends `open` with the ticket and its stake; player B sends `accept` with the same ticket and
   its stake. The program checks the ticket's signature (an Ed25519 instruction just before it, as `line-wager` does).
   If B never accepts, A cancels and gets its stake back.
3. **The battle.** Once both stakes are in, the referee starts the battle. It plays as a rated battle does. The
   referee watches the program for the two deposits; it never holds or moves the stakes.
4. **The result.** When the battle ends, the referee signs a **result**: the battle's id, the outcome (side 0 won,
   side 1 won, a draw, a void) and the two wallets. It hands the signed result to both agents in their next answer.
5. **Settling.** Either agent sends `settle` with the signed result. The program checks the signature against the
   result key in its config, pays the winner (or refunds both), and closes the battle's account. The reveal daemon
   The Line's agents already run (`highwire-wager run`) does this for an agent that has stopped.
6. **If no result ever comes,** `refund` after the deadline returns both stakes.

**The result key** is new: a key that signs results and nothing else, held where the ticket key is. On devnet a wrong
result moves nothing of value. It is the one thing in this design that could not go to real money as it is (Part 2).

## 4. What gets built

- **A new program, `programs/link-wager`** (Rust), not a change to `line-wager`: that program is audited and frozen
  (`.github/scripts/freeze.mjs`), and this one is far smaller. `Config` (the authority, tiers, a cap on the open
  stake, the ticket key, the result key, `paused`) and a `Battle` account per staked battle (both wallets, the tier,
  its state, when it opened). Instructions: `open`, `accept`, `cancel`, `settle`, `refund`, and the authority's
  `pause`, `config` and `freeze_and_refund`. **No rules in Rust.**
- **In `highwire-wager`** (docs/boundaries.md: everything that stakes lives there, and nothing else imports it): the
  program's codec and address, its guard for `assertSafe` and `describeTransaction`, the signer's action extension,
  the tools (`link_stake`, and a `link_wagers` list), and settling in the daemon.
- **In the relay:** the desk pairs link battles at a tier; `LinkArena` starts a staked battle once both deposits are
  seen and signs the result at the end.
- **The local signer only,** inside the policy's `wagers` section, on a devnet policy and a devnet home, as The Line's
  practice wagers are (docs/wager-devnet.md). The hosted endpoint never stakes.
- **Pages:** staked practice battles on their own page, marked as practice with no amounts shown, never indexed, as
  `/line/practice` is. The battle itself plays on the stage as any other.
- **`npm run rehearse-wagers`** grows a link battle: the whole stack on a local validator with the compiled program
  and a fake engine, touching no public cluster.

**Done when** the program's tests cover every state and deadline (both stake, one never accepts, settle with each
outcome, settle twice, a result for another battle, a result signed by the wrong key, refund before and after the
deadline, a stake above the cap, a paused config, the open-stake counter on every close path); `attacks.test.ts` has
the links that must fail; and two agents stake, play a whole link battle and settle on devnet through the local
signer, including one whose agent is killed mid-battle and one battle voided on purpose and refunded.

## 5. The wall around practice

As The Line's (docs/wager-mode.md 5.6): devnet SOL is never bought, sold, rewarded or converted; practice results
never touch the free ladder, records, eligibility or anything else of value; nothing promotes practice winnings; the
pages say practice.

## 6. Decisions needed from you

1. **Go ahead with Part 1?** It's engineering only.
2. **One battle, or a series** (section 7).
3. **The tiers** in devnet SOL (The Line's design names 0.1 and 0.25 a side).

## 7. Open questions

- One battle swings on a single critical hit. A best-of-3 halves that and triples the time (a battle between model
  agents runs 5 to 15 minutes). Measure first: a strong scripted player against a weaker one over a few hundred
  battles says how much a better player actually wins.
- Does the referee start the battle only after seeing both deposits on-chain (slower to start, nothing to unwind), or
  pair first and void if a deposit never lands?
- How long before `refund` opens: long enough for the longest battle (the turn cap) plus a margin.

---

# Part 2. If it ever leaves devnet

None of this is needed for Part 1. It's here because each point would have to be answered before real SOL, and some
answers change the design.

## 8. The result would need more than the referee's word

In Part 1 the referee could see each move before the other side decides (it holds them), draws the dice itself
(`randomBytes`, `packages/link/src/rated.ts`), and names the winner. With play money that's fine. With real money, an
insider could read a move, pick the dice or name the wrong winner, and nobody outside could tell. The options:

| | A. The referee attests (Part 1) | B. Inputs on-chain, the referee attests | C. Several attestors | D. Proven on-chain |
|---|---|---|---|---|
| Decisions | sent to the referee | committed and revealed on-chain, every turn | as B | as B |
| The dice | drawn by the referee | from both players' reveals; nobody chooses them | as B | as B |
| Can Highwire see a move early | yes | no | no | no |
| Can Highwire choose the dice | yes | no | no | no |
| Can Highwire misreport the result | yes, undetectably | yes, but anyone with the game can prove it | only with the others | no |
| Work | small | medium | medium, plus finding attestors | a research project |

**B is the least that real money would need.** Every turn, each side commits a hash of its decision and then reveals
it, as a round of The Line does (docs/wager-mode.md 7.2); the dice come from both reveals (the construction is already
in the repository, attacked: `packages/core/scripts/games/lot-series.ts`, `test/lot-attacks.test.ts`); an unrevealed
commit forfeits. The battle then becomes a pure function of public inputs, and the rig is deterministic (it's how each
turn's film is made and checked, `packages/link/src/record.ts`), so anyone with the game can replay a battle and check
the result. The engine barely changes: a turn already plays from whatever decisions and dice it's handed
(`LinkMatch.play`). It costs two transactions a side a turn, about 55 a side for a 25-turn battle. The result is
still attested, not trustless, and the copy would have to say so. **C** (independent parties running the same battle
and co-signing) removes "trust Highwire alone". **D** (a dispute over the emulator's execution, settled on-chain one
instruction at a time) is months of specialised work.

## 9. The law

Everything in docs/wager-mode.md 5 applies: a prize, chance and consideration make gambling; no US or UK launch; the
only real-money route is a licensed operator elsewhere, with identity, age, sanctions and geography checks. Three
things are harder here than for The Line:

1. **Chance is larger and more visible:** critical hits, misses, how long sleep lasts. No "skill" reading is likely to
   help.
2. **Highwire would decide the outcome.** The Line's program settles by its own rules; counsel's view of that doesn't
   cover an operator attesting who won.
3. **The game belongs to someone else.** Showing it is one exposure. Taking real stakes on it, on a commercial
   service, is a larger and different one, and may be a blocker whatever gambling law says. *A question for counsel,
   not a finding.* The alternative would be staking on a game of Highwire's own whose rules run in the program, as
   The Line's do: a different product.

## 10. What else changes with real money

- Table talk off in staked battles; the pages' "Call it" pick off on them; eligibility, limits and terms as The Line's
  sections 8 to 12; the fee question; an external audit of the program; a void rate low enough to live with (the
  1,000-battle run and real rated battles give the baseline); a second void by one fighter closing the staked queue to
  it until someone has looked.
- Deploys that change the rig would wait for staked battles to finish.
- The gate is The Line's (docs/wager-mode.md 13): an audience in free play first, then counsel in writing.
