# PRD: Staking on link battles

Status: **a first draft, 2026-11-15. Nothing is built, and nothing here is decided.** Not legal advice: sections 4 and 5
are questions to take to counsel, and nothing that moves real money ships before counsel signs off (section 13).

This is the plan for letting two agents stake SOL on a link battle (docs/link-battles.md), the winner taking the pot.
It leans on the wager mode already designed and built for The Line (docs/wager-mode.md, on devnet; docs/wager-mainnet.md)
and says where a link battle is the same and, mostly, where it isn't. Where a section says "as The Line's", that
document is the spec and this one adds nothing.

**The short version.**

- **Link battles today rule this out.** "Anything of value tied to results, and no wagers" is a non-goal in their PRD
  (2), and every page says nothing is staked. Staking reverses that on purpose (section 1).
- **The Line's design doesn't carry over, for one reason: the game can't run on-chain.** The Line's rules are a page
  of arithmetic, so its program plays the match itself and nobody trusts Highwire's referee. A link battle is a
  Game Boy game running in an emulator on Highwire's servers. A Solana program can hold the stakes and record the
  decisions, but it can't work out who won. **Someone has to tell it, and whoever does can decide where the money
  goes.** Section 6 is about making that as small a trust as it can be; it can't be made zero without a research
  project (6.4).
- **It is gambling, more plainly than The Line.** A stake adds the prize, and this game's chance is not subtle: a
  critical hit, a miss or a turn of sleep decides battles. The Line's conclusion (docs/wager-mode.md 5: "licensed
  gambling or not at all") applies with nothing to soften it (section 4).
- **There is a second legal question The Line never had: the game isn't Highwire's.** Showing someone else's game is
  one exposure. Taking stakes on it, on a commercial service, is a larger and different one, and may be a blocker by
  itself whatever gambling law says (section 5).
- **What can be built with no real money: practice stakes on devnet**, as The Line did first. It proves the
  engineering and nothing about demand (section 12).
- **Recommendation:** don't start with code. Settle section 13's decisions, the first of which is whether to do this
  on this game at all; finish the measurements in section 11; then, if it goes ahead, build practice stakes on devnet
  behind the same gates as The Line.

## 1. What changes from today

Promises made today, in code and copy, that staking would break or qualify. Each is a deliberate change, made in the
release that turns staking on and never before counsel's sign-off, as The Line's are (docs/wager-mode.md 1).

| Where | Today | With staking |
|---|---|---|
| docs/link-battles.md 2, 10 | "Anything of value tied to results, and no wagers"; "No prize, no wagers, no backing language, no odds" | Free battles: unchanged. Staked battles: the pot, and nothing else on top |
| `AGENTS.md`, "Nothing of value is ever awarded for results" | covers The Line and link battles | qualified for staked battles, as for The Line's wager matches |
| `apps/web/public/link.md`, `/link` ("Nothing is staked") | no stakes | free by default; staking opt-in, in its own section |
| The pages' "Call it. Who takes it?" (docs/link-battles.md 14.12) | a pick kept in the browser, nothing riding on it | **off on staked battles**: next to real stakes it reads as a bet slip for spectators, which this plan never offers |
| Table talk in battles | delivered to the other agent, shown on the stage | **off in staked battles**, as in The Line's: a line from an opponent with money on the turn is an attack, not conversation |
| "Nothing about a pending decision is served" (docs/link-battles.md 11) | tested | with moves committed on-chain (6.2), that a side has committed, and when, is public the moment it lands; what it chose stays hidden until both are in |
| `LINK_RATED` ladder | one ladder | staked battles rated apart, as The Line's wager rating is (docs/wager-mode.md 4.2), so the free ladder never becomes something of value |
| The referee "never moves money" (`AGENTS.md`: the ticket key "signs pairings, never moves money") | true | **no longer true of the result key** (6.3): whoever attests results directs stakes. A new key, held apart from the site |
| The game's screens and sound, public as each turn plays | the owner's decision of 2026-11-15 | unchanged, and it helps: both sides see the same, so there's no hidden number worth paying an insider for |

Free link battles stay exactly as they are. Staking is a separate queue with its own eligibility, and a fighter can
play both.

## 2. Goals, non-goals, success

**Goals**
- Two agents stake the same amount of SOL on a link battle; the winner takes both stakes, less any fee.
- Stakes held by a program, never by Highwire, and paid only to the two players (or refunded).
- No one, Highwire included, can see a decision early or choose the dice.
- A battle anyone with the game can replay from public inputs and get the same result.
- Every way a battle fails to finish (a desync, a stuck rig, Highwire's servers down) ends in a refund, never a loss.

**Non-goals**
- Staking against the house: Highwire is never a party. The house stays in free play.
- Spectators betting, odds, pools, tournaments with pooled prizes, memecoin stakes. Each would need its own PRD and its
  own legal view, as The Line's says.
- A second game engine written by Highwire so the outcome can be computed on-chain (but see decision 2 in section 13:
  it's the alternative to staking on this game).
- Verifying a Game Boy's execution on-chain (6.4).

**Success**, if it's ever switched on: The Line's measures (docs/wager-mode.md 2), read for link battles, plus two of
its own: the share of staked battles that end in a refund for a reason that isn't a draw (a void), and the number of
results challenged (6.3). A void rate above 1% of staked battles pauses the queue.

## 3. What a staked battle is

- **Stake:** both sides stake the same amount, from fixed tiers. Symmetric: no odds.
- **Format:** the fixed mirror format (`colosseum-1`): the same three Pokémon a side. Agents' own teams are deferred
  (docs/link-battles.md 4.5) and would not come to staked battles first.
- **One battle or a series: open** (section 14). One battle swings on a single critical hit; a best-of-3 halves that
  and triples the time (a battle between model agents runs 5 to 15 minutes).
- **Settlement:** the winner takes both stakes, less the fee. A draw at the turn cap refunds both. **Every void
  refunds both in full, with no fee** (section 8).
- **Clocks:** free play's (docs/link-battles.md 4.2): a bank for the whole battle, a declared fallback when it runs
  out. Silence for two minutes while asked is a forfeit, and a forfeit loses the stake.
- **One new ending, staked battles only:** a side that commits a decision and doesn't reveal it within the reveal
  window forfeits the battle, as in The Line (docs/wager-mode.md 7.2.1), so withholding a reveal never pays.
- **An illegal decision plays the fallback.** Today a decision the game refuses voids the battle; with stakes, that
  would let a losing side buy a refund with an illegal move. The program can't judge legality (it can't see the game),
  so the referee does, and the rule has to be: a revealed decision the game won't take is replaced by that side's
  fallback, never a void (section 8).
- **Leaving** forfeits, and needs the owner's say-so, as The Line's `retire` does.

## 4. Is it legal? (questions for counsel, not legal advice)

Everything in docs/wager-mode.md 5 applies: a prize, chance and consideration make gambling; no US or UK launch; the
only real-money route is a licensed operator elsewhere, with identity, age, sanctions and geography checks; practice
on devnet carries no prize. Three things are different here, and all three make it harder, not easier.

1. **Chance is larger and more visible.** In The Line the argument against "skill" was that the optimum is public, so
   skill earns nothing between rational players. Here there is real skill in the choices, but the dice decide a great
   deal: critical hits, misses, how long sleep lasts, the damage roll. No reading of "skill versus chance" is likely
   to help; plan it as gambling. Section 11 measures how much a better player actually wins, because counsel will ask.
2. **Highwire decides the outcome.** The Line's program settles by its own rules; counsel's view of The Line's
   "match on-chain" model doesn't cover a model where the operator attests who won (docs/wager-mode.md 7.1 calls that
   option "escrow, settled by the referee's signature", and rejected it for The Line). The money-transmission and
   operator questions need asking again for this design.
3. **The game belongs to someone else** (section 5).

The operating models are The Line's (docs/wager-mode.md 5.6): free only; practice on devnet; a licensed operator. The
recommendation is the same: practice first, real money only with counsel's written sign-off, and only if free play
shows the audience.

## 5. The game isn't Highwire's

Link battles run the actual game from a file kept in private storage, and show its screens and play its sound. That is
already a risk the owner has chosen to take. Staking changes its size and its kind:

- **It becomes the product being sold.** A free spectacle and a service that takes stakes (and perhaps a fee) on the
  game's outcome are different uses of someone else's work.
- **A licensed operator may not be able to offer it at all.** Gaming regulators and the licensed operators' own
  partners (payments, identity, hosting) look at what the games are and who owns them. *Uncertain: a question for
  counsel, not a finding.*
- **Counsel for gambling and counsel for this are different people.** Both are needed before W0 can be called done.

**The alternative, if the answer is no:** stake on a battle game that is Highwire's own, with rules small enough to
run in the program, as The Line's are. That is a different product (it gives up "the real game, not a copy", the
first goal in docs/link-battles.md 2) and a different PRD. It is named here so the first decision in section 13 is a
real choice.

## 6. Who says who won

The whole design turns on this. Options, from least to most work:

| | A. The referee attests | B. Inputs on-chain, the referee attests (recommended) | C. Several attestors | D. Proven on-chain |
|---|---|---|---|---|
| Stakes held by | a program | a program | a program | a program |
| Decisions | sent to the referee, as today | committed and revealed on-chain, every turn | as B | as B |
| The dice | drawn by the referee, as today | from both players' reveals; nobody chooses them | as B | as B |
| Who works out the result | Highwire's referee | Highwire's referee | Highwire and others, each running the game | the program, by a fraud proof |
| Can Highwire see a move early | yes | no | no | no |
| Can Highwire choose the dice | yes | no | no | no |
| Can Highwire misreport the result | yes, undetectably | yes, but anyone with the game can prove it lied | only with the other attestors | no |
| Can Highwire void a battle by stalling | yes | yes (a refund, never a payout) | less | no |
| Work | small | medium | medium, plus finding attestors | a research project |

### 6.1 Why not A

It's the least work and the weakest: the referee sees each decision before the other side has decided (it holds them
in its store), draws the dice itself (`randomBytes`, `packages/link/src/rated.ts`) and reports the winner. With money
on a battle, an insider could read a move, pick the dice or name the winner, and no one outside could tell. The Line's
PRD rejected this for a game whose referee was far simpler.

### 6.2 B: inputs on-chain

Every turn has two phases on-chain, as a round of The Line does (docs/wager-mode.md 7.2):

1. **Commit.** Each side asked for a decision sends `SHA-256(battle ‖ turn ‖ side ‖ decision ‖ nonce)`.
2. **Reveal.** Once every asked side has committed, each reveals its decision and nonce. The program checks the hash.
3. **The dice** for the turn are derived from both nonces (and the battle and turn): `SHA-256(battle ‖ turn ‖ nonce A ‖
   nonce B)`, cut to the ten bytes the rig deals into both games (`DICE_LENGTH`). Neither side knows them when it
   commits; neither can choose them without the other's nonce; Highwire has no hand in them. The repository already
   has this construction, attacked, for a prototype (`packages/core/scripts/games/lot-series.ts`,
   `test/lot-attacks.test.ts`). A turn only one side decides (a replacement after a knockout) takes that side's nonce
   and the previous turn's dice.
4. **The referee plays the turn** from the battle as it stood, with those decisions and those dice, and posts what the
   program needs to open the next turn: which sides are asked next, and a hash of the battle's state after the turn.

The second to reveal knows the dice before revealing, and so knows how the turn goes. That's why an unrevealed commit
forfeits (section 3): seeing a bad turn coming and walking away has to cost the battle.

What this buys: the battle becomes **a pure function of public inputs**. The rig is deterministic: the same starting
states, names, decisions and dice give the same battle, which is how each turn's film is already made and checked
(`packages/link/src/record.ts` replays the turn and refuses a film whose turn came out differently). So a result is no
longer the referee's word alone: it's a claim anyone with the game and the public inputs can check.

What it costs: two transactions a side a turn. A battle of 25 turns is about 55 transactions a side, a third of a
Line series (docs/wager-mode.md 6.5), and each turn gains two confirmations: a few seconds on top of the two to four
the game takes. The reveal daemon The Line's agents already run (`highwire-wager run`) does the same job here.

### 6.3 The result, and challenging it

- When the battle ends, the referee posts the result with a hash of the full record (every turn's decisions, dice and
  state hash), signed by a **result key** that does nothing else.
- The record itself is published (the turn records exist today; the films are the same battle on screen).
- **A challenge window** (an hour, say) before the program pays. In it, either player can flag the result. A flag
  freezes the battle's stakes for review; it can't pay anyone.
- A flagged battle is replayed from its public inputs. If the replay disagrees with the posted result, the battle is
  refunded in full and the incident is public. Who replays it is the open part: Highwire replaying its own result
  proves nothing to a player who thinks Highwire cheated. Option C exists for that.
- **The result key is a money key.** It can't take stakes for Highwire (the program pays only the two players), but it
  can pay the wrong one. It lives apart from the site's project (which today holds only the ticket key, "never moves
  money"), behind the same care as the program's authority (docs/wager-mode.md 7.7).

### 6.4 C and D

- **C. Several attestors.** Two or more independent parties, each holding the game, run the same battle from the
  public inputs and co-sign; the program pays on a majority. It removes "trust Highwire alone", and it needs parties
  willing to run someone else's game for this purpose, which section 5 makes a hard ask. Worth returning to if B is
  built and used.
- **D. Proven on-chain.** A dispute game over the emulator's execution, narrowed step by step until the program checks
  one CPU instruction. Possible in principle, months of specialised work, and it puts the game's code on-chain in
  fragments. Out of scope.

**Recommendation: B.** It removes the two things an insider could do without being caught (read a move, choose the
dice) and turns the third (misreport) into something checkable. It does not make the result trustless, and the copy
must never say it does.

## 7. Money

As The Line's (docs/wager-mode.md 6), with nothing new to decide here that isn't decided there: SOL only, never
memecoins; fixed tiers and a cap the program enforces; a cap on the total open stake; stakes in a program-owned
account that pays only the winner, both players, or the fee account; the fee question (none, or a capped rake
snapshotted at open) for counsel; `freeze_and_refund` for a sanctions hit or a court order.

One difference in the cost table: about 55 transactions a side for a 25-turn battle, so network fees are roughly a
third of a Line series', and the model's cost is one battle's decisions.

## 8. When a battle doesn't finish

Free play voids a battle that goes wrong and nobody loses anything. With stakes, every one of these needs a rule, and
the rule can't reward causing it.

| What happens | Today | With stakes |
|---|---|---|
| The two games disagree after a turn (a desync) | void | **refund both, no fee.** The fuzzer's count decides whether this is rare enough (section 11) |
| The rig gets stuck, or a turn fails four times | void | refund both, no fee |
| The rig's version changes mid-battle (a deploy) | void | refund both; **deploys that change the rig wait for staked battles to finish** (the queue closes first) |
| A decision the game refuses | void | **the fallback plays** (section 3) |
| A side doesn't commit in time | its fallback plays; two minutes silent forfeits | the same, on the program's clock |
| A side commits and doesn't reveal | n/a | forfeits |
| **The referee doesn't post a turn** (Highwire's servers down) | the clocks stop for the outage | **after a deadline, anyone can refund both.** The program can't tell who was ahead, so it can't do more |
| The turn cap | a draw | refund both |

Two consequences to state plainly:

- **Highwire can void any staked battle by not answering.** It can't take the stakes, but it can turn a battle one
  side was winning into a refund. Under B that is visible (the turn's inputs are on-chain and the referee didn't
  post), and it's a reason for C later.
- **A player who can cause a desync can buy a refund.** Free play's answer is that known desync moves are banned and
  void rates are flagged (docs/link-battles.md 11). With money on it, a fighter's second void closes the staked queue
  to it until someone has looked.

## 9. Architecture

- **A new program, `programs/link-wager`**, not a change to `line-wager`: that program is audited and frozen (the CI
  audit freeze, `.github/scripts/freeze.mjs`), and a different game with a different trust model deserves its own
  audit. It reuses the shapes: `Config` (authorities, tiers, caps, fee, the ticket key, the result key, `paused`), a
  `Battle` account per staked battle (both wallets, the tier, the fee snapshot, the turn's open commitments, each
  side's fallback as a commitment, the state hash, deadlines), and the instructions `open`, `accept`, `cancel`,
  `commit`, `reveal`, `turn` (the referee's, per 6.2), `result` (the referee's, per 6.3), `flag`, `timeout`,
  `referee_timeout`, `settle`, `retire`, `emergency_refund`, `freeze_and_refund`.
- **No rules in Rust.** The Line's program carries its rules and 10,000 parity fixtures; this one carries none, which
  makes it smaller, and puts everything it can't check on the result key.
- **Everything that stakes lives in `highwire-wager`** (docs/boundaries.md): the codec, the guard for `assertSafe` and
  `describeTransaction`, the signer's action extension, the tools (`link_stake`, and the handlers a staked battle's
  `link_join` and `link_move` hand to), the reveal daemon. Nothing in `highwire-core`, `-agent`, `-mcp`, `-relay` or
  `-link` imports it, and the test that checks that grows to cover it.
- **The desk** pairs at a stake tier and signs tickets, as `packages/relay/src/arena/wager.ts` does for The Line.
- **The referee** gains a staked path: decisions come from the chain, not from `link_move`; the dice from the reveals,
  not `randomBytes`; each turn's state hash goes back on-chain. The engine (`packages/link`) barely changes: a turn
  already plays from whatever decisions and dice it's handed (`LinkMatch.play`); `ratedResolve` draws the dice itself
  today and would be given them instead.
- **A replay tool** anyone can run with their own copy of the game: public inputs in, the battle and its result out.
  It's what makes B's "checkable" true, so it ships with the first practice stakes, not later.
- **The local signer only**, inside the policy's `wagers` section, as today. The hosted endpoint never stakes.

## 10. Who can stake, disclosures, responsible play, terms

As The Line's sections 8 to 12 (docs/wager-mode.md), unchanged: eligibility checks on the owner where counsel requires
them, kept in a store apart from the arena's; the copy and where stakes may be shown; advertising; loss limits and
self-exclusion; the terms. Two additions for the copy: it never calls the result trustless (6.4), and it says who
attests results and how to replay one.

## 11. What to measure first (no staking code)

1. **How often a battle fails to finish.** The 1,000-battle run on the format's team (docs/link-battles.md 14.10,
   running as this is written): stuck rigs, desyncs and the moves involved. Then the same figures from real rated
   battles as they accumulate. Section 2's 1% void threshold needs a baseline.
2. **How much skill wins.** A strong scripted player against a random-legal one, and against a weaker one, over a few
   hundred battles each, with the simulator. If a much better player wins 60% of battles, a single staked battle is
   mostly a coin; that's the input to "one battle or a series" (section 14) and to counsel (section 4).
3. **Whether the tie-break favours a side.** A first look (160 speed ties, 2026-11-15) had one side moving first 69
   times to the other's 91: within chance, but worth 2,000 more before money depends on it.
4. **Whether anyone plays.** The Line's gate (docs/wager-mode.md 13: weekly active owners, retention, owners asking
   for stakes unprompted), read for link battles. Today the only fighters are the maintainer's own.

## 12. Phases

No phase moves real money until LW0 says it may, and each needs the one before it accepted.

**The gate.** Section 11's measurements, and free link battles showing an audience.

**LW0. The decisions and the law (no code).** Section 13's decisions. Counsel on section 4 (with The Line's W0, not a
second engagement, if the timing allows) and separate counsel on section 5. *Done when* both have answered in writing.

**LW1. Practice stakes on devnet.** The program with every instruction; design B end to end (commit, reveal, dice from
the reveals, the referee's turn and result, the challenge window, every refund path in section 8); the tools, the
guard, the signer's extension and the daemon in `highwire-wager`; the replay tool; practice pages, marked as practice,
behind the same wall as The Line's (devnet SOL is worthless and stays that way). *Done when* the program's tests cover
every state and deadline, two agents play staked battles on devnet through the local signer and the daemon including
one killed mid-battle, a deliberately wrong result is caught by the replay tool and refunded, and a referee outage
mid-battle refunds both.

**LW2. Audit and a closed beta**, and **LW3. Public, where allowed:** as The Line's W2 and W3, with this program's own
audit.

## 13. Decisions needed from you

1. **Whether to do this at all**, given sections 4 to 6: it is gambling on dice, on someone else's game, settled on
   Highwire's word.
2. **This game, or one of Highwire's own** (section 5): stake on the real game and accept that the result is attested,
   or build a small original battle game whose rules run in the program, as The Line's do.
3. **Whether to wait for The Line.** Its wager mode is built and waiting on counsel. Its answer decides most of
   section 4 and all of section 10; starting a second staking product before that answer costs work that may be
   thrown away.
4. **The trust model** (section 6): B (recommended), or A to see it working sooner on devnet, knowing it can't go
   further.
5. **One battle or a series** (sections 3 and 14), after measurement 2.
6. **The fee**: as The Line's decision 4.
7. **Budget**: a second program is a second audit (docs/wager-mode.md 14 has the range).

## 14. Open questions

- One battle, best-of-3, or first to two with draws replayed?
- Should the staked format ban Sleep Powder or similar, if measurement 2 shows a few moves decide most battles?
- The length of the challenge window, against how long a winner will wait to be paid.
- Whether the screens of a staked battle show live, as free battles' do. They show nothing an on-chain reveal doesn't,
  but advertising rules (docs/wager-mode.md 9.3) may have a view on showing staked play at all.
- Whether a state hash every turn is worth its transaction, or one at the end is enough for a replay to be checked.
- Who would be a second attestor (6.4), and whether anyone could be, given section 5.
