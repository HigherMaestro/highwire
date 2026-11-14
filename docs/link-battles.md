# PRD: Link battles

Status: **proposed, 2026-11-14; revised after an adversarial review the same day (18). Nothing built.** A second game
for Highwire's fighters, beside The Line: two agents fight a real Pokémon Yellow link battle, the game's own code
deciding every turn. It brings JK Clawseum's Competition 002 work (`~/git/jkclawseum`, last touched 2026-03-25) to
Highwire. "Link battles" is a working name (15).

## 1. Summary

Every Highwire fighter (a coin its agent launched with Highwire's tools, registered for The Line) can also fight link
battles. Two agents each command a team in Pokémon Yellow's Colosseum: two emulated Game Boys joined by an emulated
link cable, exactly as two players with a cable would. An agent never presses buttons. Each turn it sees what its own
screen shows and picks a move or a switch; the referee presses the buttons, runs both games to the next decision and
reads the result from memory. People watch the battle turn by turn on highwire.fun.

The game decides everything, its randomness included. This is agent against agent, and the point is the decisions,
so there are no commitments or proofs, unlike The Line. What a match does need is fresh dice (4.1), and that the two
games agree about what happened, which the referee checks every turn.

**Highwire hosts both Game Boys** (8): the referee runs the battle itself on the same Vercel and Upstash setup as The
Line. Agents only send decisions, so they need nothing but the tools.

## 2. Goals, non-goals, success

**Goals**
- A second game for the fighters The Line already has, one people understand on sight.
- The real game, not a copy: battles play out in Pokémon Yellow's own code.
- Decision-level play: an agent picks a move or a switch, never a button, a menu or a timing.
- Headless: the rig runs in Node on Vercel, no Mac, no windows.
- Matches nobody can quietly bend: agents send only decisions, the dice are fresh, and both games must agree every turn
  or the match is void.

**Non-goals**
- **Anything of value tied to results, and no wagers.** Highwire's rule for The Line (docs/arena.md 2, 10) holds here
  too.
- Overworld play, catching, training, trading or items. The battle only.
- A copy of the game's rules or data in Highwire's code. When the rig needs base stats, learnsets, move power or the
  type chart, it reads them from the game at runtime.
- The game file, or save states made from it, in the repository or the npm packages, which are public. The referee
  loads the game from private storage (8.2).

**Success, measured weekly; reviewed after 8 weeks**
- Weekly active fighter owners in link battles; finished-match rate (ended by the game, not voided or forfeited);
  desync rate; median turn time. **Rethink** below 10 weekly active owners or a finished-match rate under 70% after 8
  weeks, and **pause rated play** if desyncs void more than 5% of matches after phase 1's fixes.

## 3. Users and stories

- **An agent owner:** "My fighter already plays The Line. I point it at link.md and it practises against the house,
  then queues for real battles. I watch them on highwire.fun and see its record."
- **An agent:** "I call `link_join`, get paired, read my side of the battle, pick a move or a switch with
  `link_move`, and repeat until it ends. If I'm slow, my declared fallback move goes in."
- **A spectator:** "I follow two agents' teams trading hits turn by turn with their table talk, then watch both
  screens side by side once it's over, and open a fighter's page for its record in both games."

## 4. The game

### 4.1 The format (`colosseum-1`)

- **Pokémon Yellow (English, the one release the rig supports, checked by checksum), link battle in the first
  Colosseum** (not COLOSSEUM2, which applies cup rules).
- **Teams: three each, a fixed mirror.** Both sides get the same three Pokémon at the same level, with the same moves,
  chosen in phase 0 for a fair, readable battle. Three, not six, keeps a match to about 10 to 20 turns. Team building
  comes in phase 5 (4.5).
- **Banned moves:** Psywave, Counter and Bide, which desync link battles (the two games stop rolling the same dice, or
  compute different damage), and Metronome and Mirror Move, which can call them. The fuzzer (phase 1) adds any other
  move it catches desyncing.
- **Fresh dice.** A link battle's dice are a list of 10 random bytes that one game makes and sends over the cable at the
  start; every roll after that comes from the list, which regenerates itself from its own values. A bootstrap freezes
  the list, so every match would roll the same dice, and an agent could learn them. So the referee **re-deals the
  list** with fresh random bytes, the same bytes into both games, at the start of the battle and at every decision
  point. The games stay in step (they read the same list at the same place), and nothing an agent sees predicts the
  next turn's rolls.
- **Actions:** a move (slot 1 to 4) or a switch (to a Pokémon in reserve); after a faint, a forced switch. When nothing
  has PP, the menu still appears and FIGHT means Struggle; switching stays legal. ITEM is offered by the game but
  refused ("Items can't be used here"), so it's never an action. **RUN works in a link battle and ends it** (the other
  game shows its opponent running away), so the rig is built never to land on it (7.3); forfeiting is a referee
  action.
- **Turns the game plays itself** (a recharge after Hyper Beam, Thrash, Rage, a turn trapped by Wrap's user) ask that
  agent nothing, while the other side may still choose (7.2).
- **The end:** the game's own end of battle, which both games must show alike; a draw when both last Pokémon faint
  together; forfeit; void (4.3); or the turn cap (4.2).

### 4.2 The clock, fallbacks, the cap

- **A chess clock,** as on The Line: each side has a bank (8 minutes a match *(to tune)*), charged for the time it takes
  to decide. Time the referee spends resolving a turn is never charged. An empty bank means every decision takes the
  fallback at once.
- **Fallbacks,** declared at `link_join`: `first` (the first legal move), `strongest` (the highest-power legal move,
  power read from the game) or `random` (uniform over legal moves, seeded per match). A forced switch's fallback is the
  first Pokémon still standing.
- **Gone:** a side that makes no call for 2 minutes forfeits. Both gone: void.
- **The cap:** 60 turns *(to tune)*, then a draw. Without it, two empty banks playing fallbacks could run until every
  move's PP is gone.
- **Draws** are rated only when both sides made at least half their decisions themselves, not by fallback (The Line's
  "contested" rule, adapted).

### 4.3 Void, desync, forfeit

- **Desync:** after every turn the referee compares what the two games show (4.4); any disagreement voids the match,
  unrated, and keeps both games' states for study.
- **Stuck:** a decision whose button presses don't land (7.3), or a turn past its frame budget, voids the match,
  unrated, with the states kept.
- **A changed rig:** every saved state is stamped with the rig's version. A state from another version can't be
  resumed, so the match is voided, unrated; deploys that change the rig close the queue until live matches finish
  (8.2).
- **Forfeit:** rated after 3 turns, like The Line's forfeits after 3 rounds; unrated before.

### 4.4 Turn records

After each turn the referee reads both games and writes the turn as each shows it: who moved first, each move used, HP
before and after, faints, switches, status changes, and both lines of table talk. Game A's view of its own side must
match game B's view of its enemy, field by field; when they match, the turn is recorded. That record is the match: the
replay and the result come from it, and the live page from the part of it both sides can see (13).

Critical hits, misses and effectiveness are harder: the second move of a turn overwrites the first one's flags before
the next decision point. Phase 1 reads them as they're set, with SameBoy's execution callback on the few routines that
set them, or by catching the battle text, whichever costs less speed.

### 4.5 Later: teams the agents build

An agent submits three (later six) Pokémon, each a species, four moves and a level within the cap. The referee checks
legality against the learnsets read from the game, computes stats with the published Gen 1 formula (best DVs and stat
experience, fixed by the format) and writes the party into that side's game. That has to happen **before the two games
exchange parties**, so team matches start from a second bootstrap at the Colosseum table, a thousand or more frames
earlier than the mirror format's (7.4). Teams are hidden until each Pokémon comes out, as in the game.

## 5. Who can fight

- **A registered fighter,** the same registration and token as The Line (docs/arena.md 5): a coin its agent launched
  with Highwire, on mainnet. No new registration; `agent.json` already holds the token.
- **Local server only for the tools that use the token,** which here is all of them but `link_rules` and
  `link_leaderboard`. Practice uses the token too (6), since every practice turn costs real compute.
- **Operator coins** may play and are never ranked.

## 6. Playing: tools and flow

| Tool | |
|---|---|
| `link_rules` | the format, the actions, the banned moves, the fallbacks, the clock; hosted endpoint too |
| `link_practice` | a battle against the house, run by the referee: unrated, kept for an hour, one at a time per fighter, and a global cap on practice matches running at once |
| `link_join` | queue with a fallback; long-polls up to 40 seconds, like `line_join`, and returns the match or `waiting` |
| `link_state` | this side's view (6.1); long-polls for the next decision |
| `link_move` | this turn's action and one line of table talk |
| `link_leaderboard` | link battles' ladder; hosted endpoint too |

### 6.1 What an agent sees

Its own screen, never more. The referee can read the whole battle from memory, and each game holds the enemy's whole
party, its exact HP and its PP after the link exchange, so every view is built in one file and tested to contain only
what that side's screen shows, the same rule as The Line's `view.ts`:
- `phase`: `choose`, `replace`, `waiting` (for the other side), `ended`
- `turn`, the clock (each side's bank)
- `you`: your whole team: species, level, HP and max HP, status, the four moves with PP, which one is out
- `them`: the active Pokémon's species, level, HP as the game shows it (a bar, so a percentage), its status, the moves
  it has used, how many of theirs have fainted
- `field`: what's on screen or announced: Reflect, Light Screen, a substitute, confusion, Leech Seed, a toxic count,
  announced stat changes
- `log`: the last turn's record (4.4), filtered to what this side saw
- `legal`: the actions the game will accept now, read from the game, not inferred
- `their_line`: the opponent's table talk, labelled as their words, through `summarizeMessage`

**Nothing about the other side's pending decision is ever served**, not even whether it has arrived, and long-polls wake
only when a turn resolves: The Line's rule about open rounds, unchanged. The same rule covers the public pages: while a
match is live they show only what both sides can see (13).

### 6.2 Table talk, permissions, cost

- **Table talk:** one line a turn, `checkTableTalk`'s rules (no links, addresses or mentions), unmoderated, exactly as
  The Line (docs/arena.md 6, 10).
- **Permissions:** link.md shows how to allow the link tools for unattended play, as line.md does.
- **Cost to an owner:** a turn is one or two model calls with a context that grows; roughly $0.30 to $3 a match with a
  frontier model *(estimate)*. link.md says so and suggests a smaller model.

## 7. The rig

### 7.1 The emulator

SameBoy's core (`Core/` only, Expat licence, version 1.0.3, the version Clawseum used), as a pinned dependency:
- **Built to WebAssembly** with Emscripten and wrapped in a small TypeScript API. The toolchain is pinned (a container
  image by digest) and the built `.wasm` is committed with its checksum and the script that rebuilds it, so CI and
  Vercel need no Emscripten. A native addon for Vercel's Linux is the fallback if WebAssembly is too slow (8.2).
- **Two Game Boys in one process,** each a `GB_gameboy_t`, joined by the core's serial callbacks
  (`GB_set_serial_transfer_bit_start_callback`, `_bit_end_callback`, `GB_serial_set_data_bit`), stepped together with
  `GB_run` in small slices by cycle count, the way SameBoy's own libretro core keeps a linked pair in step (a whole
  `GB_run_frame` per game would let the cable drift).
- **Rendering off** (`GB_set_rendering_disabled`) except when a finished match's screens are rendered (13).
- **Input:** `GB_set_key_state`, held for a set number of frames, then released, each press logged with its frame.
- **Memory:** read and written directly (`GB_get_direct_access`), never by parsing save-state files. The dice are
  re-dealt by writing the list and its index (4.1).
- **State:** `GB_save_state_to_buffer` / `GB_load_state_from_buffer`, about 85 KB a game plus the cartridge's 32 KB of
  RAM, so roughly 170 to 230 KB a pair before compression, stamped with the rig's version.
- **Deterministic:** SameBoy seeds power-on memory from the clock, so the rig seeds it with a constant when making a
  bootstrap. From then on, the same states and inputs on the same frames give the same turn on any instance.
- **Fast:** the save's options set fast text and battle animations off, which shortens every turn.

### 7.2 Decision points

The rig runs both games until **every game is either at a menu or waiting on the cable for the other, and at least one
is at a menu**; or the battle ends; or the frame budget runs out. A game is at a menu when memory shows the battle menu
(FIGHT / PKMN / ITEM / RUN) or, after a faint, the party menu (`replacement_pending` in Clawseum); it's waiting when it
sits in the battle's exchange loop (`LinkBattleExchangeData`). So a turn where one side recharges asks only the other
side, and a forced switch on one side asks only that side. Which actions are legal comes from the game's own state
(4.1), never from a guess. The exact memory signs for each state are phase 1's main work.

### 7.3 From a decision to buttons

- **Move k:** cursor to FIGHT, A, cursor to slot k, A; landed when `wPlayerSelectedMove` holds the move.
- **Switch to n:** cursor to PKMN, A, cursor to n, A, SWITCH, A; landed when the game takes the switch.
- **Forced switch:** cursor to n, A.

Cursors are moved by reading where they are (`wCurrentMenuItem` and the rest), never by counting presses from an
assumed start, and A is pressed on the main menu only after a read confirms the cursor isn't on RUN. A step that
doesn't land is retried once from a fresh read; a second miss voids the match (4.3).

### 7.4 Getting into the Colosseum

Made once per format, in phase 0, and kept in private storage beside the game:
1. **A hand-played save for each side,** made once on the maintainer's machine: a player with the Pokédex (the Cable
   Club's receptionist refuses without it), Pikachu in the state the receptionist accepts, the format's team, standing
   in the Cable Club. Writing a save from scratch isn't worth it: a save also carries the loaded map and its sprites,
   and the bootstrap is private and made once.
2. **The walk in:** the rig boots both games with those saves and presses through talking to the receptionist, saving
   and choosing the first Colosseum, with the link handshake over the emulated cable.
3. **The bootstrap:** both games saved at the battle's first menu, the dice re-dealt at the start of every match (4.1).
   Team matches (4.5) use a bootstrap taken at the Colosseum table instead, before the parties are exchanged.

Clawseum's paired save states, made in SameBoy's app, are a reference for phase 0; if they load in the bare core they
save step 1.

## 8. Where the games run

### 8.1 Hosted (chosen)

The referee runs both Game Boys. Agents send decisions; the referee does the rest. Compared with each owner running
their own Game Boy (8.4), it's weeks less work, owners need nothing but the tools, the house can play online,
spectators can see the real screens, and a modified client has nothing to tamper with.

### 8.2 A turn

1. The second decision of a turn arrives (or the first plus the other side's fallback, when its clock runs out).
2. The referee records both decisions in the small match document (compare-and-set), marks the turn `resolving`, and
   answers at once. The decision is in; the agent's next `link_state` long-poll wakes when the turn resolves.
3. The turn resolves after the response (`waitUntil`), under a **single-flight lock** per match: load the game (once per
   function instance, from private Vercel Blob storage) and the pair's state, re-deal the dice, press both decisions,
   run to the next decision point, read the turn (4.4).
4. **Write the new state first, under its own key** (`state:<match>:<turn>`, never overwritten), then compare-and-set
   the small match document to point at it with the turn's record. A lost race leaves an orphan state, pruned later;
   it never leaves a document pointing at nothing. Long-polls read only the small document.
5. A retry, or a sweep that finds a turn still `resolving` after its lock expired, runs the turn again: it's
   deterministic, so the result is the same.

**The clock sweep only records fallbacks.** It never runs an emulator itself: it marks the turn decided and fires the
same `waitUntil` resolution, so a dozen expired clocks can't overrun the sweep's 60 seconds.

**Speed is phase 0's first question.** SameBoy 1.0.3 runs about 2,300 frames a second for one Game Boy natively, with
rendering off (measured by the review on an M3 Max). A turn is roughly 700 to 1,500 frames a game, so 0.6 to 1.3
seconds natively for a pair, and plausibly 2 to 8 seconds in WebAssembly on a Vercel function. Fast text and no
animations (7.1) cut the frames; resolving after the response (step 3) keeps any of it off the agent's clock. If
WebAssembly is over 10 seconds a turn, the rig moves to a native addon before phase 1.

**Deploys:** pushing to `main` deploys production, and a new rig can't resume an old rig's state (4.3). A change to the
rig ships with the link queue closed until live matches finish.

### 8.3 The referee

- **Where:** the referee in `packages/relay`, with link routes beside The Line's (`/api/link/*`), on the same Upstash
  database (`LINE_*`), matches under their own keys. **The rig is passed into `createRelay` in code**, as the wager tools
  are passed into `createServer`: `highwire-relay` never imports `highwire-link`; the site wires the two together.
- **What it does:** pairs fighters, holds decisions, runs the clocks, resolves turns, compares the two games, records
  the turns, rates the result.
- **Budget:** about 20 turns × (two decisions + long-polls + a resolution writing ~100 KB compressed) ≈ 1,500 to 3,000
  store commands and 2 to 4 MB written a match *(estimate)*, plus a few seconds of function time a turn. States are
  pruned to the last one when a match ends.

### 8.4 The alternative: each owner runs their own Game Boy

Kept for the record. Each owner's machine would run its own Game Boy with its own copy of the game, and the referee
would relay only the link cable's traffic, in whole blocks (the game prepares each exchange in memory first; the
in-battle exchange is one value with no timeout), since byte by byte over HTTPS would take minutes. It costs weeks,
every owner must supply the game, the house can't play online, a modified client can read the opponent's party from
its own game's memory, and the game that drives the cable's clock makes the dice, so the referee would have to supply
them. Not planned.

## 9. Matchmaking, ratings, the house

- **Pairing and ratings:** The Line's queue and Glicko-2, on a separate ladder (`colosseum-1`). Its leaderboard entry
  rules, owner-wallet rule (two fighters from one wallet are never paired), weekly cap on rated matches per pair and
  review flags all carry over; draws as in 4.2.
- **The house:** after 2 minutes unpaired, the house plays, as on The Line, labelled as Highwire's, with a frozen
  rating, never ranked. It picks the legal move with the best expected damage (power, the type chart and same-type
  bonus read from the game, accuracy), and switches when its Pokémon is badly matched and a reserve isn't. A floor, not
  a solution. It decides from its own side's view only (6.1), when the turn opens, and its choice is held like an
  agent's.

## 10. Conduct and conflicts

- **No prize, no wagers,** no backing language, no odds; a rating says nothing about a coin (docs/arena.md 10).
- **Conflicts:** Highwire's trade fee is disclosed on every page; operator coins aren't ranked.
- **Table talk** as The Line: the text rule, no moderation, a takedown route.
- **Terms** gain a link battles paragraph: nothing of value awarded, voids and removal, match records public.

## 11. Abuse and threats

| Threat | Mitigation |
|---|---|
| Learning or predicting the dice | Re-dealt with fresh random bytes at every decision point (4.1) |
| Seeing the opponent's choice early | Nothing about a pending decision is served; waits wake only on resolution (6.1) |
| Reading hidden information through the tools | Views built in one file and tested against both games' full memory (6.1) |
| Reading it from the public pages (exact HP, PP, the screens) | Live pages show only what both sides see; exact numbers and screens only after the match ends (13) |
| Steering into a desync to void a lost match | Known desync moves banned (4.1); the fuzzer finds the rest; each fighter's void rate on its page and flagged |
| Stalling | The chess clock; fallbacks; the turn cap |
| Quitting to deny a rating | Forfeits rated after 3 turns |
| Prompt injection or scams in table talk | The text rule; opponents' words are data |
| Token theft | Tokens never in tool arguments, results or logs; local server only |
| Practice used to burn compute | Practice needs the token; one at a time per fighter; a global cap on practice matches running (6) |
| Store or Blob quota drained | Long-polls read only the small document; per-token rate limits; states pruned when a match ends |

## 12. Packages and boundaries

As with the wager code (docs/boundaries.md):
- **`packages/link/` (`highwire-link`, private, unpublished):** the rig (the committed `.wasm`, its TypeScript API,
  decision points, button sequences, the dice, turn records, views, the house). Only the site imports it, to hand it to
  `createRelay` (8.3); nothing in `highwire-core`, `-agent`, `-mcp` or `-relay` imports it (a test checks). It needs an
  entry in `next.config.ts`'s aliases and `transpilePackages`, and the `.wasm` traced into the route's bundle
  (`outputFileTracingIncludes`), which phase 0 proves on a preview deployment before anything else depends on it.
- **The tools** (`link_*`) live in `highwire-mcp` and only call the referee; no emulator code reaches the MCP package.
  `HIGHWIRE_LINK=0` turns them off, and they're off by default until phase 3.
- **Files:** the game and the bootstraps live in private Blob storage, named by environment variables; a repository
  test fails on any `.gb`, `.gbc`, `.sav` or SameBoy state file. Tests that need the game skip without
  `HIGHWIRE_LINK_ROM`, so CI never has it; views, turn records and the referee are tested on synthetic memory and a
  fake rig.

## 13. The pages

- **/link:** live battles, recent battles in time order, the ladder (with the house section). No top five, nothing
  picked by results.
- **/link/match/<id>, live:** the battle turn by turn, drawn by Highwire from the turn records, showing **only what both
  sides can see**: HP as bars, moves used, faints, switches, table talk. Anything more would hand an agent (or its owner,
  watching) the opponent's exact HP and PP.
- **/link/match/<id>, finished:** the same, opening at turn 1 without the result as The Line's replays do, plus exact
  numbers and **both screens side by side**, rendered once from the saved states and decisions when the match ends,
  after the response, never inside a move, and kept in Blob storage. A match is about 12 to 25 seconds of footage a
  turn per screen; phase 4 picks a format that plays on phones at that length.
- **Fighter pages** show both records, The Line's and link battles', side by side.
- **highwire.fun/link.md:** for agents: the tools, the loop, fallbacks, permissions, costs, banned moves.

## 14. Phases and acceptance

| Phase | Builds | Done when | Rough size |
|---|---|---|---|
| 0. The rig | SameBoy's core in WebAssembly (pinned toolchain, committed `.wasm`), two linked Game Boys stepped by cycles, the API, the saves and the walk into the Colosseum, the format's team, re-dealt dice, version stamps | One full turn resolves headless **in a Vercel function on a preview deployment**, both games agree, and its time is known; two matches with identical decisions roll differently | 1 to 1.5 weeks |
| 1. The whole battle | Decision points (7.2), the button sequences, the end, turn records with the mid-turn flags, desync checks, the banned moves | A fuzzer plays 1,000 random-legal battles: no stuck rig, desyncs counted and their moves known, every end matching the game's | 2 to 3 weeks |
| 2. Practice | `highwire-link`, the referee's resolution path (8.2), practice matches, `link_rules`, `link_practice`, the house, the views and their leak tests | An agent plays the house to the end through the tools, with turns resolving after the response | 1 to 1.5 weeks |
| 3. Rated play | The queue, decisions, clocks, the sweep, ratings, draws, the cap, `link_join` / `state` / `move`, link.md, the live page | Two registered fighters from different owners finish a rated match on highwire.fun | 1 to 2 weeks |
| 4. The screens | Both screens rendered at the match's end, kept in Blob storage, on the finished match's page | A finished match replays both screens turn by turn, and plays on a phone | 1 to 2 weeks |
| 5. Teams | Team building (4.5), the table bootstrap | An agent's submitted team reaches the battle legal and intact, and an illegal one is refused | 2 weeks |

About 6 to 10 weeks to rated play with screens, most of it in phase 1.

## 15. Decisions needed from you

1. **The format:** three-a-side fixed mirror teams first (recommended), or six, or team building from the start.
2. **The go-ahead for phase 0.**
3. **A name.**
4. **Private storage for the game:** a Vercel Blob store in the site's project (Production and Preview), holding the
   game and the bootstraps, with its token as an environment variable.
5. **The two hand-played saves** (7.4): made once, on your machine, or from Clawseum's if they load.

## 16. Open questions

- How fast WebAssembly runs a turn in a Vercel function, cold and warm. (Phase 0, first.)
- How many frames a turn takes with fast text and no animations. (Phase 0.)
- Whether re-dealing the dice at a decision point is ever caught mid-roll; the fuzzer checks both games stay in step.
  (Phase 1.)
- Which other moves desync, beyond the banned five. (Phase 1.)
- The cheapest way to catch critical hits, misses and effectiveness: execution callbacks or the battle text. (Phase 1.)
- The screens' format (animated WebP, a sprite sheet, or video), by size and how it plays on phones. (Phase 4.)

## 17. What carries over from Clawseum

Clawseum got multi-turn battles where both sides use their first move, through to a real end. Its code is the
maintainer's own, so it can be brought over:
- **The memory map:** Yellow's battle addresses (`wIsInBattle` 0xD056, `wBattleMonHP` 0xD014, `wEnemyMonHP` 0xCFE5,
  `wPlayerSelectedMove` 0xCCDC, `wEnemySelectedMove` 0xCCDD, `wBattleResult` 0xCF0B and about twenty more, in
  `tools/competition_002_spike1/sameboy_spike.py`), with the WRAM bank logic.
- **The lifecycle rule (its Phase 1N correction):** HP at zero and a set `wBattleResult` don't end a battle. A faint with
  a Pokémon in reserve is a forced switch, and the battle ends only when the game leaves it. The review checked it
  against the game's code; it comes over with its tests.
- **The shapes:** the normalized state (phase, turn, each side's active Pokémon, legal actions, outcome) and actions
  (`fight_move`, and the `switch_party_slot` it designed but never built), the starting point for 6.1.
- **The architecture's split:** the game behind an adapter, the platform owning turns, deadlines, legality and the
  record. Kept.

Not carried over: AppleScript and Quartz key events, window focus, the 12-second settle waits, the save-state files on
disk and their freshness checks. Each existed only because the game ran in an app the code couldn't step.

## 18. What changed after the adversarial review (2026-11-14)

Checked against the public disassembly of Pokémon Yellow, SameBoy 1.0.3's source and Highwire's referee:
- **Every match would have rolled the same dice** (the list is frozen in the bootstrap): the dice are now re-dealt at
  every decision point (4.1).
- **Decision points were symmetric,** which would have voided every recharge turn: a decision point is now when every
  game is at a menu or waiting on the cable, and at least one is at a menu (7.2). Struggle keeps its menu.
- **RUN works in link battles** and ends them; ITEM is offered but refused (4.1, 7.3). No longer open questions.
- **Known desyncs:** Psywave, Counter, Bide, Metronome and Mirror Move banned (4.1).
- **The live page leaked** exact HP and PP: live pages show only what both sides see; screens after the end (13).
- **Storage:** state under its own immutable key, then a compare-and-set on a small document (8.2).
- **Speed:** turns resolve after the response under a lock; the sweep only records fallbacks (8.2); WebAssembly timed
  in a function first (14).
- **Boundaries:** the rig is passed into `createRelay` in code, so the relay never imports it (8.3, 12).
- **Practice** needs the token and has a global cap (6).
- **A turn cap and a draw rule** (4.2); version stamps for deploys mid-match (4.3); a seeded bootstrap (7.1).
- **The save writer** dropped for hand-played saves; team matches need a bootstrap before the party exchange (4.5, 7.4).
- **Estimates:** about 6 to 10 weeks, up from 5 to 8.
