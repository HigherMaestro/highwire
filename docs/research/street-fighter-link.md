# Assessment: Street Fighter II link battles

Status: **due diligence, 2026-11-16 and 17. Nothing built. The engine side works; the test of skill failed (5.9), and
the recommendation is not to build this game as a rated ladder.** Whether Highwire can run a Game Boy Street Fighter
II link-cable fight between two agents the way it runs Pokémon Yellow's (docs/link-battles.md), and what it would
take. The decision is the owner's. Not legal advice.

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

**The verdict after nine rounds and the grids (5.1 to 5.9): the rig passes and the game, as agents would play it,
doesn't.**
- **What works.** Two linked Game Boys under a plan-and-window referee: no desync and no stuck rig in about 4,000
  scripted rounds and nine rounds between agents; moves come out as asked; the seats are close to even; rounds end on
  the game's own knockouts and matches by the game's own rule; the state tells a player when its press will start,
  when its block works and when a fireball lands. Rounds between agents look like fights (5.8, 5.9).
- **What doesn't.** Phase 2's test, that the better player wins clearly more, holds up to "plays a careful recipe"
  and stops there. Search found no player that beats the careful ones: the strongest player found never loses to
  anything and never beats its like. Every match among the three strongest players (72 of 72) ended with no winner,
  by the game's own rule. No fighter in the roster has a throw, so a block has no answer but chip, and two players
  throwing fireballs on the same frames cancel each other for ever.
- **So:** a ladder on this game would put its best fighters in undecided matches. **Recommended: don't build it as a
  rated game.** 5.9 says what could still be tried, and what I'd expect of it.

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

### 5.3 Round three: moves that come out as asked, and what cut them short (2026-11-16)

**The wrong moves of 5.2, found and fixed in the referee's macro layer:**
- **The game remembers a forward press for most of a second** (more than 26 frames, less than 46). Walk forward, then a
  fireball's down, down-forward, forward and punch, is a dragon punch's motion, for Ryu and Ken alike; a neutral gap of
  20 frames, a tap back or a tap down doesn't clear it. A fireball now waits until forward has been up 46 frames.
  (A person meets the same thing on the cartridge.)
- **Presses were dropped or misdirected after another step:** a tap after a crouch did nothing, and a jump after a walk
  went the way of the walk. Every press or motion now starts with 6 frames of nothing held, presses are held 6 frames
  or more, and a directed jump holds its direction before up.
- **Forward and back are worked out when each step starts,** not when the window opens, so swapping sides inside a
  window no longer turns a move round.
- **Names:** Ryu's and Ken's specials use different codes (0xB8 to 0xC6 is a fireball for Ryu and a hurricane kick for
  Ken), and close-range punches and kicks have their own (0x20 to 0x26).

**Checked case by case from saved states:** 16 actions × both fighters × facing each way (the opening, and after
crossing sides) × after each of seven steps (nothing, forward, back, crouch, crouch block, a punch, a kick) × two
starting frames: **893 of 896 came out as asked.** The three left are a 24-frame walk back that hadn't moved a whole x
yet, and two jumps asked for while a close punch or kick was still playing (the game ignores them, correctly).

**Added to the state:** how many frames each fighter has been in its current move; walking speed (about 0.5 x a frame)
and rough move lengths in the rules. The game doesn't expose a "frames until free" counter that was found.

**The round** (the same two agents, told not to settle for fireball and block): 84 windows, 2,717 frames, a knockout
(Ken, 54 against 0), 3.6 minutes, no missed plan, both games agreeing throughout.

| | 5.1 | 5.2 | 5.3 |
|---|---|---|---|
| Windows | 26 | 70 | 84 |
| Fireball steps, both sides | 65 | 50 | 43 |
| Close-range attack steps sent (sweeps, jump-ins, dragon punches, hurricane kicks, crouch punches) | 25 | 13 | 29 |
| Hits that weren't a fireball | 2 (by the agents' accounts) | 4 | 5: three sweeps, each on a crouching fighter, a dragon punch against a jump, a crouch punch |
| Fireballs that caught a walk, a jump or an attack | (unseen: nearly all) | 3 | 5 |

More of a fight: both sides came in, sweeps traded knockdowns at about 40 range, a jump-in was dragon-punched, and
fireballs punished walking in or jumping late. The winner led on sweeps and spacing.

**What round three found instead: a window's end cuts a move in half.** When a window ends (6 frames after the other
fighter starts a move), whatever is left of a plan is dropped, including the rest of a move's own inputs. Of 70
presses and motions begun, about 44 were cut before their last button frame (21 fireballs, 14 sweeps, 7 jump kicks, 2
jumps; counted from the log, roughly). A fireball cut mid-motion never comes out, a sweep whose button is let go early
is a lighter crouching attack, and a jump kick loses its kick. Both agents reported exactly these ("a fireball only
came out as a lone step", "sweep came out as a crouch punch", "dragon_punch only crouched"), and they are not the
macro bugs above: the case check has no windows ending early. **The fix is a rule, not a patch: a move once begun
finishes its inputs across the window's end, and the new plan starts after it**, as a person's hands would. Not yet
built; it's the next thing to do before any conclusion about how good the game is.

Also reported, and true: holding block walks a fighter backward into the corner (it's the same button); "block stun"
shows for as long as back is held near an attack; the state doesn't say whether a step's move began.

### 5.4 Round four: a move begun is a move finished (2026-11-16)

**The rule, built:** when a window ends, a press or motion whose first button frame has played and whose last hasn't
is carried: its remaining inputs play first in the next window, with the facing they began with, and the side's new
plan starts after them. A step that had pressed nothing yet is dropped as before. **Symmetry holds:** both sides
still plan from the same frame and the same state, neither sees the other's plan or carried inputs, and the state
tells a side only about its own move in progress (`your_move_in_progress`, with the input frames left). The side
mid-move doesn't gain time; it's committed, as a person mid-motion is.

**Checked:**
- **Cuts:** every press and motion (13), by both fighters, with the window ended at 15 points through it: 390 cuts, 154
  of them mid-input, and **all 154 moves came out.**
- **The case suite of 5.3, run again on this engine:** 893 of 896, the same three.
- **Those three:** the walk back is slow to start (Ken, after walking forward: 0 x in 24 frames, 6 in 40, 10 in 60), so
  the check's 24 frames were too few: not a fault. The two jumps after a punch or kick happened at 24 apart, where the
  game plays its longer close-range punch and kick (0x20 to 0x26); at 32 apart the same plan jumped every time, with
  or without a wait. So most likely the jump's press fell inside the close move and the game ignored it, which is the
  first item under "still open" below. Not reproduced directly.

*(Corrected in 5.8: this round was stopped by the referee with Ryu at exactly 0 health and still standing, a hit before a knockout.)*

**The round** (the same two agents, the same instructions as 5.3): 60 windows, 2,138 frames, a knockout (Ken, 82
against 0), 2.8 minutes, no missed plan, both games agreeing throughout.

| | 5.1 | 5.2 | 5.3 | 5.4 |
|---|---|---|---|---|
| Windows | 26 | 70 | 84 | 60 |
| Fireball steps, both sides | 65 | 50 | 43 | 23 |
| Close-range attack steps sent | 25 | 13 | 29 | 25 |
| Hits that weren't a fireball | 2 (by the agents' accounts) | 4 | 5 | 7: four sweeps, two jump kicks, a crouch punch |
| Fireballs that caught a walk, a jump or an attack | (unseen: nearly all) | 3 | 5 | 3, all jumps |

The first round where the two sides played differently and it showed. Ryu jumped in over fireballs and landed two
jump kicks; Ken answered by blocking the jump, sweeping the landing (four knockdowns for 14 each) and throwing a
fireball as Ryu stood up; Ryu's later jumps left the ground too early and were hit three times for 16. Most damage
was no longer fireballs, and neither agent reported a move coming out as a different move.

**Still open, from the agents and the log:**
- **Inputs sent while a fighter can't act are lost.** The game ignores the pad during a move's recovery, a landing or
  getting up, and the referee plays a step's inputs regardless: a sweep asked for on landing showed as crouching and
  never came out, a jump sent during a fireball's recovery vanished, and Ken's five dragon punch steps never landed one
  (by his account he was still recovering from a fireball, or already being hit; not checked frame by frame). Nothing told the agent. The fix is the same
  kind as the last: hold a press or motion until the fighter's move code says it is free, and say so in the state.
  Until then anti-air dragon punches, the game's main answer to a jump-in, are mostly out of reach.
- No frames-until-free for either fighter, when a jump lands, or which fighter is in front when they overlap.
- "doing" still had one unnamed code (0x88).

**Where this leaves the question of 5.1** ("can an agent even play this?"): yes. Across four rounds the same two
agents went from a blind fireball war to reading jumps, blocking, punishing landings and losing to their own
mistimed jumps, and each referee fix moved the fight further from one pattern. What it still doesn't show is whether
a stronger player reliably beats a weaker one, which needs graded scripted players over many rounds (8, phase 2), and
one more referee rule (inputs waiting for a free fighter) before that's worth measuring.

### 5.5 Round five: inputs wait for a fighter that can act (2026-11-16)

**The rule, built:** a press or motion starts only when its fighter is free (its move code is standing, crouching or
walking), has held nothing for 6 frames, and 12 frames have passed since its own last button (the game takes about 9
to show a button as a move, so "free" can't be trusted sooner). Until then it waits, holding nothing, and starts on
the first frame it can, with the facing worked out then. If the window ends while it is still waiting, it's dropped
and that side's state names it (`your_step_not_started`); held actions (block, forward, crouch) never wait. A side is
told only about its own waiting or carried move.

**Added to the state, for both fighters alike** (all of it on screen): `free_to_act`; `free_in_about`, an estimate
from each move's measured length, since no counter for it was found in memory; `lands_in_about` for a fighter in the
air; which side the opponent is on, including when the two overlap. 0x88 is hit stun while crouching. Codes 0x66, 0x94
and 0x98 turned up in play and are still unnamed.

**Checked:**
- **Into every can't-act state:** all 13 presses and motions, by both fighters, sent 4, 14 and 28 frames into the
  fighter's own fireball, heavy kick, jump, sweep and dragon punch, and into hit stun, a knockdown and a blocked heavy
  kick: **591 of 598 came out once the fighter was free**, among them every dragon punch sent during a fireball's
  recovery. The other 7 are one case: the fighter let go of block to start a move as the kick arrived, and was hit
  out of it. That's the game, not a lost input.
- **5.3's case suite:** 895 of 896. The two jumps after a close punch or kick now come out, which confirms 5.4's
  guess about them; the one left is the 24-frame walk back.
- **5.4's cuts:** 390 cuts, 158 mid-input, all 158 came out.

**The round** (same agents, same instructions, with the dragon punch named as the answer to a jump): 30 windows,
1,237 frames, a knockout (Ryu, 100 against 0), 1.3 minutes, no missed plan, both games agreeing.

| | 5.1 | 5.2 | 5.3 | 5.4 | 5.5 |
|---|---|---|---|---|---|
| Windows | 26 | 70 | 84 | 60 | 30 |
| Fireball steps, both sides | 65 | 50 | 43 | 23 | 12 |
| Close-range attack steps sent | 25 | 13 | 29 | 25 | 8 |
| Hits that weren't a fireball | 2 (agents' accounts) | 4 | 5 | 7 | 3: a jump kick, a dragon punch, a sweep |
| Fireballs that caught a walk, a jump or an attack | (nearly all) | 3 | 5 | 3 | 4, and the knockout |
| Dragon punch steps sent, and landed | 1, 0 | 2, 0 (three came out by accident) | 1, 0 | 5, 0 | 2, 1 |

A short, one-sided round: Ryu threw 11 fireballs, every one came out, and Ken walked, jumped or threw into them. No
agent reported a move silently lost; four steps were dropped while waiting, each named in the state, and resent.

**Anti-air dragon punches, the point of this round:** not yet. Ryu's first was sent as Ken jumped but Ryu was still
recovering from a fireball; it waited, came out late, and Ken's jump kick landed for 8. His second came out and hit
Ken for 19, but on the ground, after the landing. A scripted check afterwards (the defender free when the jump starts,
answering in the window that opens 6 frames later) says why: **a reactive dragon punch beat the jump once in six
tries** (Ryu, a jump from 48 away: 16 to the jumper); in the other five both missed. It never lost: the defender took
nothing in any of the six, the same as blocking, where a sweep took 8 to 15. The motion costs about 32 frames at this
game's slow pad reading, plus the 6 of reaction and 9 of lag, against a 48-frame jump: it arrives as the jumper lands.
So in this port an anti-air has to be committed early or set up (thrown as the opponent leaves the ground into a
fireball), not reacted to; a sharper motion (shorter holds land 5 times in 6, not 6) would buy a few frames.

**Still open:**
- A carried jump kick holds a side's next plan for up to 30 frames (the kick comes late in the jump), which the agent
  on the wrong end read as being unable to block. The state shows it; a jump can't block anyway.
- The knockout hit wasn't listed in the last window's hits (health wraps past zero and the check skipped it).
- The three unnamed codes.

**Across five rounds,** each referee rule removed a way for a plan to fail for reasons that weren't the agent's:
unseen fireballs (5.2), motions misread (5.3), moves cut by a window (5.4), inputs sent to a fighter that couldn't act
(5.5). What's left to fail is judgement, which is the game. Round to round the same model won and lost by a wide
margin on small differences in line (5.4's block-and-sweep, 5.5's patient fireballs), so one round says little about
who is better: the next step is still graded scripted players over many rounds (8, phase 2).

### 5.6 Round six: 5.5's open items closed, and sharper motions (2026-11-17)

Played on the referee with 5.7's fixes in it too (the seats evened, the faster sweep, blocks that follow a jump over).

**5.5's list:**
- **The carried jump kick.** A plan already queues behind a carried move; what was missing was saying so. The state
  now has `your_plan_starts_in` (frames, 0 when nothing is carried) for every side alike, and the carried move says
  that the next plan, a block included, starts then and not now, and that a fighter in the air can't block anyway.
  Neither agent misread it this round.
- **The knockout hit** is listed: a hit that takes health past zero (it wraps) counts for what was left. Round six's
  last window names it (a fireball, 10, into a jump).
- **The unnamed codes,** from 20 rounds between scripted players: 0x0A is the last 10 to 15 frames of getting up;
  0x66 is the knocked-out fall (about 180 frames, then the round ends); 0x98 is being hit while getting up, and 0x94
  being hit out of one's own fireball (both shown as hit stun); 0x6C, new, is 4 frames at the start of a kick.
- **Sharper motions: adopted, to the limit the game allows.** The game moves a step every 5 frames (5.7), so a
  direction held 5 frames is always read once: motions now hold each direction 5 frames (were 6), the last with its
  button 5 (was 8), after 5 frames of nothing (was 6). A dragon punch's button goes down 25 frames after the step
  starts, where it took 30. Tried and refused: 4-frame holds (857 of 896 cases; dragon punches came out as crouch
  punches and fireballs), and a dragon punch with no pause between forward and down (846 of 896; it walked).
- **A frames-until-free counter: not found, and not cheap.** Across 325 busy stretches no byte of a fighter's record
  only falls to the frame it's free (the nearest, +0xC1, is the trailing health bar): the game seems to step through
  each move's own animation rather than count down. The same data checked the estimate's lengths instead (sweep 49
  to 50, dragon punch 65, a knockdown to standing 95, a fireball 45 to 70 by fighter), which is what `free_in_about`
  already used.

**The suites, on this referee:**
- **5.3's cases,** now at all five phases of the game's step: **2,238 of 2,240.** The two left are the 24-frame walk
  back, one for each seat.
- **5.4's cuts:** 390 cuts, 146 mid-input, all 146 came out.
- **5.5's can't-act cases:** 572 of 598 (it was 591). Every other state is clean (78 of 78 for each of a fireball's
  recovery, a heavy kick, a jump, a sweep, a dragon punch and a knockdown; 52 of 52 in hit stun). All 26 are 5.5's one
  case, more often: the fighter stops blocking to start a move while the blocked heavy kick is still out, and is hit.
  A move now starts sooner, so it meets the kick more often. The game, not a lost input; but see "still open".
- **The reactive anti-air** (5.5's scripted check, a dragon punch sent in the window after a jump starts): **it beat
  the jump 3 times in 6, where it was 1 in 6,** and still never lost.

**The round** (the same two agents and instructions): 68 windows, 2,416 frames, a knockout (Ryu, 91 against 0), 3.1
minutes, no missed plan, both games agreeing.

| | 5.1 | 5.2 | 5.3 | 5.4 | 5.5 | 5.6 |
|---|---|---|---|---|---|---|
| Windows | 26 | 70 | 84 | 60 | 30 | 68 |
| Fireball steps, both sides | 65 | 50 | 43 | 23 | 12 | 31 |
| Close-range attack steps sent | 25 | 13 | 29 | 25 | 8 | 23 |
| Hits that weren't a fireball | 2 (agents' accounts) | 4 | 5 | 7 | 3 | 6: four sweeps (two of them a trade), a hurricane kick, a dragon punch |
| Fireballs that caught a walk, a jump or an attack | (nearly all) | 3 | 5 | 3 | 4, and the knockout | 3, the knockout among them |
| Dragon punch steps sent, and landed | 1, 0 | 2, 0 | 1, 0 | 5, 0 | 2, 1 | 1, 1 |

**The first anti-air that worked:** Ken jumped in with a kick, Ryu's dragon punch was sent in the window the jump
opened, and it took Ken out of the air for 16. Both opened with fireballs, which now cancel every time (the seats are
even), and both said so; Ryu broke it by jumping a fireball into a sweep on landing, twice, then led and sat behind
fireballs and a block. Ken blocked the jump-ins but lost each race to sweep the landing, the first-to-commit rule 5.7
measures. 16 steps were dropped while waiting, each named in the state.

**Still open, from the agents' accounts:**
- **`free_to_act` is true while a queued press still can't start.** A press also waits for 5 frames of nothing held,
  12 frames after its side's last button, and, for a fireball, 46 after walking forward; a move sent from a block
  came out 30 to 50 frames late, and one agent was wrong about it four times. The state should say how long the next
  press must wait (the referee knows), and whether it's the forward rule.
- **A block does nothing during the blocker's own recovery,** and the state doesn't say when a held block will work.
  Both agents asked for it. It also answers the can't-act suite's one case.
- `free_in_about` misled once (48 shown after a jump attack; the fighter swept at once). It's still an estimate.
- A fireball's arrival frame, asked for by one agent, is distance over its speed: cheap to add.

### 5.7 Graded scripted players: does the better one win? (2026-11-17)

Phase 2's question (8), asked of the proof of concept's referee before any of it is built: eight scripted players,
each seeing exactly the state an agent sees and answering with plans, every pairing and every mirror, 40 rounds each
with the seats swapped every round and seeded choices. **1,440 rounds: no desync, no stuck rig, every round ended by
the game** (1,165 knockouts, 275 on the clock, 128 of those drawn). A round averaged 43 seconds of game and 98 windows,
and about 9 seconds of one core. This grid ran on the referee as it stood before 5.6's sharper motions (6-frame holds).
*(5.8: the referee then ended a round when a fighter reached exactly 0 health, a hit before the game's knockout. About a
quarter of rounds reach that state and the fighter at 0 wins about one in fifty of them, so the table below stands to
within a round or two in a hundred; the knockout count includes rounds stopped early.)*

**What the first trial runs found, each fixed in the referee before the grid:**
- **Player 1 had an edge, and it was the game's.** The game moves a step every 5 frames and reads player 2's pad 2
  frames before player 1's, so the same input on the same frame came out up to a whole step (5 frames) later for
  player 2. Two identical fireball-throwers: **player 1 won 48 rounds of 48**, whichever fighter sat where (Ryu and
  Ken, Ken and Ryu, Ryu twice, Ken twice). The referee now holds player 1's inputs back 2 frames. After it, every move
  tried shows on the same frame for both seats at every phase of the step, the same mirror is drawn every time, and
  over the grid player 1 won 652 rounds and player 2 660. The five agent rounds before this (5.1 to 5.5) were played
  with the edge.
- **The two games can be one frame apart on a hit** (game 2 took the damage a frame after game 1, once in a trial
  run). The check for a desync now asks whether they stay apart; over the grid they never were for more than a frame.
- **Buttons held on the pads outlive a loaded state:** a match resumed from a stored state must let go of everything
  first. (One trial grid played out as two fighters walking for 78 seconds.)
- **The sweep was 8 frames slower than it need be:** down and kick together come out as fast as a standing kick (14
  to 18 frames from the button); the macro crouched first. Fixed, with the crouch punch.
- **A block didn't follow a jump over it:** "away from the opponent" was settled when the step began, so a jump that
  crossed over turned the block into a walk forward. Held actions now follow the other fighter frame by frame.

**The players:**

| Player | What it does |
|---|---|
| random | Any action at all, every window |
| masher | Walks in; in range, a random punch, kick, sweep or jump kick. Never blocks, never looks |
| zoner | A recipe by distance: a fireball beyond 70, a sweep within 40, either between. Never looks at the other fighter |
| reactor | The zoner, plus blocking what the state shows coming: a fireball about to arrive, a jump-in, an attack in range |
| punisher | The reactor's blocks, and ideas: walks in behind its block, jumps a fireball as it's thrown and kicks the thrower, sweeps a recovery, blocks low at close range more than it attacks |
| reactor-25, -50, -75 | The reactor, erring: that share of its windows' plans is any action at all |

**The same player, erring less, wins, and steeply** (rounds won of 40):

| | against reactor-25 | reactor-50 | reactor-75 |
|---|---|---|---|
| reactor | 40–0 | 40–0 | 40–0 |
| reactor-25 | | 37–3 | 38–2 |
| reactor-50 | | | 33–7 |

**A recipe beats none:** the zoner and the reactor each beat random 40–0 and the masher 39–1. The masher is no better
than random (17–23).

**Above the recipe, the players go in a circle, and care isn't rewarded:**

| Pairing | Result |
|---|---|
| reactor against zoner | 39 of 40 drawn on the clock; every mirror of either drawn the same way |
| zoner against reactor-25, -50, -75 | 40–0 each: the plain recipe beats the reactor at any error |
| punisher against zoner | 31–8 (its jump over a fireball into the thrower works) |
| punisher against reactor | 3–37, and it loses to the erring reactors too (6–34, 8–32, 13–27) |
| punisher against masher | 25–15 |
| punisher against random | 12–27, 38 of the 40 on the clock: it blocks, and a stray hit leads at time |

**Why,** from tallies of what hit what:
- **At close range the first to commit wins.** A move shows 14 to 18 frames after its button, the window that lets
  the other side answer opens 6 frames after that, and an attack sent then needs its own 14 to 18: only a block can
  answer in time. Nearly all the damage the punisher took landed during the start of its own sweep. Punish windows that exist for a person don't exist at this latency.
- **A block has no counter in the vocabulary.** There is no throw, so two careful players can't hurt each other:
  that's the 40 drawn mirrors. The arcade game's answer to a blocker is a throw; whether this port has one isn't mapped.
- **Fireballs thrown on the same frame cancel,** now that the seats are even, so a fireball war between equals is a
  draw too.

**What it says about the plan (8, phase 2).** "The better player wins clearly more" holds where better means fewer
mistakes (25 points of error is worth 82% to 100%) and where it means knowing a recipe at all. It isn't shown above
that: the player with more ideas lost to the simpler one, for reasons that are the model's and the vocabulary's, not
only the script's (it was written by hand in an afternoon, and a searched or tuned player may do better). 19% of
rounds went to the clock and 9% were drawn, nearly all between careful players: risk 7's "agents turtle" is real
here. Before phase 2 can pass it needs a throw or another answer to a block, a rule for a drawn round, a look at
whether the reaction window can open sooner without showing a side what isn't on its screen yet, and players found
by search. The seat fix belongs in phase 1's map whatever else happens.

### 5.8 Rounds seven and eight: what the state tells a player, the game's own match, and three questions answered (2026-11-17)

5.6's and 5.7's open lists, worked through. Two rounds were played: seven on the first version of the new state
fields, and eight after fixing what seven's players found wrong with them.

**A fault found on the way, which corrects earlier sections: the referee ended rounds a hit early.** A fighter at
exactly 0 health is still standing. The game knocks out on the hit that takes health below 0, when the byte reads
255. The referee ended a round at 0, and health is 112 with hits of 7, 14 and 16, so exactly 0 is common. Rounds
four (5.4: "82 against 0") and seven below were stopped with the loser at 0 and still up. In a 210-round grid on
the fixed referee a fighter stood at exactly 0 in about a quarter of rounds (44 to 52 of 210) and went on to win
one of them, so 5.7's table stands to within a round or two in a hundred, but its "1,165 knockouts" includes rounds
stopped early. Fixed: a round ends on a 255 or the clock, and a state shows `knocked_out`. Found by reading each
round's winner from the game's own stars (below), which disagreed with the referee.

**1. How long the next press must wait.** `your_next_press` gives `starts_in_about` (frames before a press sent now
plays its first input), `held_up_by` (the reason, in words) and `fireball_starts_in_about` (a fireball also waits
for a forward press to be forgotten, and for the fighter's earlier ball to leave the screen: the game allows one,
and a second came out as a punch in round seven until the referee made it wait). The gap was bigger than 5.6 said.
A button takes 14 to 18 frames to show as a move, and until then `free_to_act` reads true: the fighter's own last
press is what makes the estimate. Checked by sending a press from 1,196 states of scripted fights and timing it:

| What holds the press | Checks | Within 2 frames | Within 6 |
|---|---|---|---|
| Nothing, or only the referee's own waits (stated exactly) | 319 | 94% | 97% |
| The fighter is busy, or its own press hasn't shown yet (estimated) | 874 | 77% | 86% |
| of which: in a block pose (a guess from the other fighter's move) | 112 | 31% | 66% |

`free_to_act` was true in 425 of those states; the press then waited more than 6 frames in 156, and
`your_next_press` was within 6 frames of the wait in 138 of the 156. The misses are mostly a hit taken in between.

**2. When a held block works.** `your_block` gives `works_now`, `works_in_about` and what a block stops. Measured
first (8,800 windows of a fighter that only blocks, or blocks after a move of its own): a standing block lost full
health only to sweeps and to some jump attacks that cross over; a crouching block only to jump attacks; and a
block does nothing from the frame the blocker's own button goes down until that move is over. A block held through
that starts working a frame or two after the fighter is free (a hit on the very frame still lands), so the estimate
allows 3. Holding a block where the state said it worked, 411 windows passed without a full hit; of the 29 full hits
taken, 25 were sweeps on a standing block, which the field names, and 4 were other things.

**3. A fireball's arrival.** A ball sits 9 frames, then moves 4, 4 and 8 x on the game's 5-frame steps (16 x in 15
frames, not the 1.3 a frame the rules claimed), and lands with about 12 x to go. `their_fireball.arrives_in_about`
is within 6 frames three times in four for a fighter standing still (16 of 16 within 13). `passed_you` marks a ball
already behind its target; until now the state kept showing balls that had hit or left, for lack of the record's
in-flight byte (its first: 2 while flying). `their_fireball_coming` covers the 24 frames between the throw showing
and the ball existing. A hit by a ball whose thrower has moved on is listed as "fireball (in flight)".

**4. `free_in_about`** now comes from each move's measured length by code, not one number a move: a punch 19 to 20
frames from showing, a heavy punch or kick or a sweep 49 to 50, a fireball 65, a dragon punch 64, a hurricane kick
79 to 80, hit stun 39 (19 after a light hit), a knockdown 95. A jump is 79, of which 15 are on the ground before it
leaves, 55 in the air and 9 landing; the state had said 48, and that is what misled after a jump attack. A jump's
state says straight up, forward or back.

**5. A throw: none found.** 1,728 trials: each seat, touching and at three steps back, forward, back or no
direction with punch, kick or both, tapped, held 14 and held 30 frames, against a fighter standing, walking in,
blocking and crouch-blocking. Every attacker code was a strike's (the close versions of punch and kick are codes of
their own), no victim code was anything but hit stun or a block, and no blocker lost any health. Ryu and Ken have
no throw in this release by those inputs. Other fighters weren't tried (Zangief is in the roster). What answers a
block without one, all of it the game's own:
- **High and low.** A sweep beats a standing block and a jump attack beats a crouching one. Round eight was decided
  by it: jump over a fireball, kick, sweep.
- **Chip.** A blocked fireball costs 4 or 5 and can knock out. Round seven's last ten windows were a fighter at 10
  health chipping one at 73 down to 0.
- **The clock,** with the game's own match rules behind it (next).
- Not proposed: any referee rule that changes what a block does. That would be inventing the game.

**6. A drawn round: the game has a rule, and the referee now follows it.** Left alone after a drawn round, the game
plays it again. Two drawn rounds leave no mark, a third gives both fighters a star, and a fourth ends the match
with neither a win nor a loss on the game's RESULT screen. A double knockout is a drawn round too. A match is the
first to two stars. The referee's `nextRound()` holds nothing and lets the game do this, reads each round's winner
from the star it awards, and stops when the game stops. Nothing is invented: a match the game leaves undecided is a
draw, which the rating takes as one. **90 matches** between five of 5.7's players: 244 rounds, no desync, none
stuck, and the referee's reading of every round agreed with the game's stars. 78 rounds were drawn; **18 matches
had no winner, and all 18 were the three pairings 5.7 already showed as dead** (the recipe against itself, the
defender against itself, one against the other). Every other pairing was decided every time, the hand-written
punisher's mirror included, where two to four rounds in ten had been drawn. A match took 3.5 minutes of game.

**7. The reaction window can open five frames sooner, and that is a choice about the game, not a leak.** The window
opens 6 frames after a committed move's code appears, and the code is what the game draws from: nothing earlier is
on either screen except the motion's own crouch or step, which the state already shows as such. So the 6 is the
referee's, and can be 1. What it decides, for 138 strikes that would have hit a fighter doing nothing:

| Window opens after | Punch or kick blocked in reaction | Heavy punch | Heavy kick | Sweep |
|---|---|---|---|---|
| 6 frames (now) | 0 of 48 | 10 of 30 | 20 of 30 | 0 of 30 |
| 3 frames | 0 of 48 | 10 of 30 | 20 of 30 | 0 of 30 |
| 1 frame, or none | 48 of 48 | 30 of 30 | 30 of 30 | 30 of 30 |

At 6 a light strike or a sweep has landed before the window even ends; at 1 every strike can be blocked by a
player who was doing nothing. Neither is the game as people play it. At 6 the first to commit wins at close range
(5.7). At 1 nothing lands on a waiting fighter but a fireball's chip. The reactive anti-air doesn't care (a dragon
punch beat the jump 3 times in 6 at 6 and at 1, 2 in 6 at 3). A 210-round grid at each setting (six players, 10
rounds a pairing) moved little: 33, 35 and 34 drawn rounds, 62, 58 and 71 on the clock, and no pairing moved by more than
10 rounds can explain. **Left at 6.** It is a dial for phase 2, to be set with searched players.

**The suites on the final referee:** 5.3's cases 2,238 of 2,240 (the two walk-backs); 5.4's cuts 390 of 390, 146
mid-input; 5.5's can't-act cases 572 of 598 (the same 26: a block dropped for a move while a blocked kick is still
out); the reactive anti-air 3 in 6, never lost; the seat check equal to the frame for a punch, a jump, a fireball
and a sweep at all five phases. Across the three grids Ryu's seat won 243 decided rounds and Ken's 285 (75 to 102
in one of them). The seat check says the inputs are even, so this is the fighters or chance, and it wants more
rounds before phase 2 trusts it.

**Round seven** (same two agents and instructions, on the first version of items 1 to 4): 85 windows, 3,917 frames,
no missed plan, both games agreeing. **The referee stopped it at Ryu 2, Ken 0 with 12 on the clock, and Ken was
still standing** (the fault above). Ken led 73 to 10 at window 59; Ryu then threw a fireball every time it was
free, for chip and three full hits on a cornered fighter's late answers. Both dragon punches sent were anti-airs on
a jump the state had just shown, and both landed. What the players reported, each confirmed and fixed before round
eight unless noted: `your_next_press` empty in a block pose; a second fireball coming out as a punch; `passed_you`
wrong just after a ball appears, and a passed ball shown again from the far edge; no arrival before the ball
exists; a block that "works in 14" losing to a hit on frame 14; a jump not saying which way; a ball's hit listed
under the thrower's later move.

**Round eight** (the fixed referee, true knockouts): 90 windows, 4,678 frames, the first round to go the full
clock: **Ryu on time, 32 to 29,** no missed plan, both games agreeing, 12 minutes of wall time. Ryu's damage was
one sequence four times: jump a fireball, kick, sweep. Ken's was a jump kick, two sweeps, one clean fireball and, from window 78, fireballs
from close range for chip, 56 down to 32, one short.

| | 5.1 | 5.2 | 5.3 | 5.4 | 5.5 | 5.6 | Seven | Eight |
|---|---|---|---|---|---|---|---|---|
| Windows | 26 | 70 | 84 | 60 | 30 | 68 | 85 | 90 |
| Ended | knockout | knockout | knockout | stopped at 0 | knockout | knockout | stopped at 0 | the clock |
| Fireball steps, both sides | 65 | 50 | 43 | 23 | 12 | 31 | 31 | 31 |
| Sweeps, strikes, jump kicks and hurricane kicks sent | 25 | 13 | 29 | 25 | 8 | 23 | 28 | 51 |
| Hits that weren't a fireball | 2 | 4 | 5 | 7 | 3 | 6 | 8: five sweeps (two a trade), two dragon punches, a jump kick | 9: six sweeps (two a trade), three jump kicks |
| Blocked fireballs that still cost health | | | | | | 2 | 7 | 8 |
| Dragon punch steps sent, and landed | 1, 0 | 2, 0 | 1, 0 | 5, 0 | 2, 1 | 1, 1 | 2, 2 | 1, 0 |
| Steps dropped while waiting | | | | | | 16 | 8 | 11 |

Both of eight's players said the block and fireball fields were right where they leaned on them (a block "works in
42" held in time against a jump-in; arrivals of 26 and 27 jumped cleanly; `passed_you` right every time).

**Still open, from round eight's accounts:**
- **A carried move that never came out still held the next plan.** A sweep's inputs kept playing through the hit
  stun that had stopped it (up to 34 frames), and `your_next_press` called a dragon punch "on its way" that had been
  hit out of existence. Fixed after the round (a carried move is dropped when its fighter is hit), with the suites
  rerun, but not yet played by agents.
- **The block-pose guess is poor** when the other fighter's attack misses: the pose ends at once and the state said
  about 44. It is labelled a guess; better is to learn what ends the pose.
- **`their_fireball_coming` runs about 10 frames late at close range** (39 said, 29 seen, five times running), where
  the ball appears already touching.
- **Ryu sometimes shows a fireball under codes the length table doesn't have** (`free_in_about` 44 in place of 59,
  and no `their_fireball_coming`). Not traced.
- A rule I added from one player's account in round seven, that a fireball from closer than 28 passes through, was
  wrong (it hit from 24 in round eight) and is taken out. x is a place on the scrolling screen, so it moves while a
  fighter stands still; only `distance` is safe, and the map should find the stage position.
- A blocked strike costs nothing and isn't listed, so a player can't tell blocked from missed. A blocked sweep
  pushes the blocker back about 18, which makes the answering sweep miss.
- In round seven a jump on its 15 ground frames turned into a block as a fireball arrived. Seen once, not reproduced
  with no attack near (the jump always left the ground): probably the game's own guard, unmapped.
- **Phase 2's test is still not met above "knows a recipe".** The game's match rule settles a drawn round where
  players differ at all, and leaves two careful scripts drawn, as it should. The remaining lever in the referee is
  the reaction dial; the rest is players found by search, and fighters with a throw.

### 5.9 The deciding round: searched players, the whole roster's throws, seat or fighter, and the bar (2026-11-17)

The question 5.8 left: is there a clearly stronger player in this vocabulary, or does skill stop at a recipe? Run
on 5.8's referee (true knockouts, the game's match rule, the carried-move fix).

**The bar, written down before the grid ran** (the reviewing session's, with one clause added: a win rate needs
matches that are decided). Matches as the game runs them, 12 a pairing, seats swapped, seeds the search never saw.
1. The best searched player wins two in three or more of its decided matches against each recipe player, and at
   least half its matches against each are decided.
2. No recipe player wins more matches against it than it wins.
3. Between the two strongest distinct players in the grid, nine matches in ten are decided.

**Result: fail,** on 1 and 3.

**A throw: none in the roster.** 5.8's trials (direction and button, touching and three steps back, tapped and held,
on a fighter standing, walking in, blocking and crouch-blocking) plus full and half circles, 1,152 for each of the
eight fighters played as player 1 against Ken: no blocker lost more than chip to anyone, and no victim showed a code
that wasn't hit stun, a knockdown or a block. Zangief got 2,880 more (every rotation of four and of eight
directions, both ways, from each start, one to five frames a direction, the button with the last direction or
after): strikes and jumps only. What Zangief has is both buttons together, a spinning attack that takes 8 to 12
from a standing blocker, nothing from a crouching one, and knocks down for 16 to 19 when it hits. That is chip, and
a crouching block answers it. So no fighter was added to the grid, and the vocabulary has no answer to a block
beyond 5.8's list. The select screen, mapped on the way: Ryu, Blanka, Guile; Ken, M. Bison, Chun Li; Zangief,
Balrog, Sagat.

**Seat or fighter: the seat.** The same scripted player on both sides (three of them, 60 rounds each) in all four
seatings, 720 rounds, 707 decided:

| | Player 1's seat | Player 2's seat |
|---|---|---|
| Ryu v Ken | 83 | 94 |
| Ken v Ryu | 83 | 96 |
| Ryu v Ryu | 81 | 95 |
| Ken v Ken | 77 | 98 |
| All | 324 (46%) | 383 (54%) |

Ryu and Ken won 179 and 177 of the rounds where they met: no fighter edge. Player 2's seat won 54% whoever sat
there (95% interval for player 1's share 42% to 50%). Before 5.7's fix player 1 won everything; holding player 1's
inputs back 2 frames now gives player 2 a small edge, though the same press shows on the same frame for both. Not
chased further: the game steps every 5 frames and the delay can only be whole frames, so the fair fix is to play
every pairing in both seats, as every grid here does. In the final grid's matches the seats split 244 to 224.

**The search.** A player with 31 open choices (`tuned.mts`: what to do far, mid and near with nothing to answer;
whether and when to jump a fireball; whether to dragon punch a jump; when to sweep a fighter that's stuck; what to
time for a fighter getting up; when to sit on a lead), seeing what an agent sees and using 5.8's fields. Scored by
rounds against the field, a draw worth less than half a win.
- **Search A,** against all five recipe players (8 generations of 14, 4 rounds an opponent): it became a fireball
  thrower that blocks, beat the masher, the punisher and the noisy reactor every round, and drew the zoner and the
  reactor every round at full health.
- **Search B,** aimed only at those two (8 generations of 15, 6 rounds each): the mean never left the draw.
- **A flaw of mine found here:** the player only reacted with a move if its press could start within 3 frames, and
  after any block a press waits 5, so it almost never jumped a fireball or anti-aired. A and B ran with it. Fixed
  (6 frames).
- **60 players sampled across the whole space,** scored against the zoner and the reactor: before the fix none won
  more than it lost; after it one beat both 3 rounds to 1.
- **Search C,** from that one, against all five (8 generations of 15): players that never draw, beat the weaker
  three, split with the zoner and lose to the reactor.

**The grid:** the five recipe players and four searched ones (A; C's mean and its best; the sampled one), 45
pairings and mirrors, 540 matches, 1,388 rounds, no desync, none stuck, a match 3.3 minutes of game. The referee's
reading of a round differed from the game's stars in 4 rounds, all third rounds after drawn ones, where the game
puts both fighters on one star for a last round whatever the third did; the match's result is the game's. Matches won,
undecided, lost, row against column:

| | masher | zoner | reactor | punisher | reactor-50 | searched A | searched C | C's best | sampled | All |
|---|---|---|---|---|---|---|---|---|---|---|
| searched A | 12-0-0 | 0-12-0 | 0-12-0 | 11-0-1 | 12-0-0 | | 11-0-1 | 12-0-0 | 11-0-1 | 69-24-3 |
| reactor | 12-0-0 | 0-12-0 | | 12-0-0 | 12-0-0 | 0-12-0 | 11-0-1 | 11-0-1 | 9-0-3 | 67-24-5 |
| zoner | 12-0-0 | | 0-12-0 | 7-0-5 | 12-0-0 | 0-12-0 | 8-0-4 | 5-0-7 | 9-0-3 | 53-24-19 |
| searched C | 11-0-1 | 4-0-8 | 1-0-11 | 11-0-1 | 12-0-0 | 1-0-11 | | 7-0-5 | 10-0-2 | 57-0-39 |
| C's best | 11-0-1 | 7-0-5 | 1-0-11 | 12-0-0 | 12-0-0 | 0-0-12 | 5-0-7 | | 6-0-6 | 54-0-42 |
| sampled | 10-0-2 | 3-0-9 | 3-0-9 | 11-0-1 | 11-0-1 | 1-0-11 | 2-0-10 | 6-0-6 | | 47-0-49 |
| reactor-50 | 12-0-0 | 0-0-12 | 0-0-12 | 10-0-2 | | 0-0-12 | 0-0-12 | 0-0-12 | 1-0-11 | 23-0-73 |
| punisher | 10-0-2 | 5-0-7 | 0-0-12 | | 2-0-10 | 1-0-11 | 1-0-11 | 0-0-12 | 1-0-11 | 20-0-76 |
| masher | | 0-0-12 | 0-0-12 | 2-0-10 | 0-0-12 | 0-0-12 | 1-0-11 | 1-0-11 | 2-0-10 | 6-0-90 |

**Against the bar:**
1. Searched A beats the masher, the punisher and the noisy reactor (35 of 36, all decided). Against the zoner and
   the reactor none of its 24 matches was decided. **Fail.**
2. No recipe player beats it (it lost 3 matches of 96, none to the careful two). Pass.
3. The two strongest are searched A and the reactor: 0 of 12 decided. **Fail.** The same between either and the
   zoner, and in all three mirrors: 72 matches among the three, 72 undecided, 68 of them four drawn rounds running.

**What it shows.** There is no circle: 5.7's was a hand-written player's weakness, and the order here is clean.
Outside the top three all 468 matches were decided, and a player that looks at the other fighter beats one that
doesn't. The trouble is the top. The best play search can find in this vocabulary is to throw fireballs, block what
arrives and never commit first, and two players doing it cancel each other's fireballs at full health until the
game gives up on the match. The players search found that do take risks (C) are decided every time and lose to the
reactor and to searched A 45 matches in 48. So the better player wins clearly more up to the careful recipe, and above it there
is nothing to be better at. Two causes, and only one is the model's:
- **The game's:** no throw anywhere, so a block costs nothing but chip, and a fireball is safe at range.
- **The model's:** both plans start on the same frame, so two fireballs always meet and cancel. Against a person, or
  with any offset, one side would be a few frames ahead and that is what fireball fights turn on.

**Why agents' rounds don't look like this.** Rounds seven to nine were all decided, because the agents took risks
the search calls mistakes: jumping fireballs, sweeping first. Round nine (below) was won 104 to 0 by the side that
waited and punished. A ladder rewards whoever stops taking them, and then the top of it is this grid's top.

**Recommendation: don't build this game as a rated ladder.** In the order I'd weigh what's left:
1. **Drop it for rated play** and keep what was learned (the rig runs a real-time game exactly; plans and windows
   work; the state fields; the method of grading before building). This is my recommendation. Phase 2 was the cheap
   test, and it did its job.
2. **A different decision model,** if the owner wants one more try: break the same-frame start (plans that take
   effect a few frames apart, by turns or by a seeded offset neither side knows) so a fireball fight has a winner,
   then rerun this grid. It answers the model's half of the problem and leaves the game's: with no throw I'd expect
   fewer undecided matches, not none, and it adds a rule that isn't the game's.
3. **Different fighters** don't help: none has a throw. Guile's and the others' specials aren't in the vocabulary
   and weren't graded, but nothing found suggests an answer to a block among them.
4. **Unrated exhibition** is open either way: the fights film well, and nothing about a single match needs the
   ladder to be sound.

**Round nine** (the user's go-ahead; same two agents and instructions; 5.8's last fixes plus two refinements: a
ball's still time in the arrival, 4 frames not 9, and a block pose that ends at once when the strike is out of
reach): **Ken by knockout, 104 to 0,** 52 windows, 2,536 frames, 7 minutes, no missed plan, both games agreeing.
Ken threw fireballs, crouch-blocked, and dragon punched every jump the state showed: 5 sent, 3 landed, each
followed by a fireball timed for the get-up, and the knockout was a jump kick. Ryu's one hit was a jump kick too.

| | Six | Seven | Eight | Nine |
|---|---|---|---|---|
| Windows | 68 | 85 | 90 | 52 |
| Ended | knockout | stopped at 0 | the clock, 32 to 29 | knockout, 104 to 0 |
| Fireball steps, both sides | 31 | 31 | 31 | 13 |
| Sweeps, strikes, jump kicks and hurricane kicks sent | 23 | 28 | 51 | 37 |
| Hits that weren't a fireball | 6 | 8 | 9 | 6: three dragon punches, two jump kicks, a sweep |
| Dragon punch steps sent, and landed | 1, 1 | 2, 2 | 1, 0 | 5, 3 |

What the players reported of the fixes: a move hit before it came out no longer held the next plan (four times, each
with nothing in progress shown and the next plan on time). The block-pose guess was right when the strike was in
reach or plainly out of it and wrong three times in between or after a fireball. `their_fireball_coming` was
consistent from 60 and beyond and still off by about 10 from closer, late for a fighter walking in and early for
one standing. Still wrong, not fixed: a sweep's carried inputs run 27 to 30 frames because its held crouch counts
as input; a ball long gone still listed as the thrower's own; a dragon punch's motion reads as "crouching" until
the punch shows, so no window opens on it; a blocked strike isn't listed.

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
