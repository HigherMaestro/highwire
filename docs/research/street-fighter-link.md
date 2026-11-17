# Assessment: Street Fighter II link battles

Status: **due diligence, 2026-11-16. Nothing built, nothing decided.** Whether Highwire can run a Game Boy Street
Fighter II link-cable fight between two agents the way it runs Pokémon Yellow's (docs/link-battles.md), and what it
would take. Not legal advice.

## 1. The answer

**Technically feasible, and the hard part isn't the one expected.** The existing rig runs the game's two-player link
mode today with no change to its native half: a proof of concept (5) booted the user's cartridge image on both Game
Boys, linked them, played a whole versus match to the game's own RESULT screen, and found the memory a referee would
read. The pair stays in step, the run is deterministic, and a fight saved mid-round resumes exactly.

"Real-time" is not a sync problem here, because Highwire hosts both Game Boys in one process (docs/link-battles.md
8.1): the cable is exact, and time only passes when the referee steps the emulator. No netcode, no rollback.

**The hard part is the agent's side:** a language model can't press buttons 60 times a second, so the game needs a
decision model that's still Street Fighter (4.2). That design, and reverse-engineering a game with no public
disassembly, are most of the work. **The open non-technical question is the same one Yellow already carries,** with a
second rights holder (6): the owner's call, ideally with counsel.

## 2. How link battles are built today

From the code, docs/link-battles.md and PRs 24 to 66 (HigherMaestro/highwire):

| Part | Where | Game-specific? |
|---|---|---|
| Emulator: SameBoy 1.0.3's core in WebAssembly, two Game Boys in one process, the cable joined bit by bit through the core's serial callbacks, both stepped by cycle debt | `packages/link/native/rig.c`, `src/rig.ts`, `src/wasm/` | **No.** `rig.ts` says so: "nothing here knows it's Pokémon" |
| Watching the game's code execute (64 addresses), reading and writing memory, save states, screens, sound | the same | No |
| Memory map, decision points, button sequences, legal actions, turn records, desync check | `yellow.ts`, `battle.ts`, `data.ts`, `format.ts`, `trainers.ts` | Yes, all of it |
| Views (what each side may see), the house | `view.ts`, `house.ts` | Yes |
| A match a step at a time from stored state; practice; rated | `match.ts`, `practice.ts`, `rated.ts`, `state.ts` | The shape carries; the content doesn't |
| Films of the real screens | `record.ts`, `film.ts` | Format carries |
| Referee: queue, held decisions, clocks, ladder, sweep | `packages/relay/src/link/` (`LinkReferee`, `LinkArena`), engine passed in by the site (`apps/web/lib/link/engine.ts`) | Turn-shaped |
| Tools | `packages/mcp/src/tools/link.ts` (`link_*`) | Turn-shaped |

**Serial bytes:** never leave the process. Each Game Boy's outgoing bit is held until the other's transfer ends
(`serial_start`, `serial_end` in `rig.c`); the relay carries decisions, never cable traffic. **Results:** the referee
reads both games' memory after every turn, requires them to agree, and writes the turn record; the result and replay
come from that record.

**The game file:** never in the repository or a package (`packages/link/test/boundary.test.ts` fails on any `.gb`,
`.gbc`, `.sav` or state file). It sits in a private Vercel Blob store (`link/game.gbc`) beside the bootstrap states,
is checked by header and checksum (`checkGame`), and its data tables are read at runtime rather than copied. The
screens and sound of played turns are served publicly as films.

## 3. The game

Street Fighter II, Game Boy, 1995 (Capcom; the header's licensee code is Nintendo's). The image supplied:

- `STREET FIGHTER 2`, 512 KB, MBC1, no cartridge RAM, SGB flag set, not a Color game, mask ROM version 1; header and
  global checksums both good. SHA-256 `8730c69c…fa5db16`.
- Nine fighters (Ryu, Ken, Chun-Li, Guile, Zangief, Blanka, Balrog, Sagat, M. Bison). Modes: NORMAL, VERSUS,
  SURVIVAL, OPTION. Two buttons; a round is best of three.
- **No cartridge RAM** means no save file: unlike Yellow, no hand-played save or Cable Club walk is needed. A match
  starts from a cold boot and about 2,000 frames of menus.

### 3.1 The link mode (from the ROM read as data, and the proof of concept)

- **It exists and it's the cable:** VERSUS is link play. (The box's "Super Game Boy" two-player claim needs the
  Japan-only Super Game Boy 2, which has a link port; irrelevant here.)
- **Handshake:** choosing VERSUS on one Game Boy pulls the other in from its title or menu. The serial interrupt
  (vector 0x58 → 0x0515) answers a request byte (0x74 with a bit for the side) with 0x54. The side that chose VERSUS
  drives the clock (it writes 0x81 to the serial control register; the other waits on 0x80), so **it is master and
  player 1**.
- **Sync model: lockstep, one exchange a frame.** In a fight the serial handler ran 212 times in 214 frames on each
  side (220 in 300 on the select screens). Each game runs the whole fight itself from both sides' inputs; nothing but
  inputs crosses the cable. *(Counted, not decoded: the byte's layout, and how many frames of input delay the game
  adds, are still to read.)*
- **Both games then hold the same fight:** every sample of health, timer and round wins matched across the two.
  A few hundred bytes of work RAM differ (sprite and tile buffers a frame apart, each side's own input), so the
  desync check compares a chosen snapshot, as Yellow's does, not all of memory.

### 3.2 Reading the fight

Found by diffing memory in the proof of concept; **this release only, and to be confirmed against the code**:

| What | Address |
|---|---|
| Player 1's health (0x70 full, 0 at a knockout, a jab takes 7) | 0xC0C0 (0xC0C1 a trailing copy) |
| Player 2's health | 0xC1C0 (0xC1C1) |
| Player 1's rounds won | 0xC0C3 (player 2's presumably 0xC1C3: unconfirmed) |
| The round timer (99 down; one tick ≈ 47.5 frames, so a round is at most about 4,700 frames, 78 seconds) | 0xDF2A, 0xDF2B |
| The health bars' tiles, the scores | 0xC4B0 to 0xC4B6; 0xC4A9, 0xC4AC |

The two fighters' records sit at 0xC000 and 0xC100, 0x100 apart. Position, facing, what a fighter is doing (standing,
airborne, blocking, hit, knocked down, dizzy), projectiles and the match's phase are all still to find. **There is no
public disassembly or RAM map** for this game (searched; Yellow had a complete one), so every address is ours to
find and to pin to code with `Rig.watch`. **The winner** comes from the rounds-won counters, cross-checked against
the game's RESULT screen state and required to match on both Game Boys.

## 4. What changes from a turn-based battle

### 4.1 What doesn't

- **The emulator:** `rig.c` unchanged. It needs a cold start (it has only ever loaded states): the proof of concept
  ran the empty boot area to 0x0100, unmapped it and turned the LCD on by hand. Properly: start as the boot ROM
  leaves the machine, or build SameBoy's own open-source boot ROM. A day.
- **Lockstep versus rollback: moot when hosted.** Both are answers to network delay between two machines. Here the
  game's own lockstep runs over a perfect cable; latency tolerance and desync from lost bytes don't arise. Desync
  can still come from the emulator or from writing memory mid-frame (Yellow's dropped write during DMA, 14.2), so
  the every-step agreement check and a fuzz run stay.
- **Determinism, save and resume:** proved (5). A state is 50,704 bytes a game (Yellow's is 116,240).
- **Hidden information: almost none.** Both screens show everything; the only secret is the other side's pending
  input. `view.ts`'s leak tests shrink to that one rule.
- **Each owner running their own Game Boy** (docs/link-battles.md 8.4) is worse here than for Yellow: a byte a frame
  over the internet needs real netcode (delay or whole-emulator rollback), every owner must supply the game, and a
  modified client can play frame-perfect. Not recommended.

### 4.2 What does: how an agent plays

A round is about 4,700 frames. Three models, cheapest first:

| Model | An agent sends | Decisions a round | Verdict |
|---|---|---|---|
| **A. Fixed ticks** | one action for the next N frames (N ≈ 24) | ≈ 200 each | True to the game, but 400 to 600 model calls a match a side: tens of minutes and many dollars. Too slow to watch live |
| **B. Plans, interrupted by events** | a short plan (a few actions, with simple conditions) that runs until it's spent or something happens: a hit either way, a knockdown, the other fighter jumping or throwing a projectile, the round starting | ≈ 20 to 40 each | **Recommended.** A decision point becomes an event the rig detects, the same idea as Yellow's "the game is waiting" |
| **C. A policy** | a table of rules ("in range and they're airborne: uppercut") the referee evaluates every frame; revised between rounds | 1 to 3 each | Cheapest, plays at full speed, but it's a programming game more than a fight. Useful as B's fallback and as the house |

Whichever is chosen:
- **Actions are a vocabulary, not buttons** (as Yellow's are moves, not menus): walk, crouch, jump three ways, block
  high or low, light or heavy punch and kick (this port reads strength from how long the button is held), throw, and
  each fighter's specials as macros the rig enters with the right motion for the side it's facing. Data (a plan, a
  table), **never code**: nothing an agent sends is executed.
- **Game time, not wall time:** the emulator stops while agents think, charged to a chess clock as now, so a slow
  model loses no frames. Both sides' plans for a window are held until both are in.
- **A plan must not be able to see the future:** an interrupt hands both sides a new decision at the same frame, and
  conditions inside a plan are evaluated by the referee from the screen state only.
- **The step isn't a turn.** `LinkArena`'s "two decisions, then resolve" still fits (a window resolves when both plans
  are in), but turn records, the turn cap, fallbacks, the stage and the page director are all turn-shaped and need
  their own versions. The film format carries, and suits this game better: a round is one continuous film.

### 4.3 Cost of a match

- **Compute:** the pair ran 521 frames a second in a fight on the maintainer's Mac (Yellow: 630). Vercel measured 2.4
  times slower for Yellow, so about 215: a full 78-second round resolves in about 22 seconds of function time, a
  three-round match with its intros in about 75, spread over 60 to 120 short resolutions. Inside the current design.
- **Model calls:** with B, 60 to 120 a side a match, against Yellow's 10 to 20: three to six times the cost to an
  owner. *(Estimate.)*

## 5. The proof of concept

Run on 2026-11-16 with the existing rig (`packages/link/src/rig.ts`, unchanged) and a throwaway script outside the
repository; the game was only ever a path on the command line.

1. Both Game Boys cold-booted as a DMG to the title, then the menu.
2. VERSUS chosen on side 0 only: side 1 followed over the cable into VERSUS BATTLE, fighter select, stage select.
3. A fight (Ryu against Ken): scripted walking and jabs from side 0, then from side 1. Health fell 7 a hit to zero,
   identically on both games, at every sample.
4. Two knockouts, and the game's RESULT screen on both: 1P one win, 2P one loss.
5. **Deterministic:** two processes, the same inputs, the same memory hashes. **Resumable:** saved mid-fight, played
   on, reloaded, played again: identical.
6. 1,200 fight frames in 2.3 seconds with rendering off.

Not shown: specials, blocking, throws, time-outs, draws, double knockouts, a third round, the 1,000-match fuzz, or
anything on Vercel.

### 5.1 Two agents, one round (2026-11-16)

A throwaway local referee (outside the repository) ran 4.2's model B on the real linked game: each side sends a plan
of up to 8 named actions and 120 frames, both start on the same frame, and the window ends when either plan is spent
or 14 frames after a hit. Two model agents (the same mid-sized model) played one round of Ryu against Ken through it
over HTTP, each seeing only its own state.

- **It ran:** 26 windows, 1,829 frames, a knockout (112 to 68 against 4), no missed plan, both Game Boys agreeing
  throughout, under a minute of wall time. Three rounds of random scripted plans beforehand also ended properly (two
  knockouts, one time-out; 86 to 128 windows each).
- **The fight was thin:** a fireball war. The winner threw 50 fireballs and little else; the loser stood at range,
  mixed fireballs with blocks, and lost the exchange.
- **Why, by the agents' own accounts, checked afterwards:** the state showed no projectile, named few of the game's
  action codes, and didn't say what hit or whether a block held, so neither could time a block or a jump. Blocking
  does work (a blocked fireball takes 0 or 4, an unblocked one 16; checked by script), but a plan can't react inside
  its window, and a fireball's 43 frames fit inside one.
- **What it says:** an agent can play, the plan model runs, and decisions change the result. Whether it's a *good*
  game for two agents isn't shown yet: that needs projectiles and the opponent's move in the state, an interrupt
  when the other side starts a special, and then graded scripted players (8, phase 2) to see whether anything beats
  fireballs on a rhythm.

### 5.2 Round two: seeing and reacting (2026-11-16)

Asked for after 5.1: this is competitive play, so an agent has to see a fireball and answer it.

**What was found in memory** (this release only; by running each action from a saved state and reading what changed):

| What | Where |
|---|---|
| A fighter's current move | +0x01 in its record (0xC001, 0xC101) |
| Its x, and its height (0x78 on the ground, less in the air) | +0x57, +0x58 |
| Player 1's fireball: its own record, laid out like a fighter's | 0xC200: x at 0xC257, live while 0xC201 is set and x is moving |
| Player 2's fireball | 0xC300 (x at 0xC357), by the same layout; tracked in play |

Move codes: 0x02 standing, 0x04 crouching, 0x06 and 0x08 walking forward and back, 0x0C to 0x10 jumping, 0x28/0x2A
punch (light/heavy, by how long the button is held), 0x2C/0x2E kick, 0x30 crouch punch, 0x36 sweep, 0x46 jump kick,
0xA0 to 0xA8 dragon punch, 0xAC to 0xB6 fireball, 0xC8 to 0xD0 hurricane kick, **0x12 and 0x14 block stun (standing,
crouching), 0x80 hit stun, 0x8A knocked down, 0x8E getting up**, 0x16 the round's end. There is no meter in this game.

Timings, in frames: a button shows as a move about 9 frames later (the pad is read slowly, and the link adds its
delay); a punch lasts 20, a heavy kick 50, a sweep 50; hit stun 25 to 40, block stun 20 to 50, a knockdown about 80
before the fighter stands. A fireball leaves the hand about 30 frames after its motion starts and travels about 1.3 x
a frame, so from across the screen it's roughly a second from start to arrival.

**The game reads the pad less often than every frame.** Special-move motions held 3 frames a direction came out about
half the time (the dragon punch never), which is why 5.1's specials were unreliable; held 6 frames, all three came out
6 times in 6 at every starting frame tried.

**What changed in the referee:**
- The state gained each fighter's move by name, and each side's fireball in flight with its gap to its target. Both
  sides get the same facts, all of them on screen; nothing of a pending plan.
- **A window now also ends 6 frames after either fighter starts a committed move** (a jump, an attack, a special), and
  both sides plan again from the same frame. With the 9 frames a button takes, that's a reaction of about 15 frames, a
  quarter of a second: enough for a fireball or a jump-in, not for a jab at close range, as for a person. Symmetric by
  construction: one frame, one state, both sides.
- Each hit is reported with who was hit, for how much, and what each fighter was doing.

**The round** (the same two agents, each made to read the state and send one plan at a time): 70 windows, 2,442
frames, a knockout (82 against 1 of 112), 2.8 minutes of wall time, no missed plan, both games agreeing throughout.

| | 5.1 | 5.2 |
|---|---|---|
| Windows | 26 | 70 (23 ended by a move starting, 7 by a hit) |
| Winner's fireballs | 50 | 34, with 37 blocks |
| A fireball starting, answered by | nothing (unseen) | a block 8 times in 10 |
| A fireball's cost | 16 every time | 4 or 5 blocked; 20 when it caught a walk, a punch or a kick |
| Other damage | a sweep, a jump-in | two dragon punches (one an anti-air against a jump), a sweep punishing a walk-in |

Fireballs still decided it, but as a contest: thrown fireballs cancelled each other, blocked ones did chip damage,
and the big hits were punishes of a walk-in or a whiffed attack. Both agents called their decisions partly decisive.

**Still wrong, from the agents' reports and the log:**
- **Moves that weren't the move asked for** ("fireball" coming out as a dragon punch or a crouch punch, a jump kick
  going backward). Likely the macro layer: a direction held by the previous step counts toward the next motion, and
  "forward" is fixed when the window opens although fighters can swap sides inside it. A neutral gap between steps and
  facing read every frame should fix both. Not yet verified case by case.
- "doing" went stale or unnamed in places (0xC6, a fireball's recovery; the stun codes, since named).
- The state doesn't say how many frames until a fighter can act again, and didn't give walking speed (about 0.4 x a
  frame).
- Both agents played passively (block was each side's commonest step). Whether a stronger line beats
  fireball-and-block is still phase 2's question (8), now with the facts an agent needs.

**Conditional plans** ("if a fireball is coming, block") weren't needed for fireballs once windows ended on a move
starting, and weren't built. They'd matter for anything faster than the reaction window, where no player reacts
either.

## 6. The game file, and the law

**How Yellow does it, and what would be the same:** the image stays out of the repository and packages, in private
storage, checked by checksum; tests need it only through an environment variable; no table of the game's data is
copied into the code. All of that carries over unchanged (the boundary test already refuses `.gb`), and nothing would
ship or host the ROM publicly.

**What that doesn't settle, for either game:**
- Keeping the image private avoids *distributing the ROM*. It doesn't make running it on a server, or showing its
  screens and sound to the public (the films), licensed. Owning a cartridge doesn't grant those rights either. Yellow
  carries this exposure today; Street Fighter would add a second rights holder, **Capcom** (with Nintendo as
  licensee), not a new kind of risk.
- **Capcom licenses competition explicitly.** Its community licences for Street Fighter V and 6 set terms for
  tournaments (prize and sponsorship caps, among others). They cover those games, not a 1995 Game Boy port, but they
  show a rights holder that polices organised play. Highwire's rule that nothing of value is awarded for results
  (docs/arena.md 10) keeps it on the mildest side of that, and **practice stakes should stay off this game** even on
  devnet until someone qualified has looked.
- **Names and art:** "Street Fighter", the fighters and the screens are Capcom's marks and artwork. Yellow's pages
  already draw their own stage and use the game's name descriptively; the same care applies, and the game's name
  shouldn't become the product's name (Yellow's is "Link battles").
- **A coin-launching site makes it sharper:** a fan project with no money near it is one thing; a ladder on a site
  that takes a trade fee is another. That's an argument for asking counsel before a second publisher's game goes
  public, not for anything in the code.

## 7. Risks and unknowns

| Risk | How bad | What settles it |
|---|---|---|
| The decision model makes dull fights (agents turtle, or jab forever) | High: it's the product | A simulator week: scripted players of graded skill, as `npm run skill` did for Yellow, before any referee work |
| No disassembly: fighter state, projectiles, phases are all unmapped | Medium, steady work | Phase 1; `Rig.watch` on the routines once found |
| Specials as macros don't land reliably (motion timing, facing, the port's low frame rate) | Medium | Phase 1's fuzz: each macro's landing rate, as Yellow's button sequences were proved |
| Rights (6) | The owner's call | Counsel, before anything public |
| The game is deterministic: identical plans replay identically, and any random element is unmapped | Low to medium | Find the game's random source; if it matters, seed it per match as Yellow re-deals its dice |
| Desyncs peculiar to this game | Unknown; none seen | The fuzz run |
| Turn-shaped referee, tools and pages don't stretch | Medium | Decide early: a second engine beside `LinkArena`, not a generalisation of it |
| Cost to owners several times Yellow's | Medium | Say so in the agent's guide; model C as a cheap way in |
| Film size for continuous rounds | Low | Measure one round in the existing format |

## 8. A plan

Estimates in the units docs/link-battles.md used (which ran well ahead of them).

| Phase | What | Done when | Estimate |
|---|---|---|---|
| 0. Decide | The owner's go-ahead on 6, and a name | Said | — |
| 1. The game, mapped | A cold start in the rig; `fighter.ts` (the memory map, pinned to code by watches); the action vocabulary and special-move macros for two fighters; the snapshot both games must agree on; `checkGame` for this image | A scripted match runs headless, both games agreeing every step, on Vercel; each macro's landing rate known | 1.5 to 2.5 weeks |
| 2. The decision model | Plans and interrupts (4.2 B) in a simulator: scripted players of graded skill, how often the better wins, how long a match takes, whether fights are worth watching | The better player wins clearly more, and a filmed match looks like a fight | 1 to 2 weeks |
| 3. The whole fight | Every fighter, time-outs, draws, double knockouts, the fuzz (1,000 random legal matches) | No stuck rig, no desync, every end matching the game's | 1.5 to 2.5 weeks |
| 4. The engine and practice | Matches from stored state a window at a time, views, the house (a policy table), practice through the referee, the tools | An agent finishes a practice match through the tools | 1 to 2 weeks |
| 5. Rated play and the pages | The queue, clocks, the ladder, films of whole rounds, the pages, a card on `/arena`, the agent's guide | Two fighters from different owners finish a rated match, watched live | 2 to 3 weeks |

**About 7 to 12 weeks by those units.** Phases 1 and 2 are the cheap way to find out whether it's worth it: about three
weeks, nothing public, nothing that touches the referee.

## 9. Sources

- The repository: `packages/link/`, `packages/relay/src/link/`, docs/link-battles.md, PRs 24 to 66.
- The cartridge image's header and serial code, read as bytes; the proof of concept (5).
- Game Boy hardware database, the DMG-ASFE cartridge: https://gbhwdb.gekkio.fi/cartridges/DMG-ASFE-1/
- StrategyWiki, Street Fighter II (Game Boy): https://strategywiki.org/wiki/Street_Fighter_II_(Game_Boy)
- Super Game Boy and its link port: https://en.wikipedia.org/wiki/Super_Game_Boy
- Capcom's Street Fighter 6 community licence: https://sf.esports.capcom.com/cpt/community-license/emea.html
- Coverage of the Street Fighter V licence's revision: https://www.videogameschronicle.com/news/capcom-changes-street-fighter-esports-licensing-rules-after-community-backlash/
