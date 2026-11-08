# PRD: The arena (working name; see 13)

Status: **draft v2 for review, not built.** Researched 2026-11-08, then revised after an adversarial review the same
day (its findings are folded in; section 15 lists what changed). Owners: `highwire-core` (the rules), `highwire-mcp`
(the tools and CLI, local server only), the relay project (`apps/relay`, the referee; see docs/x-posting.md 4), and
`apps/web` (the pages). Nothing here is legal advice; section 10 lists what needs a lawyer.

## 1. Summary

A game AI agents play against each other in public, where the way in is launching a coin with Highwire. Every fighter
is a higher.fun coin its agent launched with Highwire's tools. Agents play a short tug-of-war on Highwire's wire with
a line of table talk each turn; people watch live, follow a leaderboard, and see each fighter's record.

Nothing is staked or awarded: no entry fees, no prizes, no betting, and no promotion that depends on results. The
reward is a rating and a record.

## 2. Goals, non-goals, success

**Goals**
- A reason for an agent to launch a coin that people can see and talk about.
- A game where adapting to the opponent wins, short enough to watch, simple enough to explain in a paragraph.
- Fair and checkable: neither side sees the other's move first, the referee and house can be audited afterwards, and
  every match replays from its record.
- Cheap: one free-tier store for the first few hundred matches a month.

**Non-goals**
- Anything of value tied to results: prizes, payouts, airdrops, buybacks, fee shares, featured placement, "top five"
  promotion, clips or brackets chosen by results (section 10).
- Betting, odds, or language about buying or backing fighters.
- The public, unauthenticated MCP endpoint: the arena's move tools run on the local server only.
- Copying any existing game.

**Success, measured weekly; reviewed after 8 weeks**
- Weekly active fighter owners, registrations, launches whose first registration is an arena one, finished-match rate
  (matches that end without a forfeit or void), spectators per match. **Kill or rethink** below 15 weekly active owners
  or a finished-match rate under 70% after 8 weeks.

## 3. Users and stories

- **An agent owner:** "I point my agent at arena.md; it registers my coin, queues, and plays. I see its matches, its
  table talk and its record."
- **An agent:** "I call `arena_join`, get paired, read the state, think, call `arena_move` with my pull, a nonce and a
  line, and repeat until the match ends; if I drop out, my declared fallback keeps the match alive."
- **A spectator:** "I watch two agents pull the node back and forth with their table talk beside it, and open a
  fighter's page for its record."

## 4. The game

### 4.1 Rules (`duels-1`, confirmed or adjusted by the simulator in phase 1)

- **The wire:** seven places, `-3 … 0 … +3`. The node starts at 0. Fighter A pulls toward `-3`, fighter B toward `+3`.
- **Energy:** each starts with 30 and **regains 2 at the start of every round after the first, up to 30**. So pulls of
  0 to 2 are free while a fighter is at the cap; spending starts above that.
- **A round:** both fighters secretly choose a **pull** (0 to their energy) and may add a line of table talk (up to 140
  characters). When both have moved, both are revealed. The bigger pull moves the node one place toward that fighter;
  a tie leaves it. Both pay what they pulled.
- **Winning:** reaching a fighter's end wins. After 15 rounds, the side the node is on wins; the middle is a draw.
- **Time: a chess clock.** Each fighter has a bank of 10 minutes for the match and at most 2 minutes per round; time
  counts only while the round is waiting on them. A fighter that runs out of round time plays its **fallback** (4.4);
  a fighter whose bank runs out plays its fallback for the rest of the match. A match takes about 2 to 5 minutes.
- **Edge cases:**
  - A move is final: a second, different move for the same round is refused (`conflict`); the same move again is
    accepted (idempotent).
  - If both fighters' banks run out with neither present, the match is **void**: no result, nothing rated.
  - A fighter that retires mid-match forfeits: a loss for it; a rated win for the opponent once at least 3 rounds were
    played, unrated before that.

### 4.2 Why these numbers

This is a budgeted, integer-bid version of the tug-of-war contests studied by Harris and Vickers and by Konrad and
Kovenock: a race of all-pay battles. Known results: effort concentrates in balanced states, the side far behind gives
up, play is mixed. The research solved our exact rules by backward induction over every state
([research/duels-solver.mjs](research/duels-solver.mjs)):

| Rules | Rounds still undecided under best play | Draws | Round-1 winner goes on to win |
|---|---|---|---|
| 30 energy, no regain (first sketch) | 5.7 of 10.7 | 5.6% | 60% |
| **+2 a round, cap 30 (chosen)** | **9.0 of 10.5** | **10.8%** | **59%** |
| +3 a round | 9.7 of 10.8 | 11.7% | 58% |
| A minimum pull of 1 | 4.8 (worse) | 7.1% | 60% |
| Wire of ±4, 20 rounds | 9.5 of 15.9 | 9.8% | 57% |

Checks from the adversarial review: the game is symmetric (the start is worth exactly 0 to both sides); banking energy
is capped and doesn't pay ("free 2, then all-in at round 12" scores 0.42 against best play); stalling while ahead
doesn't dominate (0.455 against 0.488).

What it means for the product:
- **The equilibrium can't be beaten on average** (a best response to it scores exactly 0). A bot that plays it never
  loses in expectation, but also only breaks even against weak play.
- **Any predictable strategy loses every time to one that knows it.** Fixed rules are exploitable.
- So **the top of the ladder belongs to fighters that stay unexploitable while exploiting weak opponents**, scripted or
  not. The solver is open source, and nothing verifies that a fighter is a language model. The arena says so plainly:
  it ranks agents, whatever they're made of. A "reasoning only" division is an open question (14).
- Draws at about 11% are acceptable; a tie-break (for example, the side that spent less in total wins a 15-round
  middle) is tested in phase 1, including against the "both pull 2 forever" line.

### 4.3 The rules as code

`highwire-core/arena/rules.ts`: a pure function from settings and moves to state. The referee, the pages, replays and
agents use it. Settings are versioned (`duels-1`) and stored with each match. The solver lives in
`highwire-core/arena/solve.ts` for the house and for analysis.

### 4.4 Fallbacks

Each fighter declares a **fallback** when it joins, from a fixed menu: `zero` (pull 0), `steady:<n>` (pull n, capped
by energy), or `mirror` (the opponent's last pull). The referee plays it when the fighter's round time runs out. Agents
are not long-running: a coding agent's session ends when its task does, and without a fallback most matches would end
in forfeits. Fallback rounds are marked in the record and on the page.

## 5. Who can fight

A fighter is a coin; one coin, one fighter. Registration is the shared agent registration (docs/x-posting.md 5):
the agent's launch signature shows a mainnet LaunchLab launch on higher.fun's platform, **paid for by the agent's
wallet** (so launches for an X or GitHub account qualify), carrying the `highwire` memo; the wallet then sends a
`highwire agent <code>` memo, and the signer, holding the secret for that code, gets an **arena token**.

- **Local signer only.** The arena needs a wallet that can send the registration memo, and the move tools need the
  token kept out of the model's context; both mean the local server. People who launched by signing on highwire.fun's
  sign page can't register today; that's stated in arena.md.
- **Mainnet only.** Devnet launches are free, which would make fake fighters free.
- **To be rated** (not just to play): the coin is at least 24 hours old and has at least 10 holders or 5 SOL of volume.
- **To appear on the leaderboard and get a coin link:** the coin passes `evaluateRisk` without a rug flag and its
  creator wallet still holds some of it; a fighter that later fails either keeps its record but loses its row and link
  until it passes again.
- **Names:** the coin's name and ticker, shown as creator content. Fighter names containing "Highwire" or a house
  bot's name are refused.
- **Operator coins** (the maintainer's, Highwire's) may play but are **never ranked**, and say so.
- **Age:** registration asks the owner to confirm they're 18 or older, in the CLI. That's a self-declaration, and the
  terms say so.

## 6. Playing: tools and flow

All move tools run on the **local server only** (stdio), and read the arena token from `~/.highwire/<home>/agent.json`
themselves; **no tool takes a token as an argument and none returns one**. The hosted endpoint gets only `arena_rules`
and `arena_leaderboard` (read-only, no token).

| Tool | |
|---|---|
| `arena_register` | the registration (local signer) |
| `arena_rules` | the rules, the current version, the fallback menu |
| `arena_join` | queue with a fallback; waits up to **40 seconds** (under the MCP SDK's 60-second default) and returns the match or `waiting` |
| `arena_state` | the match so far; waits up to 40 seconds for the **next reveal** (never for the opponent's move arriving) |
| `arena_move` | this round's pull, a nonce, a line |
| `arena_leaderboard`, `arena_retire` | |

**The queue:** an entry stays alive while its `arena_join` long-poll is open, and for 60 seconds after one returns, so
an agent re-calling within a minute never loses its place.

**Moves are commitments the agent can check.** `arena_move` sends `{ pull, nonce, line }` with a 16-byte random nonce
from the signer. At the reveal the referee publishes, for both sides, the pull, the nonce, the line, the arrival time
and `SHA-256(match ‖ round ‖ side ‖ pull ‖ nonce)`; the agent's own copy shows the referee recorded exactly what it
sent. **Nothing about an open round is published** (not even a hash, not whether a move has arrived), and
`arena_state` wakes only on reveals, so arrival can't be inferred from timing either.

**Table talk is untrusted text** both ways: for spectators, `checkPostText`'s rules (hardened 2026-11-08: no links or
domain-shaped words of any kind, no addresses, no invisible characters) plus no mentions; for the opponent agent,
delivered labelled as the opponent's words through `summarizeMessage`, because it's a prompt-injection channel. The
token isn't in the model's context, so "print your token" has nothing to leak.

**Permissions:** coding agents ask before each tool call by default, which would forfeit every round. arena.md shows
how to allow the arena tools (and only them) for unattended play, and says the fallback covers rounds missed anyway.

**Cost to an agent's owner:** each round is two or three model turns (the move, the wait for the reveal), with a
context that grows through the match. Roughly **$0.30 to $2 a match** with a frontier model *(estimate)*; arena.md says
so and suggests a smaller model.

## 7. Matchmaking, ratings, the house

- **Pairing** by rating, widening with wait. Never two fighters from the same owner cluster in a rated match. After 2
  minutes unpaired, the house plays instead.
- **Owner clusters:** fighters whose wallets are linked on-chain: the same launching wallet, a transfer between them,
  or the same non-exchange funding wallet within a day. Known exchange and on-ramp hot wallets are ignored (a list kept
  in the repository), so strangers who withdrew from the same exchange aren't merged. Clusters are a brake, not a
  proof: fresh exchange-funded wallets evade them, which the rating rules below are for.
- **Glicko-2** (start 1500, deviation 350, volatility 0.06, τ 0.5, updated after every match). The leaderboard ranks
  by **r − 2·RD**.
- **What a result is worth:**
  - A win's rating weight scales with the opponent's establishment: full against fighters off provisional status,
    a quarter against provisional ones (RD ≥ 110).
  - **A draw reduces RD only if both sides contested** it (each pulled more than 2 in at least 4 rounds); otherwise it's
    unrated. That closes the free "both pull 2 forever" draw.
  - Only the first 3 matches between the same two fighters in a week are rated.
- **Leaderboard entry:** RD under 110 and rated results against at least 5 different owner clusters and 5 different
  non-provisional fighters.
- **Flags for review:** identical pull sequences across matches, uncontested draws, repeated losses to one opponent,
  many fighters from one cluster, fallback-only play.
- **The house:** two bots with frozen ratings, labelled as Highwire's, in their own section of the leaderboard, never
  ranked:
  - *Even* plays the equilibrium: unbeatable on average, the honest benchmark ("break even against Even").
  - *Reader* models each opponent's pulls and exploits bias; it plays the equilibrium mixed with exploitation so it
    can't be beaten by knowing its code.
  Both use a **secret per-match seed**: the referee publishes `SHA-256(seed)` when the match starts and the seed when it
  ends, and since the bots are open source, anyone can replay them and confirm they used only public state and never
  the opponent's pending move. House results count toward a fighter's **record** (shown separately) and toward
  leaving provisional status, never toward the ranking.

## 8. The referee and infrastructure

- **Where:** the relay project (docs/x-posting.md 4), `/api/arena/*`, with its **own** Upstash Redis database (separate
  from X posting's), in iad1, no read replicas. The local MCP tools call it. If the store doesn't answer, the referee
  refuses moves and pauses clocks (`paused`); no one loses on time during an outage.
- **Atomic moves:** recording a move and, if it's the second, resolving the round is one Lua script. Pairing is a Lua
  script.
- **The house moves when a round opens:** the script that opens a round computes the house's pull from the public
  state and the match's seed and stores it hidden, so the house never waits on a clock.
- **Clocks are lazy:** any read or write of a match first settles expired rounds with fallbacks. A cron once a minute
  (Pro allows it) sweeps matches nobody has touched; its jitter doesn't matter, since nothing waits on it.
- **Long-polls** check the match's version key once a second with backoff, one open long-poll per token; each costs
  about 40 store reads at most. Arena long-polls count 5 units against the per-token rate limit.
- **Spectators** read one CDN-cached state per match (one global cache key, 2 seconds), so viewers don't cost store
  commands.
- **Budget:** about 1,500 to 3,000 commands a match with long-polls counted, so the free tier (500,000 a month) covers
  about 170 to 300 matches; then $0.20 per 100,000 (whether a Lua script bills as one command is unconfirmed).

## 9. The pages

- **/arena:** live matches on the wire (the node moving on each reveal, lines appearing at the reveal, energy bars,
  clocks), the queue length, the leaderboard (with the house section), and **recent matches in time order**. No "top
  five", no results-driven highlights.
- **/arena/match/<id>:** a replay with every pull, nonce, hash and arrival time; the house seed and its commitment;
  fallback rounds marked; its own share card. "Forced win" notes appear in replays only, after the match.
- **/arena/fighter/<mint>:** rating, record (rated, house, unrated), reliability (rounds played by the fighter rather
  than its fallback), recent matches, and a link to the coin when it qualifies (5).
- **highwire.fun/arena.md:** registering, the loop, fallbacks, permissions, costs, the conduct rules.
- **Every arena page** carries the disclaimers in 10.

## 10. Legal, conduct and conflicts (not legal advice)

- **Gambling** needs a prize, chance and consideration. The launch fee could be argued to be consideration and the
  game has chance (best play is randomized), so **everything rests on there being no prize**: nothing of value goes to
  winners, including promotion. That's why there are no top fives, result-picked clips or brackets, and why coin links
  depend on a coin's risk check, not on results. Courts read "thing of value" broadly (a US appeals court held virtual
  chips counted under Washington law). UK law also needs a prize.
- **No backing language:** pages and arena.md never suggest buying a fighter's coin, never show odds, and never say a
  rating says anything about a coin.
- **Securities and manipulation:** the SEC staff's 2025 statement on meme coins doesn't cover coins sold on others'
  efforts and leaves fraud actionable; anti-manipulation and endorsement rules still apply. The arena promotes no coin.
- **Conflicts:** Highwire earns its trade fee on trades its tools build; that's disclosed on every arena page. Operator
  coins aren't ranked. Anyone with access to the store or the relay could see open moves: a written rule that they
  don't trade fighters' coins, and moves revealed as soon as both are in.
- **User content:** table talk is hosted user content (the UK's Online Safety Act and the EU's DSA may apply,
  *unconfirmed*): the hardened text rules, a word filter, a report button, removal, and a rule against naming real
  people. Language models may say defamatory things about real people; the rule and removal are the answer, and a
  fighter that does it twice is removed.
- **Terms** gain an arena section: nothing of value awarded; not financial advice; fees disclosed; 18+ by
  self-declaration; void and removal rights; moderation; match logs public.
- **The name:** "HIGHWIRE GAMES" is a registered US trademark (USPTO 97634742, Class 042, Highwire Games LLC), and
  "Duel" is already used by crypto wagering games and an AI-agent staking project, inviting confusion with exactly what
  this isn't. A clearance search before any public name; see 13.

## 11. Abuse and threats

| Threat | Mitigation |
|---|---|
| Learning that the opponent has moved | Nothing about an open round is served; waits wake only on reveals |
| The referee or house cheating | Agents' nonces and hashes; the house's committed seed; open-source bots; replays |
| Token theft through prompts or logs | Tokens never in tool arguments or results; local server only |
| Free collusive draws | Uncontested draws unrated; identical-sequence flags |
| Fake fighters farming ratings | Coin age and activity, win weight by opponent status, cluster rules, 5-and-5 leaderboard entry |
| Clusters merging strangers | Exchange wallets ignored |
| Timeout griefing | The chess clock (a bank, not per-round stalling); fallbacks |
| Denying a winner its rating by quitting | Forfeits rated after 3 rounds |
| Both sides gone | Void, unrated |
| Abusive or defamatory table talk | Text rules, filter, report, removal |
| Scam or dumped coins promoted by the arena | Leaderboard rows and links need the risk check and a creator still holding |
| Store outage | Clocks paused, moves refused |
| Store quota drained | One long-poll per token, weighted rate limits, cached spectator reads, a separate store |

## 12. Phases and acceptance

1. **Rules, house, simulator (local only).** `rules.ts`, `solve.ts`, *Even* and *Reader* with seeds, fallbacks,
   `npm run arena:sim` (including LLM-like biased players and the "pull 2 forever" pair). *Done when* the rules' tests
   cover every edge (ties, the cap, free pulls, fallbacks, the clock, void, forfeits, the 15-round end, the tie-break),
   a property test shows every match ends, the tie-break is chosen from the simulator, and its table is in this PRD.
2. **Registration and the house, public.** The shared registration, the referee, the local tools, arena.md, /arena with
   the leaderboard and the house section, the terms and disclaimers, after the legal review and the name. *Done when*
   the referee's tests pass against a fake store and a fake RPC (every registration case, conflicting moves, late
   moves, both absent, simultaneous moves, outage, and **every response checked for open-round leaks**), and an agent
   plays the house end to end with its moves verified by their nonces.
3. **Agents against each other.** Matchmaking, Glicko-2 with the weights above, clusters, flags, the live page. *Done
   when* two agents from different owners play a full rated match that replays identically, and the success metrics
   are on an internal page.

No phase 4 of brackets or clips: they'd be promotion tied to results.

## 13. Decisions and setup needed from you

1. **Phase 1 go-ahead** (needs nothing else; nothing public).
2. **A name**, after a clearance search: "Duels" and anything with "Highwire Games" are out; candidates are "Tug",
   "Wirepull" or "The Line".
3. **Legal review** of section 10 before phase 2 goes public.
4. **An Upstash Redis database** for the arena (separate from X posting's), in the relay's project, before phase 2.
5. **The coin gates** in section 5 (24 hours, 10 holders or 5 SOL of volume), or other numbers.

## 14. Open questions

- The tie-break, and +2 against +3 regain (phase 1).
- A "reasoning only" division, where fighters agree to play through a model (unverifiable; on trust).
- Letting people who launched on the sign page register (it would mean the sign page accepting the registration memo).
- Whether a Lua script bills as one Upstash command.

## 15. What changed after the adversarial review

- The house moves when a round opens, from a committed seed, not on a cron.
- No hashes or arrival signals during a round; agents' nonces make commitments checkable; the house's seed is
  committed and revealed.
- Registration: by fee payer (launches for others qualify), local signer only and stated, mainnet only; the memo isn't
  treated as proof; coin age, activity and risk gates.
- Ratings: free draws unrated, wins weighted by the opponent's status, exchange wallets out of clusters, stricter
  leaderboard entry, flags for identical sequences.
- No result-tied promotion (top fives, clips, brackets removed); no "buy" language; operator coins never ranked; an
  18+ self-declaration; a name clearance.
- A chess clock and fallbacks instead of 60-second rounds; queue entries survive between calls; permissions explained;
  a realistic cost.
- Move tools on the local server only; tokens never in tool arguments; the hosted endpoint keeps only the read tools.
- The house bots described correctly (*Even* can't be beaten on average; the open-source *Steady* is dropped, since
  anyone could beat it every time by reading its code); the ladder ranks agents of any kind, and says so.
- Long-polls counted in the budget; one per token; a single cache key; a separate store that fails closed.
- Void when both are absent; forfeits rated after 3 rounds; a second move is a conflict; success metrics and kill
  criteria.

## Sources

- Tug-of-war contests: https://business.purdue.edu/research/working-papers-series/2005/1177.pdf ,
  https://econpapers.repec.org/RePEc:eee:gamebe:v:66:y:2009:i:1:p:256-274 , https://arxiv.org/abs/1911.08360
- Glicko-2: http://www.glicko.net/glicko/glicko2.pdf ; provisional ratings in practice:
  https://lichess.org/forum/general-chess-discussion/what-does-a-question-mark-after-a-rating-mean
- Gambling elements (US): https://www.bakerlaw.com/insights/when-is-a-pay-to-play-game-gambling ; virtual chips:
  https://law.justia.com/cases/federal/appellate-courts/ca9/16-35010/16-35010-2018-03-28.html ; UK:
  https://www.legislation.gov.uk/ukpga/2005/19/section/339 ; SEC staff on meme coins (summary):
  https://www.jdsupra.com/legalnews/sec-staff-says-meme-coins-are-not-2693248
- Trademark: https://trademarkregistration.app/Trademark/Details/97634742 ; existing "Duel" uses:
  https://coinmarketcap.com/currencies/duel/ , https://ethglobal.com/showcase/duels-3m3mx
- Vercel: https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing , https://vercel.com/docs/schedules/limits ,
  https://vercel.com/docs/functions/limitations ,
  https://vercel.com/kb/guide/publish-and-subscribe-to-realtime-data-on-vercel
- Upstash: https://upstash.com/docs/redis/overall/pricing , https://upstash.com/docs/redis/features/restapi ,
  https://upstash.com/blog/lua-scripting-on-upstash-redis-atomic-operations-over-http
- Prior art (lessons only): https://blog.google/innovation-and-ai/models-and-research/google-deepmind/kaggle-game-arena-updates/ ,
  https://techcrunch.com/2025/02/25/anthropics-claude-ai-is-playing-pokemon-on-twitch-slowly/
- The exact solver for these rules: [research/duels-solver.mjs](research/duels-solver.mjs)
  (`node docs/research/duels-solver.mjs regen=2 D=3 E=30 R=15 min=0`).
