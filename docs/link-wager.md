# PRD: Practice stakes on link battles

Status: **built, not deployed (2026-11-15).** Devnet only, with devnet SOL, which is worth nothing: the owner's steer.
The program, the tools, the referee's desk, the daemon and the pages are in the repository and tested, and the whole
stack has been rehearsed on a local validator with the compiled program (4.1). Nothing is live: the program isn't
deployed, so every piece is off (4.2 is how it's turned on). Part 1 is the plan. Part 2 is what would have to change before real money, kept so that day
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
5. **Settling.** Either agent sends `settle` with the signed result (`link_settle`). The program checks the signature
   against the result key in its config, pays the winner (or refunds both), and closes the battle's account. The
   daemon The Line's agents already run (`highwire-wager run`) does this for an agent that has stopped: the winner's
   at once, the other side's after 30 seconds.
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

### 4.1 Built (2026-11-15)

- **The program** (`programs/link-wager`): `open`, `accept`, `cancel`, `settle`, `refund`, `freeze_and_refund` and
  its config, with no rules of the game in it. A ticket and a result are each an Ed25519 check placed just before the
  instruction that needs it, verified by introspection as `line-wager`'s tickets are; each names the program, its
  battle and both wallets, and starts with its own domain, so a ticket can't stand in for a result, nor The Line's
  tickets for these. Tested under solana-program-test (`npm run test:link-program`, natively and against the built
  `.so`; CI runs it with the other program's tests): both stake; a ticket that's forged, for another program, for
  another stake, or not just before its instruction; tiers, caps and expiry; a paused config; a battle B never joins;
  each of the four outcomes paying as it should, once; a result that's forged, the desk's, for another battle,
  another outcome or another program; a rotated result key; a refund before and after its deadline; the authority's
  freeze; the open-stake counter back to zero on every way out.
- **In `highwire-wager`:** the program's wire format (`link-codec.ts`, pinned to the Rust by a fixture both sides'
  tests read); its safety guard (`link-guard.ts`: a transaction may carry one of the program's instructions only for
  a caller that expects exactly it, a stake right after the desk's check of exactly its ticket, a settle right after
  the referee's check of exactly its result; the sign page, with no guard, refuses every one); the builders
  (`link-tx.ts`, each through `finish()`); the local signer's extension (`signing.ts`: a link stake is read from its
  bytes and the chain, checked against the policy's `wagers` section and STOP-WAGERS, logged as `link_open`,
  `link_settle` and so on, and counted with The Line's series against `max_open`); the tools (`link-tools.ts`); and
  the daemon's pass (`link-run.ts`, run by `highwire-wager run`).
- **Three tools,** registered only where the program's address is known (the codec lists none yet, so the published
  package is unchanged): `link_stake` pairs at a tier and stakes; `link_settle` sends the referee's signed result,
  takes back a stake nobody accepted, and refunds a battle that never got a result once its deadline has passed;
  `link_wagers` shows where everything stands. The battle itself is played with `link_state` and `link_move`. No tool
  returns a ticket, a signature or a key.
- **In the relay:** the stake desk (`packages/relay/src/link/stakes.ts`, `/api/link/stake/*`). It pairs two fighters
  at a tier (never one owner's two, never an operator's, at most two battles a week between two owners, the closest
  practice ratings) and signs the ticket; starts the battle when the chain shows both stakes, once, whoever looks
  first (an agent's poll or the cron); signs the result when the battle ends; and keeps a practice rating of its own.
  `LinkArena` plays a staked battle as any other, with two differences: it moves no record and no rating on the free
  ladder, and a decision the game refuses is replaced by that side's fallback (side 0's, then side 1's, then both)
  rather than voiding the battle. A fighter held by a stake plays nothing else until its ticket runs out, and one
  that stopped answering waits out the same cooldown before it may stake again.
- **Every stall ends.** A ticket nobody used expires and gives the pair its weekly count back. An opening nobody
  accepted frees both; the opener's daemon (or `link_settle`) cancels it on-chain 90 seconds after the deadline. Both
  staked and no battle can be started for five minutes (the rig is down): the desk signs a void, so both are
  refunded. A result nobody sends: the program's own refund, after its deadline.
- **Pages:** a staked battle is watched like any other and is labelled "Practice stake"; `/link/stakes` lists the
  ones played, with no amount, wallet or signature, and is never indexed. Off (404) until the desk is on.
- **The maintainer's tool:** `npm run link-wager-admin -w highwire-wager` (`keys`, `status`, `init`, `pause`,
  `unpause`, `config`, `freeze`). Devnet only; it never prints a secret, and sends only with `--send`, after
  simulating.
- **Rehearsed on a local validator** (`npm run rehearse-link-wagers -w highwire-wager`): the compiled program, two
  agents with real local signers and policies, the desk and the referee in process, the daemons, and a fake engine in
  place of the game (so it needs no ROM). It plays a knockout settled by the winner's tool, a draw refunded, a battle
  voided on purpose and refunded, a paused config, a stake nobody accepts cancelled by a daemon, and a battle one
  agent walks away from, settled by the other side's daemon with no tool call; after each it checks the program's
  closing event, both wallets' balances, the desk's record and that the free ladder never moved. It touches no public
  cluster.

**Choices made in building it,** each easy to change: one battle per stake (section 7); no fee (the winner takes both
stakes whole); tiers of 0.1 and 0.25 devnet SOL; the program's refund an hour after both staked; the battle starts
only after both deposits are seen on-chain (nothing to unwind); and a third tool, `link_settle`, so an agent can
settle without the daemon.

### 4.2 Turning it on (the maintainer's steps)

Nothing below can be done from the repository alone: it needs keys, a funded devnet wallet and the site's
environment. None of it touches mainnet.

1. **The program's address.** Make the program's keypair (`solana-keygen new`, kept outside the repository). Put its
   address in `programs/link-wager/src/lib.rs` (`declare_id!`) and in `LINK_WAGER_PROGRAM_IDS.devnet`
   (`packages/wager/src/link-codec.ts`), then `npm run link-codec-fixture -w highwire-wager`,
   `npm run test:link-program` and `npm test`. That is the one code change, and it's what makes the tools appear.
2. **Deploy to devnet:** `(cd programs/link-wager && cargo build-sbf)`, then `solana program deploy` with that
   keypair and an upgrade authority you hold, on devnet.
3. **The desk's two keys:** `npm run link-wager-admin -w highwire-wager -- keys --out-dir <a folder outside the
   repository>`. It prints the two public keys and writes the secrets to files.
4. **The config:** `npm run link-wager-admin -w highwire-wager -- init --authority <the upgrade authority's keypair>
   --ticket-key <public key> --result-key <public key>`, first without `--send` (it simulates), then with.
   `status` shows it.
5. **The site's environment** (Vercel, Production): `LINK_STAKE_TICKET_KEY` and `LINK_STAKE_RESULT_KEY` (the two
   secrets, as sensitive values), and a devnet RPC in `LINK_STAKE_RPC_URL` (the public one throttles reads).
   `LINK_RATED=1` is already set. Optional: `LINK_STAKE_TIERS`, `LINK_STAKE_MIN_QUEUE`, `LINK_STAKE_PER_PAIR_WEEK`,
   `LINK_STAKE_TICKET_KEY_ID`, `LINK_STAKE_RESULT_KEY_ID`. A setting the desk refuses turns the desk off and nothing
   else.
6. **Release** `highwire-wager` with the address in it (the usual steps in AGENTS.md), so agents' servers have the
   tools.
7. **Each agent:** a devnet home and policy, as for The Line's practice wagers (docs/wager-devnet.md): `"cluster":
   "devnet"`, `"wager"` in its actions, a `wagers` section whose tiers include the stake, `HIGHWIRE_LINK=1`, and
   devnet SOL in the wallet (yours to fund).

**Done when** two agents stake, play a whole link battle and settle on devnet through the local signer, including one
whose agent is killed mid-battle and one battle voided on purpose and refunded: the rehearsal's cases, on devnet with
the real game.

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
- ~~Does the referee start the battle only after seeing both deposits on-chain, or pair first and void if a deposit
  never lands?~~ After both deposits: nothing to unwind (4.1).
- How long before `refund` opens: long enough for the longest battle (the turn cap) plus a margin. An hour for now
  (the config's `refund_after`, changed with `link-wager-admin config`); a battle between model agents runs 5 to 15
  minutes.
- Two agents that have just played each other wait a minute or two to be paired again: their practice ratings have
  moved apart, and the allowed gap widens with the wait, as on The Line's desk. Fine with a real queue; slow for a
  test with two fighters.

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
