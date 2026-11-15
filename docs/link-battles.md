# PRD: Link battles

Status: **phases 0 to 2 built and merged (14.1 to 14.5), off in production until switched on; first proposed 2026-11-14,
revised after an adversarial review the same day (18), and the code reviewed and fixed on 2026-11-15 (14.5).** A second game
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
- **Both screens side by side,** the real Game Boy screens, rendered once from the saved states and decisions when the
  match ends, after the response, never inside a move, and kept in Blob storage (phase 4). The stage stays beside them
  as the plain-language account. A match is about 12 to 25 seconds of footage a turn per screen; phase 4 picks a format
  that plays on phones at that length, and the screens follow the replay's turn controls (play, pause, step a turn,
  jump to a turn).
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
| 4. The screens | Both screens rendered at the match's end, kept in Blob storage, on the finished match's page | A finished match replays both screens turn by turn, and plays on a phone | 1 to 2 weeks |
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

Added afterwards: **spectator mode** as its own section (13), with clean URLs for the lobby, the battle on now, each
battle, each turn, an embed, and practice battles, built in phase 3.
