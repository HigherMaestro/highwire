# PRD: Link battles

Status: **proposed, 2026-11-14. Nothing built.** A second game for Highwire's fighters, beside The Line: two agents
fight a real Pokémon Yellow link battle, the game's own code deciding every turn. It brings JK Clawseum's Competition
002 work (`~/git/jkclawseum`, last touched 2026-03-25) to Highwire. "Link battles" is a working name, not a public one
(14).

## 1. Summary

Every Highwire fighter (a coin its agent launched with Highwire's tools, registered for The Line) can also fight link
battles. Two agents each command a team in Pokémon Yellow's Colosseum: two emulated Game Boys joined by an emulated
link cable, exactly as two players with a cable would. An agent never presses buttons. Each turn it sees what its own
screen shows and picks a move or a switch; its rig presses the buttons, runs the game to the next decision and reads
the result from memory. People watch the battle turn by turn on highwire.fun.

The game decides everything, its randomness included. This is agent against agent, and the point is the decisions,
so there are no commitments, seeds or proofs, unlike The Line. What a match does need is that both games agree about
what happened, and the referee checks that every turn.

**Where the games run** is the decision that shapes the rest (8). This PRD recommends that each owner's own machine runs
its own Game Boy, with its own copy of the game, and that Highwire's referee carries only the bytes the link cable
would: the Game Boy to Game Boy connector Clawseum imitated, over the internet. Highwire then never holds the game or
shows its graphics.

## 2. Goals, non-goals, success

**Goals**
- A second game for the fighters The Line already has, one people understand on sight.
- The real game, not a copy: battles play out in Pokémon Yellow's own code.
- Decision-level play: an agent picks a move or a switch, never a button, a menu or a timing.
- Headless and portable: the rig runs in Node on any machine (no Mac, no windows, no focus), and a turn resolves in
  about a second plus the network.
- Matches nobody can quietly bend: both games must agree every turn, or the match is void.

**Non-goals**
- **Anything of value tied to results, and no wagers.** The same rule as The Line (docs/arena.md 10), and here the
  outcome comes from a game Highwire doesn't control.
- Overworld play, catching, training, trading or items. The battle only.
- A copy of the game's rules or data in Highwire's code. When the rig needs base stats, learnsets, move power or the
  type chart, it reads them from the owner's copy of the game at runtime.
- **The game, or anything made from it, in the repository, the npm packages or any server.** That includes save states,
  which hold the game's graphics in video memory, and screen captures.
- A house bot in the online queue (it would need the game on Highwire's servers). The house plays in practice only, on
  the owner's machine.

**Success, measured weekly; reviewed after 8 weeks**
- Weekly active fighter owners in link battles; finished-match rate (ended by the game, not voided or forfeited);
  desync rate; median turn time. **Rethink** below 10 weekly active owners or a finished-match rate under 70% after 8
  weeks, and **stop online play** if desyncs void more than 5% of matches after phase 1's fixes.

## 3. Users and stories

- **An agent owner:** "My fighter already plays The Line. I point it at link.md, give it the path to my copy of the
  game, and it practises against the house on my machine, then queues for real battles. I watch them on highwire.fun
  and see its record."
- **An agent:** "I call `link_join`, get paired, read my side of the battle, pick a move or a switch with
  `link_move`, and repeat until it ends. If I'm slow, my declared fallback move goes in."
- **A spectator:** "I watch two agents' teams trade hits turn by turn, with their table talk beside it, and open a
  fighter's page for its record in both games."

## 4. The game

### 4.1 The format (`colosseum-1`)

- **Pokémon Yellow (English, the one release the rig supports, checked by checksum), link battle in the Colosseum.**
- **Teams: three each, a fixed mirror.** Both sides get the same three Pokémon at the same level, with the same moves,
  chosen in phase 0 for a fair, readable battle. Three, not six, keeps a match to about 10 to 20 turns. Team building
  comes in phase 5 (4.5).
- **Open team sheets:** both teams are shown to both agents from the start. With mirror teams that's already true; it
  stays the rule when teams are built, because under 8B a modified client can read the opponent's whole party from its
  own game's memory, as the original game's players could with the right tools.
- **Actions:** a move (slot 1 to 4) or a switch (to a Pokémon in reserve). After a faint, a forced switch. Items aren't
  allowed in link battles. RUN is never sent *(what it does in a link battle is confirmed in phase 1)*; forfeiting is
  a referee action.
- **Turns the game plays itself** (a recharge after Hyper Beam, Wrap, Thrash, Bide, Rage, Struggle when nothing has PP)
  ask the agent nothing.
- **The end:** the game's own end of battle, which both sides must report alike. Also forfeit, or void (4.3).

### 4.2 The clock and fallbacks

- **A chess clock,** as on The Line: each side has a bank (8 minutes a match *(to tune)*), charged for the time it takes
  to decide. An empty bank means every decision takes the fallback at once.
- **Fallbacks,** declared at `link_join`: `first` (the first legal move), `strongest` (the highest-power legal move,
  power read from the game) or `random` (uniform over legal moves). A forced switch's fallback is the first Pokémon
  still standing.
- **Gone:** a side whose rig stops answering for 2 minutes forfeits. Both gone: void.

### 4.3 Void, desync, forfeit

- **Desync:** after every turn each rig reports what its game shows (4.4); any disagreement voids the match, unrated.
- **Stuck:** a rig that can't land a decision's button presses (7.3) or runs past its frame budget voids the match,
  unrated, and logs the game's state locally for a bug report.
- **Forfeit:** rated after 3 turns, like The Line's forfeits after 3 rounds; unrated before.

### 4.4 Turn reports

After each turn each rig sends the referee the turn as its game shows it: who moved first, each move used, HP before and
after as numbers (both sides' rigs can read the real HP, since the game keeps both in memory), critical hits, misses,
effectiveness, status changes, faints, switches, and the turn's table talk. The referee compares the two reports field
by field. When they match, the turn is recorded and published. That record is the match: the spectator page, the replay
and the result all come from it.

### 4.5 Later: teams the agents build

An agent submits three (later six) Pokémon, each a species, four moves and a level within the cap. Its rig checks
legality against the learnsets read from the game, computes stats with the published Gen 1 formula (best DVs and stat
experience, fixed by the format) and writes the party into its game before the battle. The referee checks the party
block that crosses the cable against the submitted team sheet, so a forged team is refused.

## 5. Who can fight

- **A registered fighter,** the same registration and token as The Line (docs/arena.md 5): a coin its agent launched
  with Highwire, on mainnet. No new registration; `agent.json` already holds the token.
- **The owner's own copy of the game,** dumped from a cartridge they own, at the path `HIGHWIRE_LINK_ROM` names. The
  rig checks its checksum and refuses anything else. Highwire never supplies, links to or hosts the game. link.md says
  this plainly, and says the owner is responsible for having the right to their copy.
- **Local server only,** as with The Line's move tools: the rig runs in the agent's local MCP server.
- **Operator coins** may play and are never ranked.

## 6. Playing: tools and flow

| Tool | |
|---|---|
| `link_rules` | the format, the actions, the fallbacks, the clock; also on the hosted endpoint |
| `link_practice` | a battle against the house bot on this machine: both Game Boys run locally. No wallet, no token, nothing recorded |
| `link_join` | queue with a fallback; long-polls up to 40 seconds, like `line_join`, and returns the match or `waiting` |
| `link_state` | this side's view (6.1); long-polls for the next decision |
| `link_move` | this turn's action and one line of table talk |
| `link_leaderboard` | link battles' ladder; also on the hosted endpoint |

`link_join` starts the rig, which builds the battle locally (7.4), connects through the cable relay (8.2) and keeps
running between tool calls. The agent only ever sees decisions.

### 6.1 What an agent sees

Its own screen, never more. The rig can read the whole battle from memory, opponent included, so every view is built in
one file and tested to contain only what the screen shows, the same rule as The Line's `view.ts`:
- `phase`: `choose`, `replace`, `waiting` (for the other side), `ended`
- `turn`, the clock (each side's bank)
- `you`: your whole team: species, level, HP and max HP, status, the four moves with PP, which one is out
- `them`: their team sheet (4.1); the active Pokémon's HP as a percentage (the game shows a bar), its status, the
  moves it has used, which of theirs have fainted
- `field`: what's on screen or announced: Reflect, Light Screen, a substitute, confusion, Leech Seed, a toxic count,
  announced stat changes
- `log`: the last turn's agreed report (4.4)
- `legal`: the actions the game will accept now
- `their_line`: the opponent's table talk, labelled as their words, through `summarizeMessage`

### 6.2 Table talk, permissions, cost

- **Table talk:** one line a turn, `checkTableTalk`'s rules (no links, addresses or mentions), unmoderated, exactly as
  The Line (docs/arena.md 6, 10).
- **Permissions:** link.md shows how to allow the link tools for unattended play, as line.md does.
- **Cost to an owner:** a turn is one or two model calls with a context that grows; roughly $0.30 to $3 a match with a
  frontier model *(estimate)*. link.md says so and suggests a smaller model.

## 7. The rig

### 7.1 The emulator

SameBoy's core (`Core/` only, Expat licence, version 1.0.3, the version Clawseum used), as a dependency:
- **Built to WebAssembly** with Emscripten and wrapped in a small TypeScript API, so it installs from npm and runs in
  Node with no native build. A native addon is the fallback if WebAssembly is too slow (phase 0 measures).
- **Stepped, not real time:** `GB_run_frame` as fast as it goes, rendering off (`GB_set_rendering_disabled`).
- **Input:** `GB_set_key_state`, held for a set number of frames, then released, each press logged with its frame.
- **Memory:** read directly (`GB_get_direct_access`), never by parsing save-state files.
- **Two Game Boys in one process** for practice, joined by the core's serial callbacks
  (`GB_set_serial_transfer_bit_start_callback`, `_bit_end_callback`, `GB_serial_set_data_bit`), the way SameBoy's own
  libretro core links two. Online, the second Game Boy is the other owner's, through the cable relay (8.2).
- **Deterministic:** the same game, save and inputs on the same frames give the same battle. Link battles share their
  random numbers: one game makes a list and sends it over the cable, so both roll the same dice *(from the public
  disassembly; confirmed in phase 0)*.

### 7.2 Decision points

The rig runs its game until it's waiting for a choice, the battle ends, or the frame budget runs out. Its game is
waiting when memory shows the battle menu (FIGHT / PKMN / ITEM / RUN) or, after a faint, the party menu
(`replacement_pending` in Clawseum). The game's *Waiting...!* for the other player isn't a decision point. Turns the game
plays itself (4.1) are pressed through. The exact memory signs for each state are phase 1's main work.

### 7.3 From a decision to buttons

- **Move k:** cursor to FIGHT, A, cursor to slot k, A; landed when `wPlayerSelectedMove` holds the move.
- **Switch to n:** cursor to PKMN, A, cursor to n, A, SWITCH, A; landed when the game takes the switch.
- **Forced switch:** cursor to n, A.

Cursors are moved by reading where they are (`wCurrentMenuItem` and the rest), never by counting presses from an
assumed start. A step that doesn't land is retried once from a fresh read; a second miss voids the match (4.3).

### 7.4 Getting into the Colosseum

Nothing made from the game can be shipped, so each rig builds its battle itself:
1. **A save file Highwire's code writes:** the format's team, a player standing in the Pokémon Center's Cable Club, the
   save's checksum. It's made of names and numbers, from the documented save layout, with nothing copied from the
   game.
2. **The walk in:** the rig boots the owner's game with that save and presses through talking to the receptionist,
   saving and choosing the Colosseum. The link handshake goes over the cable (locally in practice, through the relay
   online).
3. **The first menu of the battle** is the first decision.

Clawseum's paired save states, made in SameBoy's app, are a reference for phase 0 only and never leave that machine.

## 8. Where the games run

### 8.1 The options

**A. Hosted.** The referee runs both games, a turn per request: load the pair's state from the store, press both
decisions, run to the next decision, save. It's the simplest to build, it fits the stateless referee, and it would allow
a house bot online and real game frames for spectators. But Highwire's servers hold and run the game, and its pages show
the game's graphics.

**B. Linked over the internet (recommended).** Each owner's machine runs its own Game Boy with its own copy of the
game; the referee carries only the link cable's traffic. Highwire never holds the game or shows its graphics, and it
needs no new infrastructure: the relay fits the referee already on Vercel and Upstash. It's more work (8.2), and
each owner has to supply the game.

**C. Local only.** Practice and same-machine matches. No online play.

**Why B:** the exposure in A (10) is the one thing that could take the whole feature down, and B removes it at the cost
of a few weeks. B is also what Clawseum's connector was for. The decision is the maintainer's, with a lawyer (15).

### 8.2 The cable relay (B)

A real cable swaps one byte each way per clock pulse, and a battle's start swaps hundreds. Relaying byte by byte over
HTTPS would take minutes, so the relay works in **blocks**:
1. When a rig's game starts a link exchange, the rig knows which one from where the game is running (the handshake, the
   party exchange, a turn's choices). It reads the outgoing block straight from memory, where the game has already
   prepared it, and posts it: `POST /api/link/<match>/cable { seq, block }`.
2. The referee stores it and answers only when the other side has posted the same `seq`. **Neither side's block is
   served before both are in**, so a turn's choice is never seen early (The Line's rule about open rounds, unchanged).
3. With the partner's block in hand, the rig plays the exchange out locally against a stand-in for the partner that
   feeds those bytes back, timed as the game expects.

*Confirmed before phase 3:* that every exchange in a link battle is a fixed block prepared before it's sent (the public
disassembly suggests so), and how many exchanges a turn takes. If some exchange isn't, the relay handles that one byte by
byte. Expected cost: a few round trips a turn, about 1 to 2 seconds on Vercel's long-polls *(estimate)*.

### 8.3 The referee

- **Where:** the site's referee (`/api/link/*`), on the same Upstash database as The Line's, behind the same
  `LINE_*` connection; matches under their own keys.
- **What it does:** pairs fighters, relays cable blocks, runs the clocks, compares turn reports, records the agreed
  turns, rates the result. It never sees the game.
- **The party check:** the party block crosses the relay at the start, so the referee checks it against the format's
  team (and, in phase 5, the submitted team sheet). A mismatch voids the match before turn 1.
- **Clocks** settle lazily on reads and in the existing minute sweep, as The Line's do.
- **Budget:** about 20 turns × (a few cable posts + long-polls + two reports) ≈ 1,500 to 3,000 commands a match
  *(estimate)*, about the same as a Line match.

### 8.4 If A is chosen instead

7.1 to 7.4 are unchanged; the referee runs the two Game Boys itself (a turn is roughly 700 to 1,500 frames a game, which
phase 0 times in a Vercel function), 8.2 isn't needed, the house can play online, and spectators can see frames. Phases
0 to 2 are the same under both, which is why they come first.

## 9. Matchmaking, ratings, the house

- **Pairing and ratings:** The Line's queue and Glicko-2, on a separate ladder (`colosseum-1`). Its leaderboard
  entry rules, owner-wallet rule (two fighters from one wallet are never paired), weekly cap on rated matches per pair
  and review flags all carry over.
- **No house online** under B: an unpaired fighter just waits, and `link_join` says how many are queued.
- **The house in practice:** picks the legal move with the best expected damage (power, the type chart and same-type
  bonus read from the game, accuracy), switches when its Pokémon is badly matched and a reserve isn't. Labelled as
  Highwire's. A floor, not a solution.

## 10. Legal, conduct and conflicts (not legal advice)

- **Copyright:** the game is Nintendo's. Under B, Highwire distributes nothing from it and runs nothing from it: its code
  is an emulator wrapper, a save-file writer and a relay of link traffic, and owners supply their own copies. Under A,
  Highwire runs the game on its servers and shows its screens, which is the exposure that makes B the recommendation.
  Either way, a lawyer reviews this section before anything goes public.
- **Trademark:** "Pokémon" may describe what the game is, but never in the product's name, logo, coin language or
  share cards, and nothing implies a licence or endorsement.
- **Gambling:** no prize, so no gambling (docs/arena.md 10). No wagers on link battles, ever.
- **No backing language,** no odds, and a rating says nothing about a coin, as on The Line.
- **Conflicts:** Highwire's trade fee is disclosed on every page; operator coins aren't ranked.
- **User content:** table talk as The Line: the text rule, no moderation, a takedown route for what the law requires.
- **Terms** gain a link battles paragraph: bring your own copy, nothing of value awarded, voids and removal, match
  records public.

## 11. Abuse and threats

| Threat | Mitigation |
|---|---|
| Reading the opponent's team from game memory | Open team sheets: nothing hidden to read (4.1) |
| Seeing the opponent's choice early | The relay serves no block until both sides' are in (8.2) |
| Editing one's own game mid-battle | The two games stop agreeing; the match is void (4.3) |
| A forged or illegal team | The referee checks the party block that crosses the cable (8.3) |
| Desyncing on purpose to void a lost match | Each fighter's void rate on its page; flags for review; voids never rated |
| Stalling | The chess clock; fallbacks |
| Quitting to deny a rating | Forfeits rated after 3 turns |
| Prompt injection or scams in table talk | The text rule; opponents' words are data |
| Token theft | Tokens never in tool arguments, results or logs; local server only |
| Owners sharing or hosting the game | Highwire never links to, hosts or names a source; the checksum identifies a release, not a file |
| Store quota drained | Per-token rate limits on cable posts and long-polls, as on The Line |

## 12. Packages and boundaries

As with the wager code (docs/boundaries.md):
- **`packages/link/` (`highwire-link`):** the rig (the WebAssembly build, its TypeScript API, decision points, button
  sequences, the save writer, views, the house bot), the tools, and a `highwire-link` bin that runs the MCP server with
  them. `createServer` takes its tools in code, as it takes `wagers`; nothing in `highwire-core`, `-agent`, `-mcp` or
  `-relay` imports it (a test checks).
- **The referee's link routes** in `packages/relay/src/link/`: pairing, the relay, clocks, reports. No emulator code.
- **The site:** `/link`, `/link/match/<id>`, and a link battles record on `/line/fighter/<mint>`.
- **Files:** a repository test fails on any `.gb`, `.gbc`, `.sav` or SameBoy state file. Tests that need the game skip
  without `HIGHWIRE_LINK_ROM`, so CI never has it; the views, save writer and referee are tested on synthetic memory.
- **`HIGHWIRE_LINK=0`** turns the tools off, and they stay off by default until phase 4.

## 13. The pages

- **/link:** live battles, recent battles in time order, the ladder. No top five, nothing picked by results.
- **/link/match/<id>:** the battle turn by turn, drawn by Highwire (both teams by name, HP bars, the log, each side's
  table talk), from the agreed turn reports. No game graphics. Opens at turn 1 without the result, as The Line's replays
  do.
- **Fighter pages** show both records, The Line's and link battles', side by side.
- **highwire.fun/link.md:** for agents: bringing your own copy, the tools, the loop, fallbacks, permissions, costs.

## 14. Phases and acceptance

| Phase | Builds | Done when | Rough size |
|---|---|---|---|
| 0. The rig | SameBoy's core in WebAssembly, two linked Game Boys, the API, the save writer and the walk into the Colosseum, the format's team | One full turn resolves headless in Node, both games agree, under 2 seconds | 3 to 5 days |
| 1. The whole battle | Decision points, the button sequences, turns the game plays itself, the end, turn reports, desync checks | A fuzzer plays 1,000 random-legal battles: no stuck rig, desyncs counted and their moves known, every end matching the game's | 1 to 2 weeks |
| 2. Practice | `highwire-link`, `link_rules`, `link_practice`, the house bot, the views and their leak tests | An agent plays the house to the end through the MCP tools on one machine | 1 week |
| 3. The cable | The block relay (8.2) with a fake referee, then the real routes on a preview | Two rigs on two machines finish a battle through the referee, both games agreeing every turn | 2 to 3 weeks |
| 4. Online | The queue, ratings, `link_join` / `state` / `move`, the pages, link.md, the terms, after the legal review | Two registered fighters from different owners finish a rated match on highwire.fun | 1 to 2 weeks |
| 5. Teams | Team building with open sheets (4.5) | An agent's submitted team reaches the battle intact, and a forged one is refused | 1 week |

About 7 to 11 weeks to online play, most of it in phases 1 and 3.

## 15. Decisions needed from you

1. **8B (recommended), 8A or 8C,** after a lawyer reviews 10. Phases 0 to 2 can start before it.
2. **The format:** three-a-side fixed mirror teams first (recommended), or six, or team building from the start.
3. **The go-ahead for phase 0.**
4. **A name,** after a clearance search, with no "Pokémon" in it.

## 16. Open questions

- What RUN does in a link battle, and whether ITEM is offered at all. (Phase 1.)
- How many frames a turn takes, and how fast WebAssembly runs them. (Phase 0.)
- How often Gen 1 link battles desync, and on which moves; if often, the format bans those moves. (Phase 1.)
- Whether every exchange in a battle is a block prepared before it's sent (8.2). (Before phase 3.)
- Whether owners will supply their own copy of the game: the requirement that most limits who can play under B.

## 17. What carries over from Clawseum

Clawseum got multi-turn battles where both sides use their first move, through to a real end. Its code is the
maintainer's own, so it can be brought over:
- **The memory map:** Yellow's battle addresses (`wIsInBattle` 0xD056, `wBattleMonHP` 0xD014, `wEnemyMonHP` 0xCFE5,
  `wPlayerSelectedMove` 0xCCDC, `wEnemySelectedMove` 0xCCDD, `wBattleResult` 0xCF0B and about twenty more, in
  `tools/competition_002_spike1/sameboy_spike.py`), with the WRAM bank logic.
- **The lifecycle rule (its Phase 1N correction):** HP at zero and a set `wBattleResult` don't end a battle. A faint with
  a Pokémon in reserve is a forced switch, and the battle ends only when the game leaves it. The rule comes over with
  its tests.
- **The shapes:** the normalized state (phase, turn, each side's active Pokémon, legal actions, outcome) and actions
  (`fight_move`, and the `switch_party_slot` it designed but never built), the starting point for 6.1.
- **The architecture's split:** the game behind an adapter, the platform owning turns, deadlines, legality and the
  record. Kept.

Not carried over: AppleScript and Quartz key events, window focus, the 12-second settle waits, the save-state files on
disk and their freshness checks. Each existed only because the game ran in an app the code couldn't step.
