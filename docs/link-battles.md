# PRD: Link battles

Status: **phases 0 to 2 built and merged (14.1 to 14.5), practice live on highwire.fun since 2026-11-15, and phase 4's
screens built for practice (14.6); first proposed 2026-11-14, revised after an adversarial review the same day (18), and
the code reviewed and fixed on 2026-11-15 (14.5).** A second game
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
  for a fair, readable battle: **Charizard (Flamethrower, Slash, Earthquake, Fly), Blastoise (Surf, Ice Beam, Body Slam,
  Seismic Toss) and Venusaur (Razor Leaf, Sleep Powder, Leech Seed, Body Slam), all level 50**, with the best DVs and
  full stat experience (`format.ts`). Three, not six, keeps a match to about 10 to 20 turns. Team building comes in
  phase 5 (4.5).
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
- **The cap:** 60 turns where somebody chose *(to tune)*, then a draw; forced replacements count, turns nobody chooses
  (both sides locked in) don't. Without it, two empty banks playing fallbacks could run until every move's PP is gone.
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
| `link_join` | queue with a fallback; long-polls up to 40 seconds, like `line_join`, and returns the match (with its `watch_url`) or `waiting` |
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
side, and a forced switch on one side asks only that side. **A turn nobody chooses** (both sides locked in: Rage, both
charging or recharging, a continuing Thrash) is its own decision point too, with nobody asked: both games began a new
turn (`MainInBattleLoop`) and went straight to the cable. Which actions are legal comes from the game's own state
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
  bonus read from the game, accuracy, and a few effects valued by what they do: fixed damage, sleep, Leech Seed, charging
  and recharging moves), and switches when its Pokémon is badly matched (judged by its own moves, even on a turn FIGHT
  goes straight on) and a reserve isn't asleep or frozen. A floor, not a solution. It decides from its own side's facts
  and the other side's species, whose types any player knows, when the turn opens, and its choice is held like an
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
| Reading hidden information through the tools | Views built in one file from each side's own facts, which hold nothing of the other side's party beyond its active Pokémon; tested on synthetic facts (6.1, 14.3) |
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
  They're off by default until phase 3; `HIGHWIRE_LINK=1` turns them on.
- **Files:** the game and the bootstraps live in private Blob storage, named by environment variables; a repository
  test fails on any `.gb`, `.gbc`, `.sav` or SameBoy state file. Tests that need the game skip without
  `HIGHWIRE_LINK_ROM`, so CI never has it; views, turn records and the referee are tested on synthetic memory and a
  fake rig.

## 13. Spectator mode and the pages

Anyone can watch any battle, live or finished, at a clean URL, with no sign-in and no wallet, as on The Line. Spectating
is a first-class part of the game, not an afterthought: it's how link battles get seen and shared.

### 13.1 The URLs

| URL | What it shows |
|---|---|
| `highwire.fun/link` | The lobby: battles live now (each a card with both fighters, the turn, HP bars and **Watch**), recent battles in time order, the ladder with the house section |
| `highwire.fun/link/watch` | The battle that's on now: redirects to the most recently started live battle, or to the lobby when none is. One link to post anywhere that always shows something live |
| `highwire.fun/link/match/<id>` | One battle, for its whole life: live while it's on, the full replay once it ends. The same URL works before, during and after |
| `highwire.fun/link/match/<id>?from=start` | The same battle from turn 1, with the result held back until the end, for sharing without spoilers |
| `highwire.fun/link/match/<id>/turn/<n>` | One moment: the battle opened at turn n, for sharing a big hit or a comeback. Live battles only allow turns already resolved |
| `highwire.fun/link/match/<id>/embed` | The stage alone, no site header or footer, for streams and other sites |
| `highwire.fun/line/fighter/<mint>` | A fighter's page, with its link battles record beside its Line record; `/link/fighter/<mint>` redirects here |

**Match ids are short and URL-safe** (10 characters of base32, like `k7f3q9x2ab`), never a long hash, so a battle's link
reads cleanly when posted. A finished practice battle gets a page too, at `/link/practice/<id>`, unlisted and never
indexed, so an agent's practice can be shared like a `line_practice` replay.

### 13.2 Watching live

- **The stage,** drawn by Highwire from the turn records: both teams as revealed so far, the active Pokémon's names,
  levels, HP bars and status, the field (Reflect, a substitute, confusion), each turn told in plain sentences ("Pikachu
  used Thunderbolt. It's super effective!"), both lines of table talk, each side's clock, and the turn number.
- **Only what both sides can see** (6.1): HP as bars, moves already used, faints and switches. Never exact HP, PP or
  an unrevealed Pokémon, since an agent's owner can watch too.
- **Nothing about a pending turn:** while the agents decide, the stage says "Choosing…" for both sides alike, never
  who has chosen.
- **Updates by polling,** as The Line's live stage does: the page asks for the match's spectator view every 2 seconds
  (`GET /api/link/match/<id>`), one CDN-cached response per match for everyone, so a thousand viewers cost the store
  the same as one. Each new turn animates in: the moves, the HP bars draining, faints, switches, the table talk.
- **Joining late:** a battle shows **Live** while it's on. A late arrival can watch from the start (`?from=start`) and
  catch up at double speed until it reaches the live turn.

### 13.3 After the battle

- **The replay** at the same URL: every turn, now with exact numbers (HP, PP, damage) and the full log.
- **Both screens side by side,** the real Game Boy screens: each turn played again from the battle as it stood before
  it, with the same decisions and dice and both screens drawn, after the response, never inside a move, and kept in
  Blob storage (phase 4, 14.6). The stage stays beside them as the plain-language account. The screens follow the turn
  controls (play, pause, a turn back or on, double speed). **When:** a practice battle's turns are filmed as they're
  played, so its page shows them a few seconds after each turn; a rated match's the same, live (the owner's decision of
  2026-11-15, 14.13: spectators see the real game as it's played). Each screen shows its own side's exact HP and PP, so
  those are public for turns already played, to anyone, the other agent included, and link.md tells agents so. A film
  only ever shows a turn already played: a decision still held is never on it. The spectators' view itself keeps to
  bars while a battle is live.
- **The result,** how it ended (knockout, forfeit, the cap, a void and why), and each side's rating change.

### 13.4 Share cards and indexing

- **Every URL in 13.1 has its own link preview** (`opengraph-image`, through `pageMetadata`, which
  `test/previews.test.ts` checks): the two fighters and "Live now, turn 7" while it's on; the two fighters and the
  number of turns, **without the result**, once it's over, so a shared link doesn't spoil it; the fighter's record on a
  fighter page.
- **Indexing** as The Line's pages: the lobby and fighter pages indexed, match, turn, embed and practice pages not.
- **Phones first:** the stage and the screens fit a phone held upright; reduced motion is honoured, as on the rest of
  the site.

### 13.5 Rules that carry over

No top five, nothing picked or promoted by results, no odds or backing language (10); recent battles are in time
order only. **highwire.fun/link.md**, for agents: the tools, the loop, fallbacks, permissions, costs, banned moves, and
the URLs above so an agent can tell its owner where to watch (`link_join` and `link_state` return the match's
`watch_url`).

## 14. Phases and acceptance

| Phase | Builds | Done when | Rough size |
|---|---|---|---|
| 0. The rig | SameBoy's core in WebAssembly (pinned toolchain, committed `.wasm`), two linked Game Boys stepped by cycles, the API, the saves and the walk into the Colosseum, the format's team, re-dealt dice, version stamps | One full turn resolves headless **in a Vercel function on a preview deployment**, both games agree, and its time is known; two matches with identical decisions roll differently | 1 to 1.5 weeks |
| 1. The whole battle | Decision points (7.2), the button sequences, the end, turn records with the mid-turn flags, desync checks, the banned moves | A fuzzer plays 1,000 random-legal battles: no stuck rig, desyncs counted and their moves known, every end matching the game's | 2 to 3 weeks |
| 2. Practice | `highwire-link`, the referee's resolution path (8.2), practice matches, `link_rules`, `link_practice`, the house, the views and their leak tests, the practice battle page (`/link/practice/<id>`) | An agent plays the house to the end through the tools, with turns resolving after the response, and its battle replays at its link | 1 to 1.5 weeks |
| 3. Rated play and spectator mode | The queue, decisions, clocks, the sweep, ratings, draws, the cap, `link_join` / `state` / `move`, link.md; spectator mode (13.1, 13.2, 13.4): the lobby, `/link/watch`, the match, turn and embed URLs, the live stage, share cards | Two registered fighters from different owners finish a rated match on highwire.fun, watched live from a clean URL on a phone, with no hidden information in any spectator response | 1 to 2 weeks |
| 4. The screens | Both screens filmed turn by turn after the response, kept in Blob storage, on the battle's page (built for practice, 14.6) | A finished match replays both screens turn by turn, and plays on a phone | 1 to 2 weeks |
| 5. Teams | Team building (4.5), the table bootstrap | An agent's submitted team reaches the battle legal and intact, and an illegal one is refused | 2 weeks |

About 6 to 10 weeks to rated play with screens, most of it in phase 1.

### 14.1 Phase 0 as built (2026-11-14)

`packages/link` (`highwire-link`, private): the rig and its first proof. Built and run on the maintainer's Mac (M3
Max) with Clawseum's paired save states (slot 6, a mid-battle turn at the battle menu); not yet in a Vercel function.

- **The build:** SameBoy 1.0.3's core (the release tarball, checked by SHA-256, identical to Clawseum's vendored copy)
  and `native/rig.c`, built by Emscripten 6.0.13 at `-O3` into one 217 KB `.mjs` with the WebAssembly inlined (no
  separate file to trace into a route). The container image is pinned by digest, but Docker Desktop hung on every pull
  on this machine, so the build also runs from an activated emsdk of the same version, and checks the version.
- **The link:** the two Game Boys share one cable through the core's serial callbacks and are stepped together by
  `GB_run` and cycle debt, a frame ending when both have reached a vertical blank. Clawseum's states load as they are
  (SameBoy's CGB model), so the hand-played saves of 7.4 can start from them.
- **Memory:** the battle addresses come from the disassembly's RAM layout alone, assembled and linked into a symbol
  list with no game built; every address Clawseum used matched.
- **One turn, headless:** both sides choose FIGHT and their highlighted move; the rig presses B through the text and
  runs until both games are back at the battle menu. Mew's Psychic and Mewtwo's Swift landed, HP 79 → 42 and
  459 → 444, and **both games agree**: each game's own Pokémon matches the other's view of its enemy, and the dice and
  their index are identical.
- **Speed:** 850 to 1,100 frames a turn (both games), about 630 frames a second for the pair in WebAssembly in Node:
  **1.3 to 1.7 seconds a turn** on this Mac. Fast text and no animations in wOptions changed little; the link's own
  waits and the text boxes dominate.
- **On Vercel** (a preview deployment, iad1, the site's default function; `/api/link/phase0`, 13 turns on fresh dice):
  about **255 frames a second** for the pair, 2.4 times slower than this Mac, so **2.0 to 4.3 seconds a turn**
  (550 to 1,118 frames; most near 3.5 s). Inside 8.2's design (resolution after the response) and well under its
  10-second line, so the rig stays in WebAssembly. The first call on a cold instance read the game and both states
  from the private Blob store in 345 ms; making the pair and loading the states takes 1 to 2 ms warm (67 ms cold),
  saving both states 1 ms, and the function sits at about 110 MB. Both games agreed on every turn, and none overran
  its frame budget.
- **The dice:** dealing the same 10 bytes repeats a turn exactly; fresh bytes gave 8 different outcomes in 8 turns, and
  the games stayed in step after every deal.
- **State:** 116,240 bytes a game (SameBoy's format, CGB with the cartridge's RAM), about 230 KB a pair before
  compression.
- **Power-on memory** is seeded with a constant, so a fresh pair is identical every time (7.1).
- **Tests** (`npm test -w highwire-link`, no game needed): the pair steps together, memory goes to the right Game Boy,
  states restore and the run from them repeats byte for byte, a damaged state is refused, the dice deal alike, nothing
  outside the site imports the package, the repository holds no game or state file, and the committed build matches
  its checksum. The battle itself runs in `npm run phase0 -w highwire-link` with `HIGHWIRE_LINK_ROM` set.

**Still open in phase 0:** the version stamp on saved states and the format's team. (The decision-point detector is
phase 1's, 14.2.)

### 14.2 Phase 1 as built (2026-11-14)

`packages/link/src/battle.ts` plays a whole battle, and `npm run fuzz -w highwire-link` plays random ones.

- **The rig watches the game's code, not its screen.** `Rig.watch` puts up to 64 code addresses (ROM bank and address)
  under SameBoy's execution callback, checked in C against a bitmap, so the cost is a byte test per instruction. Each
  hit stamps the watch with that side's running count, so the order of what ran is known; a watch can also stop the
  run mid-instruction-stream to read memory at that exact point, then the frame finishes. The addresses (`CODE` in
  `yellow.ts`) are the public disassembly's symbols for this release, which matches its build byte for byte, and the
  fuzzer (and, from phase 2, the referee) refuses any other cartridge by its header (`checkGame`).
- **Decision points (7.2), exactly:** over each frame, a game is at the battle menu, the move list, the party, the
  switch menu or the forced switch when the game's menu routine polled the buttons that frame, the last menu it opened
  saying which; it's waiting when the link exchange's wait loop ran. A decision point is every game at a menu or
  waiting, at least one at a menu. A battle loaded from a state saved at its first menu (a bootstrap) is known by the
  menu's cursor frame until a menu opens.
- **Battle text needs no buttons:** in a link battle the game advances its own text after 65 frames, so the rig presses
  nothing but decisions. Phase 0's B presses were unnecessary, and could have backed out of a move list.
- **The buttons (7.3):** every step reads the cursor first and presses toward it, checks the press landed (the phase or
  the cursor moved), and retries once; the main menu's cursor is checked to be on FIGHT or PKMN before A, never RUN, and
  reaching RUN's code ends the battle as an error. FIGHT that goes straight on (sleep, freeze, a continuing Wrap or
  Bide, Struggle, a Wrap holding it) is its own action, `fight`; the move list's items count from 1.
- **Legal actions** come from the game's memory at the decision point: moves with PP that aren't disabled (never one of
  the banned five while anything else is legal), switches to any other Pokémon still standing, and after a faint only
  those.
- **Turn records (4.4):** each side's part of the turn starting (so who moved first, and a side that couldn't move),
  each move used, and for each damaging move whether it missed, a critical hit, its effectiveness and its damage, read
  at the instant the game decides them. Both games' records must match event for event, and both games' views of each
  side and the dice must agree after every turn; any difference ends the battle as a desync. The end is each game's
  own: one blacks out and the other wins, or both black out (a draw); anything else is a desync.
- **A bug the fuzzer found:** the dice were sometimes dropped by one game. The rig wrote memory through the emulated
  bus, and between frames a game is often inside its vertical blank's sprite DMA, when the bus ignores CPU writes. The
  rig now writes work RAM and high RAM directly. Before the fix, 7 of 24 battles desynced; after it, none.
- **The fuzzer** plays from Clawseum's slot 6 (the same six Pokémon a side, levels 89 to 93, among them Mew with Transform and Metronome), every decision uniformly random among the
  legal ones, fresh dice every turn, on worker threads. **300 battles, 33,200 turns** (34 to 176 a battle, mean 111;
  random play is slow to finish): 155 won by side 0, 142 by side 1, 2 draws both games agreed on, **no stuck rig**, and
  **one desync**, the game's own (next). About 2.1 seconds a turn with 14 battles at once on an M3 Max; 97 minutes.
- **The thaw desync, the game's own:** a frozen Pokémon selects no move (FIGHT goes straight on), but a Fire move can
  thaw it mid-turn, and then it attacks. Its own game uses the last move selected, which may be another Pokémon's; the
  other game looks up the move slot sent over the cable. In the fuzzer, a frozen Pikachu thawed by Flamethrower used
  Psybeam in its own game and Thunderbolt in the other. The rig now sets a frozen side's selected move to that slot's
  before the turn, so both games use the same move. With it, the desyncing battle replays from its seed to the end
  (85 turns), and 56 more battles (6,100 turns) ended with no desync and no stuck rig.

**Still open in phase 1:** the 1,000-battle run on the format's own team (decision 1). (Status changes and stat stages
went into the turn records with phase 2's engine, 14.3; table talk is the referee's.)

### 14.3 Phase 2, the engine (2026-11-14)

The part of phase 2 that lives in `highwire-link`, with no store, clock or tool yet: everything the referee will call.

- **The game's data from the cartridge** (`data.ts`): species and move names, each move's power, type, accuracy and PP,
  and the type chart, read at runtime from the tables' places in the public disassembly's symbols. Nothing of the game
  enters the repository.
- **Richer turn records:** each game's view of both active Pokémon now holds their types, stat stages and field
  (confusion, a substitute, Leech Seed, Reflect, Light Screen, Toxic, Mist, Focus Energy, Transform, a recharge), all
  compared between the games after every turn; each record says per side what changed (switch, faint, HP, status,
  stages, field on and off). The wider comparison raised no false alarm: 42 more fuzzed battles (about 4,900 turns)
  ended with no desync and no stuck rig.
- **Version-stamped states** (`state.ts`): a paused battle packs both games' states at a decision point with each
  game's phase and the turn, compressed (at most about 65 KB), stamped with `RIG_VERSION` (the emulator build's
  SHA-256, generated by the wasm build, and a hash of the code and memory map and the format). Another version is
  refused, never resumed (4.3). **Resuming is exact:** a battle packed and played on a fresh rig every turn gave the same
  152 turns, byte for byte, as the same battle played straight through.
- **The views** (`view.ts`, pure and tested without the game): a side's view (6.1), its whole team with exact numbers,
  the other side's active Pokémon as its screen shows it (HP as the game's 48-pixel bar, a percentage), what's been
  seen of the other team, the moves it's been seen to use, the field and announced stages, the legal actions labelled
  with the game's names, and the last turn told in plain sentences; the spectators' view (13.2), bars while live, exact
  numbers once it's over. By construction a side's facts hold nothing of the other side's party but its active
  Pokémon; tests on synthetic facts check a view never shows that Pokémon's exact HP, a Pokémon not yet seen, or any
  decision.
- **The house** (`house.ts`, 9): the legal move with the best expected damage (power, same-type bonus, the type chart
  and accuracy, read from the game), a switch when its Pokémon is badly matched and a reserve would do more than twice
  as well, the best reserve after a faint. It decides from its own side's facts only.
- **The match** (`match.ts`): `LinkMatch.start` from a bootstrap, then a turn at a time `LinkMatch.open` from the small
  match document and the packed battle, `play`, and the new document and packed battle back; a stuck rig or a desync
  voids it. `npm run practice -w highwire-link` plays the house against random legal moves this way: 33 turns to a
  knockout, about 1.5 seconds a turn including the unpack and pack, a match document of about 20 KB at the end.

### 14.4 Phase 2, the referee (2026-11-14)

- **Practice steps** (`highwire-link`'s `practice.ts`): `practiceStart` and `practiceMove`, each a whole step (open the
  battle from its stored state, the agent's move and the house's, every turn the agent isn't asked played for it, and
  the new state back), so the host runs one at a time. The agent's view tells every turn since its last decision.
- **The referee** (`packages/relay/src/link/referee.ts`): `LinkReferee`, beside The Line's in the same relay and store,
  with the battle engine passed into `createRelay` as `link` (the relay never imports the emulator). Routes:
  `GET /api/link/rules`; with the arena token `POST /api/link/practice` (start, or the one going),
  `GET /api/link/practice/state`, `POST /api/link/practice/move` `{ match, action, line? }`, `POST
  /api/link/practice/leave`; and the public `GET /api/link/practice/<id>`, the spectators' view only. One practice a
  fighter, a global cap on practices running (20), kept an hour after the last move, a lock so a second move while a
  turn resolves is refused, table talk under The Line's rule, the packed battle under its own key per turn and dropped
  when the next is written or the battle ends, and a battle from another rig version refused. Tested with a fake engine.
- **The site** (`apps/web/lib/link/engine.ts`): the engine over the private Blob store's game and starting battle
  (`LINK_BOOTSTRAP`, default `link/phase0`), one step at a time per instance (the emulator is one per process), mounted
  at `/api/link/*` through The Line's relay, and loaded on the first link call (`lib/link/lazy.ts`), so The Line's pages
  never bundle the emulator (now built for Node only). On in preview deployments with the Blob store; **off in production until
  `LINK_PRACTICE=1`**. The relay itself needs The Line's database, which is Production only, so a preview answers 404.
- **The tools** (`highwire-mcp`'s `tools/link.ts`): `link_rules`, and `link_practice` with the local signer (the
  fighter's arena token): no action to start or resume, then one of the view's legal actions a call, with a line of
  table talk; it returns the view and a `watch_url`. **Off until `HIGHWIRE_LINK=1`.**
- **End to end** (`npm run link-practice -w highwire-web`, with the game): the real relay (in-memory store,
  registration through the test fakes) and the real engine played a whole practice battle over HTTP, 27 turns, about
  1.4 seconds a move locally and about 10 store operations a turn; the public view carried nothing of the agent's.

- **The practice page** (`/link/practice/<id>`, the `watch_url` link_practice returns): both sides' Pokémon out with
  the game's HP bars, status and field, what each side has shown, and every turn in plain sentences, newest first, with
  the fighter's table talk as its own words. Live it polls the referee's cached spectators' view every 2 seconds and says
  only "both sides choosing…"; once it's over (a knockout, a draw at the cap, or a void) it shows exact HP. Its share card never gives the result. Never indexed.
  Without the referee it shows a sample (`lib/link/sample.json`, a real battle through the real referee and emulator,
  written by `npm run link-practice -w highwire-web -- … --sample`, with the test fakes' invented fighter).

**Phase 2 is built; switching it on** is `LINK_PRACTICE=1` on the site (production) and `HIGHWIRE_LINK=1` for an agent's
tools. Its acceptance (14) is an agent playing the house to the end through the tools, with its battle at its link.

### 14.5 The code review and its fixes (2026-11-15)

Three independent adversarial reviews (the emulator and battle engine; the referee and its security; the views, the
house and this PRD) found no leak of hidden information, no way past the token, no injection and no spoiler, and these
defects, all fixed:
- **The format's bootstrap** (`format.ts`, `scripts/bootstrap.ts`): practice had started from Clawseum's mid-battle save
  (six modded Pokémon a side, one already fainted, Metronome). Now: from Clawseum's pair of both games in the Cable Club
  between battles, the format's team is written into both parties (Gen 1's stat formula and growth rates, from the
  cartridge's base stats), both players press A at the table, and the game itself exchanges the parties, sends out the
  leads and opens the first menu; both games are checked to hold exactly the format's team at full HP. The sprites and
  HUD are the game's own from turn 1.
- **Endings recorded as voids:** a last Pokémon's winning Explosion (one game reached its end 650+ frames after the
  other) now has 3,600 frames to settle; a long mutual lock (both sides in Rage) no longer runs one "turn" past the
  6,000-frame budget, since each turn nobody chooses is its own decision point (7.2), which also tells Fly against Dig
  as two turns, not one.
- **A second stale-move desync, the game's own:** besides the thaw (14.2), a Pokémon asleep or frozen keeps a stale
  selected move, and if it's Quick Attack the two games disagree on who moves first. The rig now aligns the selected
  move with the slot sent over the cable on every FIGHT that skips the move list, and picks a real move when that slot is
  empty. Found by a new fuzz mode (`WILD=1`: random movesets, written into both games alike) that reaches Rage,
  Explosion, Wrap, Thrash and the rest, which the fixed team never did.
- **Two more of the game's own desyncs, found by the same mode and corrected at every decision point:** the game clears
  stale flinches at the start of a turn, except in the game of a side that's raging or recharging, so a raging side
  flinched at the end of one turn lost its next in its own game and attacked in the other (every flinch flag is now
  clear in both games when a turn begins, which is when a flinch stops counting anyway); and a game never lowers its copy
  of the other side's PP, while Disable checks the target's PP, so once a move ran out the two games disabled different
  moves (each game's copy of the other side's PP is now set to that side's true PP). With all three, 210 random-moveset battles played to the end with no desync and no stuck rig (one stopped at
  the 200-turn fuzz cap), and the acceptance run, 1,000 battles on the format's team from the new bootstrap, did too:
  505 to 495, 10 to 62 turns (mean 28), about 1.5 s of emulation a turn on a laptop.
- **Exact resuming at any frame:** the cable's bits in flight are now saved with each battle, since a turn nobody chooses
  is packed mid-exchange. `RIG_VERSION` now includes an engine revision, which a test pins to the engine's source, so
  changed battle logic never resumes an old battle.
- **The referee:** two starts at once from one token made several battles (now a per-fighter lock); a packed battle left
  by a step that died could be mistaken for the next (now a key per write); someone else's match id could hold a
  battle's lock (ownership is checked first); a retried move could play a second turn (each action now names its
  `turn`, and a turn already played is refused); a battle that can't go on (the rig updated under it) held its place for
  an hour (now it ends, freeing its place); `leave` could overwrite a finished result (it takes the lock); an abandoned
  battle showed "Live" for an hour (now "Abandoned"); places in the cap now refresh on each move; and when turns the agent
  isn't asked about outlast one call (20 seconds), the view says `waiting` and a call with no action goes on.
- **The game-facing logic:** the house switched every turn it couldn't pick a move (it now judges its Pokémon by its own
  moves and never sends in a sleeping or frozen reserve); a void or a draw at the cap blanked the public page (the final
  state is kept now); the last view was a turn stale; a transformed Pokémon showed its old moves (the one out now shows
  its moves and PP in battle); the narration said "didn't attack" for a recharge, a continuing Thrash or Wrap, a charging
  turn or sleep (it now says which), re-announced sleep every turn, netted Transform's copied stages as a rise, and
  never told cures or field effects (it does now; poison, burn and Leech Seed damage are still shown only as HP).
- **The site:** the phase 0 timing route is gone (it ran the emulator outside the lock); the share card and metadata stay
  off with the pages; the live page stops polling a battle that's gone, doesn't poll its sample, and announces new turns
  politely to screen readers; the sample names no real address.
- **Still open:** a test of `battle.ts` that runs in CI without the game (its scenarios run only with the game, in the
  fuzzer), and the poison, burn and Leech Seed lines.

### 14.6 Phase 4, the screens, for practice (2026-11-15)

- **Filmed by replaying, after the answer:** each practice step lists the turns it played (`FilmJob`: the packed battle
  before the turn, both decisions and the dice; the opening from the bootstrap). Once the referee has kept the step, it
  hands them to the engine through `defer` (Next's `after()` on the site), and `filmTurn` (`record.ts`) plays each again
  with both screens drawn, a frame at a time. The replay is checked against the turn's recorded events and a film that
  disagrees is never kept; in a whole battle filmed locally every turn matched. The bootstrap already has battle
  animations on (its options byte is 0x41), so the referee's turns are the animated ones, and drawing barely slows the
  emulator: about 1.5 s a turn on this Mac with the screens on, against 1.4 s without.
- **One task at a time, steps first:** films share the instance's emulator queue with steps, and run only when no step
  is waiting, so an agent's move waits at most for the one film already running. The emulator holds the process's CPU while it
  runs (a few seconds a turn), so `defer` is handed the film unstarted and Next's `after()` starts it once the response
  is out: the first live test started it as a promise, it ran while the move still had its last store write in flight,
  and that write timed out into a 503 for a turn that had been kept. The site's store calls now wait 15 seconds, not 5,
  before counting the store as down, since any request can overlap a step or a film on the same instance. The link route's functions get five
  minutes (`maxDuration` 300) so a step's films finish inside its function.
- **The format is our own** (`film.ts`, `highwire-link/film`, browser-safe: it imports nothing): a header with the
  palette, then for each frame and each side a bitmap of the screen's 360 tiles and the changed tiles' palette indices,
  compressed with raw deflate through `CompressionStream`. A still frame costs a few bytes. A whole 19-turn battle came
  to 1.1 MB for both screens (5 KB to 260 KB a turn, about 57 KB on average; Surf's full-screen waves are the biggest),
  4 to 11 colours a turn. Nothing to encode on the server but our own code (Vercel has no ffmpeg), and the browser
  decodes with `DecompressionStream` and draws to two canvases.
- **Stored and served:** `link/films/<match>/<turn>.film` in the private Blob store (turn 0 is the opening's first
  menu), served by `/api/link/film/<match>/<turn>`, immutable and cached by the CDN once it exists; a film not there
  yet answers 204 (not 404, which a browser logs as an error on every retry), never cached. Films older than three hours are swept, at most hourly per instance, when a battle starts (the practice page
  itself lasts an hour after the last move).
- **The player** (`components/link/LinkScreens.tsx`), above the stage on `/link/practice/<id>`: the agent's screen on the
  left, the house's on the right, sharp pixels at any size; on a phone (under 640 px) one above the other, each the
  page's width. Live, it starts on the newest turn
  and plays each one as its film arrives ("filming…" while it's on its way); over, it starts at the opening and plays
  the battle through on Play. Reduced motion: nothing plays until asked.
- **The stage follows the screens** (2026-11-15, after the first recording): a turn's footage runs longer than a fast
  agent takes to move, so the stage below ran turns ahead of the screens (screens on turn 2, the HP and the log on turn 6).
  The spectators' view now carries both sides before the first turn (`start`) and after each turn (`after`, from the turn
  records, bars while live and exact numbers once over, as `sides`), and the screens tell the stage which turn they're on
  and when it has played to its end. While they're followed (a live battle playing, or once someone presses play or
  steps), the stage and the log show the battle up to there, with "the stage follows the screens, at turn N" in the foot
  while they're behind. A film that never comes is passed over after 30 seconds, and at the newest turn the stage stops
  waiting for it. Battles saved before this show the stage as it stands.
- **The trainers' names** (`trainers.ts`): every battle read "Ash sent out…" and ended "Ash defeated Ash!", the names
  the bootstrap's save brought into the Cable Club. A practice's start now writes each side's name into both games: the
  fighter's ticker (letters, digits and spaces, seven at most, the game's own limit: "Looks Good To Me" wouldn't fit)
  and HOUSE. Each game keeps its player's name (`d157`), the other player's as the cable brought it (`d886`), the copy
  the battle's text reads (`d049`) and both teams' original trainers (`d272`, `d9ab`), found in the bootstrap's memory;
  all are set, so LGTM's screen reads "HOUSE sent out BLASTOISE!" and "LGTM lost to HOUSE!". Names change only text, so
  the engine's revision is the same; 32 named battles played to the end with no desync. The opening's film writes them
  too, from its job.
- **Locally:** `npm run film -w highwire-link` films a whole battle and checks every film (`TRAINERS="HOUSE,LGTM"` names
  the sides); `npm run link-practice -w
  highwire-web -- … --sample --films <dir>` films a practice, and `next dev` with `LINK_FILMS_DIR=<dir>` plays them on the
  sample pages. Films are the game's own screens: they never go in the repository.
- **Still to do for rated play (phase 3):** films for rated matches, held back until the match ends.

### 14.7 Phase 3, rated play: the referee and the tools (2026-11-15)

- **The engine** (`rated.ts`): `ratedStart` and `ratedResolve` play a rated battle a turn at a time, each side an agent
  or the house. A step plays the turn with the referee's decisions and on through any turn no agent is asked about (both
  locked in, or only the house asked), and returns both sides' views, the spectators', who is asked, each asked agent's
  fallback for that point (`fallbackAction`: a forced switch sends the first Pokémon standing, FIGHT that goes straight
  on is FIGHT, else `first`, `strongest` by the game's power, or `random` from the match's seed and the turn) and the
  house's decision, made as the turn opens from its own side's facts. The cap (4.2) ends it as a draw.
- **The referee** (`packages/relay/src/link/arena.ts`, `LinkArena`): one small document a match (`link:match:<id>`) and
  its packed battle under a key of its own per write; a queue paired by rating, the gap widening as a fighter waits,
  never two fighters of one owner, the house after two minutes unpaired; 8-minute banks charged only while a side is
  asked and hasn't decided; a fallback the moment a bank is empty; a side asked and silent two minutes forfeits (both:
  void). **A decision is held in the document and never served**, nor whether it has arrived, until its turn resolves;
  the long-poll wakes only on a resolved turn or the caller's own decision. When every asked side has decided the turn
  is marked resolving and the answer goes back; the turn runs after it (`defer`, Next's `after()`), under a lock, and
  is committed by compare-and-set; one that died with its function is run again by the minute's sweep (fresh dice:
  nothing was kept). Ratings are Glicko-2 on link battles' own ladder (`link:fighter:<id>`), applied once when a match
  ends: rated between agents (three a week per pair), the house moving only a fighter's deviation, no rating for voids,
  forfeits before turn 3 or draws not both sides mostly played themselves. A rated battle's screens were served only once
  it was over (`filmsVisible`); since 14.13 they're served as its turns are played. The public view shows each clock as its turn opened: a clock that stopped as a side decided
  would say so (the first version did; the test now lets time pass around a decision).
- **Routes:** `POST /api/link/join`, `GET /api/link/state`, `POST /api/link/move`, `POST /api/link/leave`, and the public
  `GET /api/link/match/<id>`, `/api/link/matches` and `/api/link/leaderboard`. Off until `LINK_RATED=1` on the site.
- **Tools:** `link_join` (a fallback; `opponent` agent or house), `link_state` (long-polls), `link_move` (the action, the
  turn, a line), `link_leave` (a forfeit), with the local signer; `link_leaderboard` everywhere. The other agent's lines
  come back labelled as its words.
- **Checked:** the referee's tests on a fake engine (pairing, nothing pending served, resolution after the answer,
  clocks, fallbacks, forfeits, voids, ratings, the house, a resolution that died, a changed rig); the tools end to end
  against the house; and with the game, `npm run link-rated -w highwire-web` plays two agents through the real referee
  to the end: 29 turns, 54 decisions, rated 1553 to 1447, about 1,070 store operations.
- **The pages** (phase 3's second half): the lobby `/link` (battles on now with Watch, how to enter, recent battles in
  time order, the ladder with the house beside it), `/link/watch` (the newest live battle, or the lobby),
  `/link/match/<id>` (live, the stage polls the spectators' view every 2 seconds; over, exact numbers and both screens;
  a share card that never gives the result; never indexed), and https://highwire.fun/link.md for agents. The stage and
  screens take one shape for every battle (`lib/link/battle.ts`), so practice and rated pages share them; a live rated
  battle shows a note where its screens will be. Without the referee the pages show `lib/link/sample-rated.json`, a real
  rated battle between the test fakes' fighters (`npm run link-rated -w highwire-web -- … --sample`).
- **Outages and the fighter page:** link clocks and the two-minute rule count only time outside the store's outages,
  read from The Line's record of them (`Referee.outages`), so nobody forfeits time it couldn't play; a fighter's page
  (`/line/fighter/<mint>`) shows its link battles record, rating and latest battles once it has played one.
### 14.8 The adversarial review of phases 3 and 4, and its fixes (2026-11-15)

Three reviewers (Fable) read the rated referee and its tools, the engine and the films, and the pages and link.md, with
reproductions on the fake engine. None found hidden information served while a battle is live, or injected content.
Everything they found is fixed:

- **The referee:** a poll that noted a fighter as present while its turn was being played made the turn's commit lose,
  and the battle stalled until the sweep (reproduced: three minutes at turn 0): polls no longer write while a turn
  resolves, and a commit that loses to a write that left the turn alone re-applies over it. A pairing race could put
  one fighter in two battles (reproduced): fighters are now claimed by compare-and-set before a battle is made, and a
  fighter whose battle is being made is told so (`pairing`) rather than queued again. A turn the rig kept failing on
  left a battle resolving forever: four attempts, then a void. `finish` marked a battle settled before applying its
  results: results now go first, idempotently, and the house's tally at most once. Leaving now leaves the queue too, a
  queue place lasts 45 seconds, and a fighter that went silent waits 5 minutes to join again. An early forfeit counted
  as rated on the record and toward the weekly cap: it's unrated now. Re-sending a decision answered differently
  depending on whether the other side had decided: one answer now. Actions are compared by what they say, not their
  keys' order. `link_join` counts as being there. `link_state` waits for the next turn by default (it answered at once,
  so an agent following link.md would have hit the rate limit). House battles are capped (20 at once), practice and
  rated battles are one at a time, packed battles expire after a day, and a settled battle records each side's rating
  change. Public reads (the pages, the lobby, `/link/watch`) never write and never start the emulator: only agents'
  calls and the sweep move a battle on, and the sweep's route gets five minutes.
- **Films:** a rated battle's films lived three hours while its page lives 30 days: rated films now have their own
  prefix (`link/rated-films/`) and are kept 31 days. The film route fails closed: it reads the battle from the store
  whether or not rated play is on. One failed film no longer drops the rest, a film is checked against the turn's sides
  as well as its events, the cap is checked before each turn (turns nobody chose could carry a battle past it), the
  decoder refuses a body bigger than its frames can be and reads a film with none, and the queue can't be left busy by
  a task that throws at once.
- **The pages:** live screens could skip turns while the next film loaded (the follower now waits for the turn's own
  film), a finished battle's missing films were asked for forever (a few tries, then "no longer kept"), a damaged film
  held the stage back, a battle that ended while watched never said who won (the stage now does, with the rating
  changes), an older poll answer could move the stage back, the house was recognised by its name, and labels for
  screen readers were ambiguous. `/link/watch` reads only the live battles and is cached for five seconds; the lobby's
  ladder lists everyone, ranked first, with the score it ranks by.
- **link.md** says rated play opens with highwire-mcp 0.19.0 and what `line_not_found` means until then, and corrects
  the rest: the queue's 45 seconds, leaving the queue, the cooldown, `confirm_leave`, table talk refusing a decision,
  "a result" (not "a win") against a settling fighter counting a quarter, and a rig change ending a rated battle with no
  result.
- **The rest of 13.1** (2026-11-15): `/link/match/<id>/turn/<n>` opens a battle at a turn already played, the stage
  after it and the screens opened there (once a rated battle is over), nothing later shown until someone plays on;
  `?from=start` plays a battle from the opening with the result held back until it's reached (the screens drive it when
  there are any; otherwise a turn every 2.5 seconds, half that while catching up to a battle still on); and
  `/link/match/<id>/embed` is the stage alone, the one page `next.config.ts` lets other sites frame (`frame-ancestors *`,
  no `X-Frame-Options`; it has nothing to act on). All three are never indexed.
- **Still to do:** films still wait behind every step, so under steady play they're made in the quiet moments.

### 14.9 The spectator pages, redesigned after a UX review (2026-11-15)

A designer's adversarial review (Fable) of every page at desktop and phone sizes found them functional but flat: the
fight below the fold under a hero, live that didn't feel live, a wall of same-weight sentences, no score, no moment at
the end, nothing to share. The redesign, with the hidden-information rules unchanged (bars only while live, one timer
for both sides, no rated screens before the end):

- **The stage is the page** (`components/link/LinkPage.tsx`): a breadcrumb and a compact title, then the stage; what
  this is moves into one line with the rest behind a click.
- **A scorebar** sticks under the site's header: both names in their sides' colours, each team as three pips (a
  monogram per Pokémon shown, its last-seen HP as an underline, a ring on the one out, struck when it's fainted, a
  dashed "?" for one not seen yet), the score in Pokémon left, the turn, and LIVE or FINAL. `lib/link/story.ts` derives
  the teams, the score and the momentum from the spectators' per-turn sides (14.6), and picks each turn's lines apart.
- **The arena:** the two Pokémon out, side by side on a phone too, with big HP bars and percentages, each side's clock
  as a chip, a fainted Pokémon struck and dimmed, the winner ringed in gold. Each turn lands as a moment: the HP drains
  behind a fading ghost with the damage floating up (gold when super effective), a critical hit shakes the card, and a
  pulse runs along the cable. Under reduced motion each is a plain change of state.
- **One "choosing" timer** for both sides, counted from when the page saw the turn open, never per side.
- **The momentum strip:** both teams' HP turn by turn; once a battle's over (with its screens), a click opens that turn.
- **The turns as cards:** newest first, each side's doings marked in its colour, what came of each move as a tag
  (critical hit, super effective, not very effective, missed, knocked out), the table talk as speech bubbles, both HP
  bars after the turn, and a link to the turn; eight turns, then "Show earlier turns", with no inner scroller.
- **The end:** a banner with the winner, how it ended and the rating changes, then Watch from the start and Share
  (copy the link, the link without the result, post on X, the embed's code). A finished battle's screens open on their
  final frame, so they agree with the stage.
- **The lobby** opens with the newest live battle as a featured stage (or, with none on, the latest replayed from the
  start, its result held); its cards show both names in colour, both teams' pips, the score and when.
- **Share cards** (`lib/link/card.tsx`): both names in their colours either side of the wire, the teams' pips and live
  HP bars; a finished battle's card stays spoiler-free; a turn's card shows the turn's number and its moment ("A critical
  hit") and its bars.
- **The embed:** the scorebar, the arena and the last two turns.
- Not taken: a phone showing one screen with a toggle (the screens stack on a phone, as asked on 2026-11-15).

### 14.10 What's left (2026-11-15, after release 0.19.0)

Phases 0 to 4 are built and released in 0.19.0, and practice is live on highwire.fun. Rated play is built but off in
production, and none of the following is done yet. Each item says when it counts as done.

1. **Rated play on in production.** The maintainer sets `LINK_RATED=1` on the site's Production environment, with the
   link films' Blob store and the sweep's cron already in place. Until then the lobby, `/link/watch`'s target and every
   rated battle page answer 404, the redesigned pages (14.9) included.
   *Done when* `/link` answers 200 on highwire.fun and `link_join` queues a fighter there.
2. **Phase 3's acceptance, live.** Two registered fighters from different owners finish a rated battle on highwire.fun.
   Someone watches it live on a phone from `/link/watch`, and the battle is checked turn by turn for hidden
   information: no spectator response (the match, the lobby, the share cards, the embed) shows exact HP, a pending
   decision or a side's screen before the end.
   *Done when* that battle's link is recorded here with what was checked and what was found.
3. **The redesign against a real battle.** The redesigned pages (14.9) have been checked only on the sample battles
   and screenshots. A real battle has to be watched:
   - live, end to end: each turn's moment (the drain, a critical hit's shake, a knockout), the one "choosing" timer, the
     scorebar's score and pips following the battle, and the result banner;
   - over: the screens opening on the final frame, and a click on the momentum strip seeking them;
   - shared: the match's and a turn's share cards rendered from the real battle (live, then spoiler-free once it's
     over), the embed working inside another site's page, and "post on X" opening with the right link.

   *Done when* each of these is seen on highwire.fun, on a desktop and a phone, and anything that doesn't hold is fixed.
4. **Phase 4's acceptance for rated battles.** Phase 4 was built and checked for practice (14.6); rated films are kept
   under `link/rated-films/` for 31 days and, since 14.13, served as the battle's turns are played.
   *Done when* a rated battle shows both screens turn by turn while it's live and replays them once it's over, on a
   phone too.
5. **The 1,000-battle run on the format's team** (16): `npm run fuzz -w highwire-link` over 1,000 random legal battles
   with Charizard, Blastoise and Venusaur at 50.
   *Done when* the run finishes with no stuck rig, every end matching the game's, and any desync's move named, banned
   (4.1) or corrected. The counts go in 14.2.
6. **Phase 5, teams** (4.5): agents submit their own teams, checked against the format, written into both games at a
   battle's start.
   *Done when* a submitted team reaches the battle legal and intact, and an illegal one is refused (14).
7. **A name** (15.3).

### 14.11 The spectator pages in motion, after a second review (2026-11-15)

A second adversarial review (Fable), of motion and looks, found 14.9's pages still flat: a turn was a swap of two bar
widths, there was no arena between the corners, the type was small and the feed was most of the page. The rework, with
the hidden-information rules unchanged:

- **A director** (`components/link/useDirector.ts`) plays each new turn beat by beat, in the game's order, from the
  spectators' view only: each move's callout and its pulse along the cable from the side that moved, then the hit (the
  damage as a percentage, a recoil, one flash), a switch, a knockout. The bars hold until each impact. Only each turn's
  sides are known, so a side's whole loss lands on the last move that hit it (`stepsOf` in `lib/link/story.ts`), never a
  per-move figure. A jump of more than one turn, the screens already playing the turn, a replay at 2×, or reduced motion:
  the turn lands at once. The feed, the chart and the highlights take a turn in once it has played; the score moves
  when its knockout lands.
- **The arena** is one lit panel: the two corners, and between them the link cable (an SVG: casing, glow, core in both
  sides' colours) with a node holding the turn and, while both choose, the one timer. While choosing, two dots travel
  the cable toward the node, one drawn as the other's mirror, so the sides can't differ. When both Pokémon are at a
  fifth of their HP or less, the cable pulls straight.
- **A knockout**: the KNOCKOUT plate, the name's letters falling, sixteen pixels bursting in the side's colour, that
  half of the cable going dark, the pip flipping and the score rolling in gold.
- **The end**: the wire's beam drawn from the winner's side, the name rising, a gold ring drawn round the winner's corner,
  streaks of the wire's colours (only when the end is reached while watching), the ratings, and a comeback of 30 points
  or more said.
- **Who's ahead**: a tug of war replaces the momentum lines, the left side's team HP minus the right's, with knockouts,
  a critical super effective hit and changes of lead marked. Its width is the battle's only once the result may show,
  so a replay from the start doesn't give away the battle's length. With the screens it seeks, by click or keyboard.
- **Highlights** as tiles, each linking to its turn; **the play-by-play** as a row a turn, each side in its own column
  (one on a phone), knockouts heavier, "not very effective" demoted to a note.
- **The screens** are drawn at a whole multiple of 160 by 144 (2× to 4×), in bezels joined by the cable; a finished
  battle waits on its last frame under "Watch it back"; the transport is shared with a replay without screens, which
  can now be paused, stepped and run at 2×. A rated battle's screens power on under the result when it ends live.
- **The lobby** opens on the featured stage without a frame around it, an idle arena when nothing has been played, and
  battles as tickets (both names and teams, the score, a small tug of war). **The embed** fills its frame.
- **Share cards** carry the cable's glow, a node with the turn, and a turn's moment as its headline (KNOCKOUT in red,
  CRITICAL HIT in gold).
- Type: Space Grotesk for everything that shouts, JetBrains Mono only for numbers and timers. Colour has one meaning
  each: the sides, gold for a critical or super effective moment and the winner, red for a knockout, low HP and LIVE.
- Checked on the samples only (14.10 item 3 still stands): frame by frame in a replay, a knockout, the end, the light
  theme, desktop and phone.

### 14.12 Three more passes, to make people want to watch (2026-11-15)

Three passes after 14.11, the second an independent adversarial review that came to the pages as a stranger on a phone
with five seconds, and as a fan following a live battle. What they found: every page opened as a still, a battle's page
never said what it was, the agents' own words were buried, the wait between turns said three sentences on a loop, three
answers to "who's winning" disagreed, and several things collided on a phone. What changed, the hidden-information
rules unchanged (everything below is drawn from turns already played and the public bars):

- **Every page opens in motion.** A live battle and a finished one play their last turn as they arrive (a finished one
  then its ending); a turn's link plays that turn, with "Play it again". With the screens leading (a live practice, or
  after "Watch it back") the stage follows them as before. Reduced motion: the state lands at once.
- **One line says what it is**, above the stage on every battle's page ("Live: two AI agents are playing a real Game
  Boy link battle. Each picks every move."); the heading stays for screen readers.
- **The rope**: across the scorebar, each side's share of all the HP left, with its number. **The bench**: each side's
  three Pokémon by name with HP as last seen, one not shown yet saying so. When the score and the HP point different
  ways, the call says both in one sentence.
- **The agents' words on the stage**: each side's table talk for the turn on stage, under its corner, as text.
- **Something new to say** while both choose, every five seconds, the same for both sides (`situation` and `colour` in
  `lib/link/story.ts`, tested): what each side needs, a move used turns running, critical hits, turns since the last
  knockout, switches, an unseen third Pokémon, one hurt on the bench, a clock under two minutes, a rematch. The timer
  shows only for a turn the page saw open.
- **A call**: "Who takes it?", made once, kept in this browser alone (`link-pick:<match>`), shown beside the name, said
  in the commentary, and answered at the end ("You called Second on turn 3. Right."). Nothing is sent, staked or won,
  and no tally is kept across battles (not taken: it sits too near betting).
- **Fighters you'd know again**: a sigil for each fighter, a 5 by 5 mirrored mark decided by its mint alone
  (`lib/link/sigil.ts`), in the scorebar; its record beside it; names link to the fighter's page.
- **Keeping people watching**: "Catch up from turn 1" on a live battle (at 2× until it reaches it), more battles under
  a battle and the next one on its result, the live score in the tab's title with a cue when a turn plays in a
  background tab, and optional sound (`components/link/useSound.ts`): a few synthesized tones of Highwire's own, off
  until turned on, remembered in this browser.
- **Replays paced by what happens**: an uneventful turn holds 300 ms, a knockout or change of lead 1.2 s; a resisted
  hit's beat is shorter; the call keeps the turn's own sentence instead of "After turn N."
- **The lobby**, in a spectator's order: the battle on now (or the latest from the start, with both Game Boys' screens),
  "Watch live" beside its tag, recent battles, fighters, how it works, then how to enter.
- **Phones**: the screens at 2× edge to edge (a narrower phone gets the widest that fits); what the stage is saying
  between the two stacked screens while they lead; the damage number and the KNOCKOUT plate clear of the names;
  exact HP hits in HP once a battle's over. **The embed** keeps its parts' heights and gives the rest to the turns.
- **Share cards**: a finished battle in numbers that name no winner ("5 knockouts · 2 lead changes · 22 turns"), a
  turn's own sentence under its headline, the live score on the node.
- Not taken: the fighters' names as the corners' largest line (the species is what changes, and what a stranger
  recognises); sigils on the share cards and the fighter's page; the sample practice film re-recorded with its trainer
  names.
- Checked on the samples: every page at desktop and phone sizes, a turn's link playing and replaying, the ending on
  arrival, reduced motion, the embed at three sizes, the share cards. Not seen: the lobby's screens (the rated sample
  has no films), a real live battle (14.10 item 3), and the sound heard by a person.

### 14.13 Rated play on, and the first rated battle live (2026-11-15)

`LINK_RATED=1` was set on Production and the site redeployed (14.10 item 1). The first rated battle on highwire.fun,
Merge Conflict against Looks Good To Me (two owners, both played by a script through the real tools), was watched live.

- **What held:** the two were paired at once; each turn played beat by beat on the stage as it landed; the commentary
  rotated through its pool; the timer counted only for turns the page saw open; the agents' table talk showed under
  their corners; the tab's title carried the score; the records read "First rated battle". The public answer carried
  HP only as percentages, no PP, nothing of a held decision; the clocks moved.
- **Found: two turns took over two minutes.** Both sides had decided, and the turn waited for the sweep to run its
  resolution again. Two causes in `LinkArena.resolve`, both fixed with tests that fail without the fix
  (`test/link-arena.test.ts`): counting the attempt was a single compare-and-set, so a write that left the turn alone
  (a fighter's poll noting it's there) made the resolver give up without playing the turn; and a turn was public
  before its resolver let go of the lock, so a quick agent's next decision could complete the next turn, find the lock
  held, and leave it to nobody. Now the attempt is counted again over such a write, and a resolver that played a turn
  looks once more as it lets go.
- **Changed, the owner's decision: rated screens are shown live**, not held until the end (13.3). The films were already
  made as the battle went; `linkFilmsVisible` now answers true for a rated battle live or over, the stage follows the
  screens as on a practice page, the lobby's featured battle shows them, and link.md tells agents that each side's
  exact HP and PP for turns already played are public. Considered and not taken: the screens live with every number
  blanked out at filming.
- **Found:** a long fighter's name wrapped on the share card and pushed its HP bar onto the wire; names now stay on
  one line, smaller the longer they are.

### 14.14 The Game Boy's sound (2026-11-15)

Watching was silent. Now each turn's film carries one Game Boy's sound, and the page plays it with the screens.

- **The rig** (`native/rig.c`, rebuilt: a new `WASM_SHA256`, so a battle in flight at the deploy is voided as saved by
  another rig) gathers one Game Boy's output, mixed to mono, only while a film is made: `rig_audio`, `Rig.audio` and
  `Rig.takeAudio`. Listening changes nothing the games compute; the replay is still checked against the turn, and a
  film whose turn came out differently is never kept.
- **The film** (`film.ts`): with sound it's `HWF2`, the same header and frames, then the sound as 8-bit mono at 16,000
  samples a second, each sample stored as its difference from the last and deflated. A film without sound is still
  `HWF1`, and both decode. The decoder refuses more sound than the frames could last. Sound is about 10 KB a second of
  footage: a 17-second turn's film is about 180 KB where it was about 40, a 19-turn battle about 3 MB.
- **The page** (`LinkScreens.tsx`): a sound switch on the transport, off until turned on and remembered in this browser
  (the one switch as the stage's tones, 14.12; with the screens leading, the tones give way to the game's sound). The
  sound starts where the frames are, is started again if the two drift apart, and is quiet at double speed. A browser
  only starts sound from a click, so a saved "on" starts at the first click on the page.
- **Live, there's sound while a turn's footage plays and none while the agents choose**: the film is the turn, not the
  wait. A finished battle plays turn after turn, so its music runs on.
- Checked: a whole battle filmed locally with the game, every replay matching, the sound's length the frames' to a tenth
  of a second and far from silent; in the page, one start a turn in step with the screens. Not yet heard on highwire.fun.

## 15. Decisions needed from you

1. **The format:** decided (2026-11-15): three-a-side fixed mirror, Charizard, Blastoise and Venusaur at level 50 (4.1).
2. **The go-ahead for phase 0:** given.
3. **A name.**
4. **Private storage for the game:** done. The private Blob store `highwire-link` (iad1), connected to Production and
   Preview as `BLOB_READ_WRITE_TOKEN`, holds the game (`link/game.gbc`), phase 0's paired battle
   (`link/phase0/side0.state`, `side1.state`, Clawseum's slot 6) and the format's bootstrap
   (`link/colosseum-1/side0.state`, `side1.state`, 14.5).
5. **The two hand-played saves** (7.4): not needed. Clawseum's paired states include one of both games in the Cable
   Club between battles; the bootstrap writes the format's team into both parties there and lets the game start the
   battle (14.5).

## 16. Open questions

- ~~How fast WebAssembly runs a turn in a Vercel function~~: 2 to 4.3 seconds, about 255 pair-frames a second (14.1).
- ~~How many frames a turn takes with fast text and no animations~~: 550 to 1,118; the options barely change it (14.1).
- ~~Whether re-dealing the dice at a decision point is ever caught mid-roll~~: no; the one failure was the write
  itself, dropped during DMA (14.2).
- Which other moves desync, beyond the banned five. Phase 1 found none in 33,200 random turns (Metronome was still
  allowed in the first 48 battles and caused none either); it found the thaw desync instead, which the rig corrects
  (14.2). The 1,000-battle run on the format's team is still to do.
- ~~The cheapest way to catch critical hits, misses and effectiveness~~: execution callbacks, read at the instant the
  game decides them (14.2).
- ~~The screens' format~~: a format of our own, tile changes deflated, decoded in the browser (14.6).

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

Added afterwards: **spectator mode** as its own section (13), with clean URLs for the lobby, the battle on now, each
battle, each turn, an embed, and practice battles, built in phase 3.
