# PRD: Practice stakes on link battles

Status: **live on devnet, and accepted (2026-11-16).** The program is at
`J6GQfe7VYa6tpDxZg7j2xEobF4Jj3ciq2AzUcC2UBUQe`, the referee's desk is on at highwire.fun, and the acceptance run
passed: three staked battles with the real game, through the tools, the local signer and the daemon, each paid or
refunded as it should be (4.2 step 8). Devnet only, with devnet SOL, which is worth nothing: the owner's steer. An
adversarial review before the deploy changed the program and much around it (4.3). What's left is the release, so
other people's agents have the tools (4.2 step 9). Part 1 is the plan. Part 2 is what would have to change before real money, kept so that day
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
- **Settlement:** the winner takes both stakes. A draw and every void refund both in full. Nothing leaves a battle
  before its ticket has run out (a few minutes after pairing): the program's rule that a ticket opens one battle.
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
| **The referee never signs a result** (the site is down, or a battle is lost) | n/a | **after a deadline, anyone refunds both.** The time is fixed in the battle when the second stake lands (an hour at the least). No one's stake is ever stuck on Highwire |
| Both stakes are in and no battle can be started (the rig is down, a fighter is gone) | n/a | after five minutes the referee signs a void: refund both |

## 3. How it works

1. **Pairing.** Both agents ask to stake at a tier (`link_stake`). The desk pairs them and signs a **ticket**: the
   battle's id, both wallets, the tier, an expiry five minutes off. It's a desk of its own
   (`packages/relay/src/link/stakes.ts`), modelled on The Line's, with a ticket key of its own, which signs pairings
   and never moves money. It pairs only while it can read the program's config and the config is the one it was set
   up for.
2. **Staking.** Player A sends `open` with the ticket and its stake; player B sends `accept` with the same ticket and
   its stake. The program checks the ticket's signature (an Ed25519 instruction just before it, as `line-wager` does)
   and refuses a ticket with more than fifteen minutes to run. If B never accepts, anyone cancels once the ticket has
   run out, and A gets its stake back. Not before, even by A: a battle closed while its ticket still ran could be
   opened again with the same ticket.
3. **The battle.** Once both stakes are in, the referee starts the battle: one battle for a stake, under an id chosen
   before it's made, so a start that died or was tried twice finds the same battle. It plays as a rated battle does.
   The referee watches the program for the two deposits; it never holds or moves the stakes.
4. **The result.** When the battle ends, the referee signs a **result**: the battle's id, the outcome (side 0 won,
   side 1 won, a draw, a void) and the two wallets. It hands the signed result to both agents in their next answer.
5. **Settling.** Either agent sends `settle` with the signed result (`link_settle`), once the ticket has run out. The
   program checks the signature against the result key in its config, pays the winner (or refunds both), and closes
   the battle's account. The daemon The Line's agents already run (`highwire-wager run`) does this for an agent that
   has stopped: the winner's at once, the other side's after 30 seconds. A result is no secret, and anyone may send
   it: `GET /api/link/stake/result/<battle id>` serves it to anybody, so a winner whose agent and daemon are both
   down can still be paid by someone else.
6. **If no result ever comes,** `refund` returns both stakes from the time fixed in the battle when B staked. An agent
   and its daemon take a result only if the program's own key signed it, so nothing a referee serves can stand in the
   way of that refund.

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
  tickets for these. Its rules:
  - **A ticket opens one battle, ever.** A battle's account closes (by a settle, a cancel, a refund or the authority's
    freeze) only after its ticket has expired, and an expired ticket opens nothing. So a result, which names a battle
    and not a moment, can only ever settle the battle it was signed for.
  - **A ticket runs fifteen minutes at most,** which is therefore the longest a stake nobody matched can be held.
  - **The refund's time is fixed in the battle** when B stakes (`refund_at`), an hour later at the least; a later
    change to the config never moves it.
  - **The config holds three real keys,** the two signing keys different, and changes hands only to a key that signs
    for it.
  - Stakes leave a battle's account only to its two players. A payee the runtime won't credit can't block the other's
    payout: that share burns.

  Tested under solana-program-test (`npm run test:link-program`: 25 tests natively and against the built `.so`, and
  the wire format against the TypeScript's; CI runs it with the other program's tests).
- **In `highwire-wager`:** the program's wire format (`link-codec.ts`, pinned to the Rust by a fixture both sides'
  tests read, and its address pinned to the Rust's `declare_id!` by a test); its safety guard (`link-guard.ts`: a
  transaction may carry one of the program's instructions only for a caller that expects exactly it, a stake right
  after the desk's check of exactly its ticket, a settle right after the referee's check of exactly its result, every
  payee pinned to the battle's own two wallets; the sign page, with no guard, refuses every one); the builders
  (`link-tx.ts`, each through `finish()`); the local signer's extension (`signing.ts`: a link stake's kind and amount
  are read from its own bytes, an accept's from the ticket in the check just before it, never from an RPC; it's
  checked against the policy's `wagers` section and STOP-WAGERS, logged as `link_open`, `link_settle` and so on, and
  counted with The Line's series against `max_open`); the tools (`link-tools.ts`); and the daemon's pass
  (`link-run.ts`, run by `highwire-wager run`).
- **Three tools,** registered only where the program's address is known (devnet; they reach agents with the next
  release of `highwire-wager`, 4.2 step 9) and only on a server that can play the battle (`HIGHWIRE_LINK=1`): `link_stake` pairs at a
  tier and stakes; `link_settle` sends the referee's signed result, takes back a stake nobody accepted, and refunds a
  battle that never got a result once its time has come; `link_wagers` shows where everything stands. The battle
  itself is played with `link_state` and `link_move`. The referee isn't trusted by them: what it sends is checked for
  shape, never repeated as text, and never believed where the chain can say (that both have staked; that a result is
  the program's key's). No tool returns a ticket, the desk's or the referee's signature, or a key.
- **In the relay:** the stake desk (`packages/relay/src/link/stakes.ts`, `/api/link/stake/*`). It pairs two fighters
  at a tier (never one owner's two, at most two battles a week between two owners, the closest
  practice ratings) and signs the ticket; starts the battle when the chain shows both stakes; signs the result when
  the battle ends; and keeps a practice rating of its own. It pairs only while it can read the program's config and
  that config holds its own two keys and the tier asked for. A stake gets one battle, under an id chosen before the
  battle is made. `LinkArena` plays a staked battle as any other, with two differences: it moves no record and no
  rating on the free ladder, and a decision the game refuses is replaced by that side's fallback (side 0's, then side
  1's, then both) rather than voiding the battle. A fighter held by a stake plays nothing else, and is never held
  more than ten minutes past its ticket whatever the chain's RPC does; one that stopped answering waits out the same
  cooldown before it may stake again.
- **Every stall ends.** A ticket nobody used expires and gives the pair its weekly count back. An opening nobody
  accepted frees both; a daemon (or `link_settle`) cancels it on-chain once the ticket has run out. Both staked and no
  battle can be started for five minutes (the rig is down): the desk signs a void, so both are refunded. A result
  nobody sends: the program's own refund, from the battle's `refund_at`.
- **Pages:** a staked battle is watched like any other and is labelled "Practice stake"; `/link/stakes` lists the
  ones played, with no amount, wallet or signature, and is never indexed. Off (404) until the desk is on.
- **The site's switch** (`apps/web/lib/line/stake-config.ts`): the desk is on only with rated link battles, a program
  listed for devnet and both keys set. A setting that's missing, malformed or unreadable turns the desk off and
  nothing else, and no log line carries a setting's value.
- **The maintainer's tool:** `npm run link-wager-admin -w highwire-wager` (`keys`, `status`, `init`, `pause`,
  `unpause`, `config`, `freeze`). Devnet only (every sending path checks the RPC's genesis hash); it never prints a
  secret, writes keys only outside the repository, and sends only with `--send`, after simulating.
- **Rehearsed on a local validator** (`npm run rehearse-link-wagers -w highwire-wager`): the compiled program, two
  agents with real local signers and policies, the desk and the referee in process, the daemons, and a fake engine in
  place of the game (so it needs no ROM). It plays a knockout settled by the winner's tool (and refused while the
  ticket still runs), a draw refunded, a battle voided on purpose and refunded, a paused config, a stake nobody
  accepts cancelled by a daemon, and a battle one agent walks away from, settled by the other side's daemon with no
  tool call; after each it checks the program's closing event, both wallets' balances, the desk's record and that the
  free ladder never moved. It touches no public cluster.

**The maintainer's own fighters stake like any other** (the owner's decision, 2026-11-16). The desk first refused
them, as The Line's wager desk does; with devnet SOL that rule only kept the maintainer's two fighters out of the
acceptance run and out of play. On the free ladder they're ranked like any other too, since the same day
(docs/link-battles.md 5); one coin and one wallet a fighter, and never two of one owner paired, still hold.

**Choices made in building it,** each easy to change: one battle per stake (section 7); no fee (the winner takes both
stakes whole); tiers of 0.1 and 0.25 devnet SOL; the program's refund two hours after both staked; the battle starts
only after both deposits are seen on-chain (nothing to unwind); and a third tool, `link_settle`, so an agent can
settle without the daemon.

### 4.2 Turning it on (the maintainer's steps)

Each step says who does it. Keys, funding and anything that sends a transaction are the maintainer's: the assistant
never creates, funds or reads a key, and never sends. Devnet SOL is worth nothing.

**Every Solana CLI command below names `--url https://api.devnet.solana.com`.** This machine's CLI default points at
mainnet; a command without the flag would act there, with real SOL. Key files live in `~/.highwire-devnet/`, as The
Line's do (docs/wager-devnet.md); its wallet (`devnet-keypair.json`, `7bK1LThaA8xMKpmJt3wosCRcYvVA2R8V2PzoiAdqfu4B`)
deploys the program and is its upgrade authority and the config's authority.

**0. Before anything (maintainer).** The cluster, and the wallet's balance: the deploy locks about 1.2 SOL in rent.

```bash
solana genesis-hash --url https://api.devnet.solana.com
```

It must print `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.

```bash
solana balance 7bK1LThaA8xMKpmJt3wosCRcYvVA2R8V2PzoiAdqfu4B --url https://api.devnet.solana.com
```

**1. The program's address (maintainer, then assistant; nothing is pushed yet).** `cargo build-sbf` made a program
keypair in `programs/link-wager/target/deploy/`, which `cargo clean` would delete. Move it, and read its address:

```bash
mv programs/link-wager/target/deploy/link_wager-keypair.json ~/.highwire-devnet/link-wager-program.json
```

```bash
chmod 600 ~/.highwire-devnet/link-wager-program.json
```

```bash
solana-keygen pubkey ~/.highwire-devnet/link-wager-program.json
```

Give the address to the assistant. On a branch it sets `declare_id!` in `programs/link-wager/src/lib.rs` and
`LINK_WAGER_PROGRAM_IDS.devnet` in `packages/wager/src/link-codec.ts` to it (a test fails unless the two agree),
updates the comments, AGENTS.md's rows and the lobby's line that said nothing is staked, runs
`npm run test:link-program`, the full checks and the local rehearsal, and commits. (**Done 2026-11-15:** the address
is `J6GQfe7VYa6tpDxZg7j2xEobF4Jj3ciq2AzUcC2UBUQe`.) `apps/web/public/link.md` gets its section on practice stakes with the
release (step 9), when agents can have the tools. **It isn't pushed or merged until the program is deployed** (step 2): an address
published before its program exists can be squatted with a few lamports, and the deploy would then need a new one.
(Never make this keypair with a bare `solana-keygen new`: with no `--outfile` it writes the CLI's default wallet
file.)

**2. Deploy (maintainer).** From the repository, on step 1's commit:

```bash
(cd programs/link-wager && cargo build-sbf)
```

```bash
solana program deploy programs/link-wager/target/deploy/link_wager.so --program-id ~/.highwire-devnet/link-wager-program.json --keypair ~/.highwire-devnet/devnet-keypair.json --upgrade-authority ~/.highwire-devnet/devnet-keypair.json --url https://api.devnet.solana.com
```

All four flags matter: without `--url` it deploys to mainnet, and without `--program-id` it deploys at whatever
keypair sits beside the `.so` (a fresh one `cargo build-sbf` makes), not the address in the code. Check:

```bash
npm run link-wager-admin -w highwire-wager -- status
```

It says "deployed; upgrade authority 7bK1LThaA8xMKpmJt3wosCRcYvVA2R8V2PzoiAdqfu4B" and "no config yet". (**Done
2026-11-15:** the build is 165,376 bytes, sha256 `b999a0764e4dda1063a7e6c4ced11f68dd0d70431589c5837f2bd529bda6c446`,
and `solana program dump` returns exactly those bytes.) A deploy
that fails leaves a buffer holding the build's rent (and prints the seed phrase of that buffer's throwaway key,
nothing else); once a deploy has succeeded, take it back:

```bash
solana program close --buffers --keypair ~/.highwire-devnet/devnet-keypair.json --url https://api.devnet.solana.com
```

**3. The desk's two keys (maintainer; done 2026-11-15).** An absolute path, outside the repository (the tool refuses any other):

```bash
npm run link-wager-admin -w highwire-wager -- keys --out-dir ~/.highwire-devnet
```

It prints the two public keys (step 4 takes them; `keys --out-dir ~/.highwire-devnet --show` prints them again) and
writes the secrets to `link-stake-ticket.key` and `link-stake-result.key` there. Never print those files.

**4. The config (maintainer; done 2026-11-15).** A dry run first (it builds and simulates, and sends nothing), then the same with
`--send`:

```bash
npm run link-wager-admin -w highwire-wager -- init --authority ~/.highwire-devnet/devnet-keypair.json --ticket-key <ticket public key> --result-key <result public key>
```

Defaults: both key ids 1, tiers 0.1 and 0.25 SOL, at most 0.25 SOL a side, 20 SOL open in all, a refund two hours
after both stake. `status` then shows the config with both keys.

**5. The site's settings (maintainer; Production only; before the push; done 2026-11-16).** Three values, as sensitive ones:
`LINK_STAKE_TICKET_KEY` and `LINK_STAKE_RESULT_KEY` (the contents of the two key files), and `LINK_STAKE_RPC_URL`, a
devnet RPC of the site's own (the public one throttles the reads). Paste from the clipboard rather than type or echo
a secret on a command line (`pbcopy < ~/.highwire-devnet/link-stake-ticket.key`); a trailing newline is fine. For the
acceptance run also set `LINK_STAKE_PER_PAIR_WEEK` to `50`: the default lets two owners play twice a week, and the
run needs more. Leave the tiers and key ids unset: their defaults are step 4's. `LINK_RATED=1` is already set.

Getting one wrong takes nothing else down: a missing or malformed setting leaves the desk off, a devnet URL that is
really mainnet's (they can differ by one word) means the desk can't read the program's config and pairs nobody, and
keys or tiers that aren't the program's make it refuse to pair and say so in the logs.

**6. Push, and check (assistant, on the maintainer's go; done 2026-11-16).** Step 1's commit goes to `main` (it deploys highwire.fun,
and the site only learns the program's address from a build). Then:

- `https://highwire.fun/api/arena/leaderboard` still answers 200 (nothing else went down).
- `https://highwire.fun/api/link/stake` shows the program's address, `devnet`, the tiers (`100000000`, `250000000`),
  and `ticketKey`, `resultKey` and both key ids equal to `status`'s.
- `https://highwire.fun/link/stakes` answers 200 with no battles.
- Vercel's logs show no "stakes are off", no "isn't on devnet" and no "disagree".

To turn it off again: `link-wager-admin pause --authority … --send` (no new stakes; what's staked plays out), or
remove `LINK_STAKE_TICKET_KEY` and redeploy.

**7. Two fighters, from the repository (maintainer, with the assistant's help).** Not yet from npm: the address
isn't released until the acceptance run has passed (step 9), since a publish can't be taken back. LGTM and Merge
Conflict, each from the devnet home it plays The Line's practice wagers from (docs/wager-devnet.md 6: its
`agent.json`, a devnet policy, its own wallet). Three things differ:

- **The policy allows the tier.** In each devnet home's `policy.json`, the `wagers` section gets the stake:
  `"wagers": {"max_stake_sol": 0.1, "max_open": 1, "tiers": [0.01, 0.1], "allow_retire": false}`. `max_sol_per_tx`
  stays at 0.2 or more, and `max_sol_per_day` leaves room for three stakes (0.5 does). The policy is the owner's to
  edit: no tool writes it.
- **Devnet SOL,** about 0.5 each (a stake is 0.1, and the opener also pays the battle account's rent until it closes):

  ```bash
  solana transfer <the fighter's wallet> 0.5 --keypair ~/.highwire-devnet/devnet-keypair.json --allow-unfunded-recipient --url https://api.devnet.solana.com
  ```

- **A daemon for each,** in its own terminal, with `HIGHWIRE_CLUSTER=devnet`, the fighter's devnet `HIGHWIRE_HOME`
  and its `HIGHWIRE_KEYPAIR_PATH`: `npm run dev -w highwire-wager -- run`. It's what settles for a fighter whose
  agent has stopped (the walkaway case needs side a's, at least). An agent's own server, for a battle between agents
  rather than the script, is the same as The Line's with `HIGHWIRE_LINK=1` added.

**8. The acceptance run (maintainer).** `npm run link-stake-pair -w highwire-wager` plays one staked battle between
the two fighters through the tools an agent uses, and checks the result against the program's closing event, the
referee's practice record, the public list and both wallets' balances. It checks each policy and balance before
anyone is paired. One run per case, a few minutes apart (a side that went silent can't stake again for five):

```bash
npm run link-stake-pair -w highwire-wager -- --a ~/.highwire-lgtm-devnet:~/.highwire/buyback-coin/wallet.json --b ~/.highwire-mc-devnet:~/.highwire/second-fighter/wallet.json --case knockout
```

- `--case knockout`: both play until the game ends it; the winner settles with `link_settle` once the ticket has run
  out. About ten minutes with the real game.
- `--case walkaway`: side b stops answering after two turns, as an agent that was killed would. It forfeits after two
  silent minutes, and nothing in the script settles: a daemon does.
- `--case void`: neither side answers; the referee voids the battle after two silent minutes, and side a's
  `link_settle` refunds both.

`SOLANA_RPC_URL` names a devnet RPC (the public one works, slowly). The same driver runs against the local stack
with `npm run rehearse-link-wagers -w highwire-wager -- --pair <case>`, which is how it was tried before devnet (nine
of nine checks in each case).

**Done when** all three cases pass on devnet, each battle is on `/link/stakes`, and `status` shows open stakes at 0.

**Done 2026-11-16,** between LGTM and Merge Conflict at 0.1 SOL a side, eight of eight checks in each case:

| Case | Battle | What happened | Paid |
|---|---|---|---|
| knockout | `s3vxqfxeec` | LGTM won in 15 turns; its `link_settle` sent the result once the ticket had run out | LGTM +0.099974, Merge Conflict −0.100013 |
| walkaway | `fss99arqne` | Merge Conflict stopped answering after two turns and forfeited; LGTM's daemon settled, with no tool call | the same |
| void | `vvbpy3prsm` | neither side answered; voided after two silent minutes; LGTM's `link_settle` refunded both | each back, less fees |

After each, the program's closing event said settled, its open stakes were back to 0, the referee's practice record
matched (two wins and two losses counted, nothing for the void), the battle was on `/link/stakes`, and the free
ladder hadn't moved. Each run took six to seven minutes; five of them are the ticket, before which nothing closes.

The run found two things the tests hadn't, both fixed before it passed: the desk refused the maintainer's own
fighters, which are the two it was run with (4.1), and a fighter that has just lost a stake needs devnet SOL again
before the next (the script now says so before anyone is paired).

**9. Release, last.** The usual steps in AGENTS.md, so agents' servers have the tools, with a section in
`apps/web/public/link.md` on staking (the three tools, the devnet policy, that it's practice). Then set
`LINK_STAKE_PER_PAIR_WEEK` back and redeploy.

**10. Redeploying after the program changes.** As docs/wager-devnet.md 9: `pause --send`; wait for `status` to show
open stakes at 0 (`freeze --battle <id> --send` for one that's stuck); `npm run test:link-program`; step 2's deploy
command (if it says the account is too small, `solana program extend <address> <bytes> --keypair
~/.highwire-devnet/devnet-keypair.json --url https://api.devnet.solana.com`, then deploy again); close buffers;
`status`; `unpause --send`. An account layout that changed (as the battle's did in 4.3) needs every battle closed
first, which the pause and the wait see to.

### 4.3 The adversarial review before the deploy, and its fixes (2026-11-15)

Four reviewers, each working from the code and told to break it: the program; the signer, the guard and the tools;
the referee's desk; and the deploy plan with the seams between the parts. None found a way to take a stake that
wasn't the taker's, to get a wrong winner signed, or to make the signer spend past the policy's SOL limits. They found
the following, each confirmed against the code (most by a failing test, now in the suites) and fixed:

- **A ticket and a result stayed usable after a battle closed.** Closing a battle erased it, so the same ticket could
  open it again, and the first settle's signed result (public by then) could settle the second. Fixed in the
  program: nothing closes a battle while its ticket runs, and tickets run fifteen minutes at most (4.1).
- **A refund could beat a signed result,** and the window could be shortened under a battle being played. The refund's
  time is now fixed in the battle when B stakes, its floor is an hour, and a result is served to anyone
  (`/api/link/stake/result/<id>`), so a winner doesn't depend on its own agent being up.
- **A "result" the program wouldn't take blocked the refund.** The daemon and `link_settle` kept trying to settle
  with whatever the referee served and never reached the refund. A result is now one only if the config's key
  signed it for this battle.
- **A ticket with far-off deadlines locked the opener's stake,** and after thirty days the wallet forgot it. Refused
  by the builder and by the program.
- **An accept's stake was read from the RPC,** so a lying RPC could get a stake past the policy's tiers (still inside
  the per-transaction and daily limits). It's now read from the ticket in the transaction's own bytes.
- **The deploy steps as first written would have deployed to mainnet,** at an address that wasn't the one in the code,
  and made the program's keypair where the CLI keeps its default wallet. 4.2 is rewritten from the runbook The
  Line's deploy followed.
- **A mistyped stake setting took the whole referee down** (The Line, link battles and registration), since the
  setting was read before anything could catch it. It now turns the desk off and nothing else, with tests.
- **The desk kept pairing when it couldn't read the chain,** signing tickets it could never follow, and never checked
  that its keys and tiers were the program's. It now pairs only when it can read the config and they match.
- **A stake could hold a fighter for good** if the desk's RPC died, and a fighter could be held by a stake and in a
  free battle at once. Holds now end with the ticket, and both sides look for the other after writing.
- **One stake could get a second battle** if a start died at the wrong moment and the first battle ended before the
  desk looked again; a void could be signed while a battle existed. The battle's id is now chosen and saved first.
- **Polls of a stake read the chain for free,** and nothing bounded how often. They're paid for first, and a
  battle's chain state is asked for at most every few seconds.
- **An expired ticket seen by several callers at once gave the pair's weekly count back more than once,** which
  made the weekly cap unlimited.
- **Swaps for a refused decision used up the rig's retries,** so a refused decision and one rig failure still voided.
- Smaller ones: `link_settle` reported nothing when one battle of several failed; a referee's text could be echoed
  into a tool's answer; the stake tools were offered on a server with no way to play; a stake that didn't land
  blocked its own retry; a failed write could leave a result unrated; the admin tool could write its keys inside the
  repository; one failing sweep cost the others their minute.

**Known and left as they are:**

- A battle whose winner's agent and daemon are both down, and that nobody else settles, is refunded once its time
  comes (two hours): the winner loses the win. The result is public for that reason.
- `link_stake` joins the queue before the signer checks the policy's tiers, so an agent whose policy doesn't allow
  the tier can be paired, refuse to stake, and cost its opponent the five minutes of the ticket. The Line's does
  the same.
- A pause or a key change in the program's config takes up to thirty seconds to reach the desk.
- The authority can rotate the result key and so decide results, and the upgrade authority can replace the program.
  With devnet SOL that is accepted (Part 2 is why it wouldn't be with real money).
- A ticket and a result name the program, not the cluster: the same keys must never serve a second deployment at the
  same address.

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
- How long before `refund` opens: long enough for the longest battle (the turn cap) plus a margin. Two hours for now
  (the config's `refund_after`, changed with `link-wager-admin config`; the program's floor is an hour); a battle
  between model agents runs 5 to 15 minutes.
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
