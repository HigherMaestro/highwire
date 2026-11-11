# The Line's wager program: the auditors' pack

What an external audit of `programs/line-wager` needs: what it is, what's in scope, what must always hold, what was
already found, and how to build and test it. The design is docs/wager-mode.md (sections 6, 7.2, 7.7 and 10); the
operations are docs/wager-mainnet.md.

## What it is

A native Solana program (`solana-program` 1.18.26, Borsh 1.5.1, no Anchor) that holds two agents' stakes and plays a
best-of-five series of The Line on-chain: every round both players commit to a hidden pull (a SHA-256 commitment),
then reveal it; the program applies the rules, the clock and fallbacks, and pays the winner the pot less a fee, or
refunds both. A matchmaker (the site's wager desk) signs a ticket that `open` and `accept` must carry, checked through
Solana's Ed25519 instruction and instruction introspection.

Deployed on devnet at `RRMA7jERXRceX7i5QBK2fw8qbACkAo5zs949onndezC` (binary SHA-256 `013472db00c49d74ae006d30391e93712befc7257b5972821e62a72fc6f74067`),
where five full series have been played and settled (docs/wager-devnet.md 8). That binary is from before a commit named
its match (below, "Already found"): devnet runs this source once it's redeployed (docs/wager-devnet.md 9).

## Scope

| File | Lines | What |
|---|---|---|
| `src/processor.rs` | 602 | every instruction: accounts, checks, lamport movements, the closing event |
| `src/series.rs` | 393 | the series state machine: commit and reveal phases, the clock and banks, fallbacks, timeouts, match and series ends |
| `src/rules.rs` | 152 | the game's rules (the wire, energy, rounds), ported from the TypeScript twin |
| `src/ticket.rs` | 100 | the matchmaker's ticket: its message, and the Ed25519 instruction check by introspection |
| `src/state.rs` | 93 | the config and series accounts, the hard caps |
| `src/instruction.rs` | 66 | the instructions and their accounts |
| `src/error.rs` | 64 | the errors |
| `src/lib.rs` | 26 | the entrypoint |

About 1,500 lines. Out of scope, but useful context: the TypeScript twin of the rules (`packages/core/src/arena/`), the
client's codec, builders and safety checks (`packages/wager/src/codec.ts`, `tx.ts`, and `guard.ts`, the wager guard for highwire-core's `assertSafe`), the signer's wager extension (`packages/wager/src/signing.ts`), the reveal daemon
(`packages/wager/src/runner.ts`) and the desk (`packages/relay/src/arena/wager.ts`).

## The instructions

| Instruction | Who | What |
|---|---|---|
| `InitConfig` | the upgrade authority, once | the config: authority, ticket key and id, fee and fee account, tiers, caps, reveal window |
| `UpdateConfig` | the config authority | pause, the ticket key, the fee and fee account (new series only), tiers, caps, the authority |
| `Open` | player A, with a ticket | stakes A, creates the series account |
| `Accept` | player B, with the same ticket | stakes B, starts match 1 |
| `Cancel` | A any time, anyone after the accept deadline | refunds A, closes the series |
| `Commit` | a player | a hidden pull for the open round, naming its match and round: refused unless both are the ones in play |
| `Reveal` / `RevealFallback` | a player | the pull and nonce, or the committed fallback and salt |
| `Timeout` | anyone | applies a passed deadline: fallbacks owed, a missed reveal forfeits the match, both missing voids it |
| `Settle` | anyone, once the series is decided | pays the winner (less the fee) or refunds a draw, closes the series |
| `Retire` | a player | concedes the series |
| `EmergencyRefund` | anyone, after 24 idle hours | refunds both, unless the due timeouts decide the series |
| `FreezeAndRefund` | the config authority | refunds both in full, whatever the state |

## What must always hold

1. **No one but the players and the fee account recorded at `open` ever receives a stake.** No instruction pays anyone
   else; a payee the runtime won't credit (a program, or an account a loader owns) has its share burned in the
   incinerator rather than blocking the other's payout.
2. **The authority can't take a stake.** Its only power over an open series is `FreezeAndRefund`, which refunds both in
   full. It can't change a series' fee (snapshotted at `open`) or its rules.
3. **A series is paid out exactly once**, and closing it returns the rent to A and decrements the open-stake counter by
   exactly what `open` and `accept` added; the counter never exceeds the cap.
4. **Only a ticket the matchmaker signed, for this program, these two wallets, this stake and these deadlines, opens a
   series**, and the opener can't choose its deadlines. The Ed25519 check reads the instruction it verifies by index and
   checks every offset (the Wormhole class of bug).
5. **Neither player can see the other's pull before committing**, and a reveal must match its commitment; a missed
   reveal forfeits the match, so withholding never pays. **A move counts only where it was made for:** a commit in the
   match and round it names, a reveal against the hash of the match, round and side in play. A second copy of any move
   changes nothing.
6. **Every series ends**: by settlement, a cancel, a timeout path, a retirement, the 24-hour refund, or the freeze. No
   state can hold stakes forever.
7. **The on-chain rules equal the TypeScript twin's** for every event: checked on 2,000 random series (300,000 moves,
   faults included) by `tests/parity.rs`.
8. **Hard caps the config can't exceed:** a 5% fee, 10 SOL a side, a reveal window of 60 seconds to an hour, tiers of at
   least 0.01 SOL.

## Trust and threats

The threat table is docs/wager-mode.md 10. In short: the matchmaker's ticket key can pair players (steer matchmaking)
but never move money; the config authority (a hardware wallet on mainnet) can pause, freeze-and-refund, change future
series' terms within the hard caps, and upgrade the program. There's no timelock on upgrades: operationally, the program
is paused and every series settled before any upgrade (docs/wager-mainnet.md 8).

## Already found

Four adversarial reviews, each fixed and covered by tests (docs/wager-mode.md 17.1 to 17.4). The program's own:
- a payee that turned its wallet into a program blocked every payout (high): its share now burns;
- a small fee into an empty fee account blocked `settle`: that fee now goes to the winner, and tiers are at least 0.01 SOL;
- a day-long reveal window could be waited out by the emergency refund: the window is capped at an hour;
- the emergency refund could skip a timeout already due: it now applies due timeouts first and refuses if they decide.

Found since, by an adversarial review of a prototype of the same game, and fixed here before this audit
(docs/wager-mode.md 7.2.6, 17.6):
- a commit named its round but not its match, and round numbers repeat from match to match. A commit transaction that
  landed twice (a retry signed with a new blockhash) could have its second copy accepted as the next match's move for the
  same round number, when the earlier match had ended by then (in round 1, on a withheld reveal). It couldn't be opened
  there, the player's own commit was refused as already made, and the match was forfeited by a missed reveal: a match
  lost with no attacker. `Commit` now carries the match too, and the program refuses any other with its own error
  (`WrongMatch`, 116). The instruction grew from 34 bytes to 35, so the earlier shape is refused outright
  (`BadInstruction`). Tests: `a_commit_names_its_match` in `tests/parity.rs`,
  `a_second_copy_of_a_commit_is_refused_in_the_next_match` in `tests/program.rs`, and the parity fixtures, which send
  both wrong-match commits and second copies of earlier matches' commits.

Known and accepted:
- a settle sent through a program that logs enough to truncate the transaction's log hides the closing event from
  log readers (the referee then leaves the series unrated); funds are unaffected;
- the rules are fixed at `duels-1`; there's no per-series rules version yet.

## Build and test

```bash
npm ci
npm run test:program
```

That writes the fixtures (`npm run wager-fixtures -w highwire-core` and `npm run wager-instructions -w highwire-wager`), runs the Rust unit and parity tests, builds the
program (`cargo build-sbf`, Solana 1.18 toolchain, rustc 1.75) and runs `tests/program.rs` (every instruction against the
compiled program with real lamports) and `tests/ts_built.rs` (transactions built by the TypeScript client, run on the
program).

The whole stack, on a local validator:

```bash
npm run rehearse-wagers -w highwire-wager
```

The reproducible build, whose hash the deployed program must match (docs/wager-mainnet.md 2 and 10):

```bash
(cd programs/line-wager && solana-verify build)
```

## The tag and the freeze

The commit sent to the auditors gets a tag, and from then on a change to what they were sent is flagged
(docs/boundaries.md 5.4). The maintainer does both steps; nothing tags or labels by itself.

1. **Tag the commit sent,** and push the tag:

   ```bash
   git tag -a audit/line-wager-1 <the commit sent> -m "Sent to the auditors"
   ```

   ```bash
   git push origin audit/line-wager-1
   ```

2. **Record its build:** the program's SHA-256 from `solana-verify build` at that commit, here, beside the tag's name.
   *(Not yet tagged: nothing has been sent.)*
3. **From then on,** CI's "the audited program" check fails on any pull request that changes `programs/line-wager/src/`
   or the program's `Cargo.toml` or `Cargo.lock`, until the maintainer adds the label `audited-program-change` to it:
   their say-so, and their cue to tell the auditors. Tests under `programs/line-wager/tests/` and the TypeScript client
   aren't frozen. A second round is `audit/line-wager-2`; the newest tag is the one named in the message.

CI also runs `npm run test:program` on every pull request that touches the program, the rules it mirrors
(`packages/core/src/arena/`), the codec or the fixture writers, so a change that breaks parity can't merge unnoticed.

## What to look at hardest

- `ticket.rs`: the introspection and every offset; replaying a ticket across series, clusters or programs.
- The lamport movements in `processor.rs` (`settle`, `cancel`, the refunds, `pay_player`, the incinerator burn) and the
  open-stake counter on every close path.
- `series.rs`'s clock: banks charged by landing time, deadlines on the boundary, the reveal window, both banks out.
- Replays inside a series: a second copy of any signed move (a commit, a reveal, a fallback's reveal, a retirement, a
  timeout) landing later, in another round or match. The commit was the one that mattered (above).
- Account validation: the series and config PDAs, owners, signers, and the payee accounts passed to payouts.
- Anything that lets a third party (not a player, not the authority) change a series' outcome or its payees.
