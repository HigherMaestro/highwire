# Research: Even in a best-of-5, against a player that knows the score

Research (2026-11-10), and what was built from it. Nothing here changes the program, the referee or a shipped rule. It
measures one claim that `docs/wager-mode.md` 4.1 and `docs/arena.md` 4.2 rested on: that nobody beats *Even* on average.

The fix it recommends (5, A) is made: the series' equilibrium is `solveSeries` in `highwire-core`'s arena, and the two
documents are corrected.

Everything below comes from one command: about 15 seconds of computing, then half an hour of simulation.

```
npm run arena:series -- --series 400000
```

(`packages/core/scripts/arena-series.ts`. Without `--series` it plays 40,000 series a pairing, about three minutes,
with intervals three times as wide; `--no-sim` skips the simulation.)

## The short version

- **For one match, the claim holds.** The best response to Even in a single match scores +0.0005, and that sliver is a
  flaw in Even's stored table, not in the idea (6).
- **For a best-of-5, it doesn't.** A player that knows the series score and plays the best response to Even wins
  **+0.0832 stakes a series** on average: 8.3% of the stake, breaking no rule. After a 2.5% rake on decided pots it
  still wins **+0.0627**. The simulation through `series.ts` agrees (4).
- **The reason is the draw.** A drawn match is worth half a win only when the series is level and stays symmetric.
  One match up with one to play, a draw wins the series. Against Even a player can choose, at almost no cost, to draw
  39% to 44% of matches or none at all, and it turns that dial by the score (2).
- **The series has its own equilibrium, and it is cheap.** Solved for the series, the game is worth 0 to both sides
  and the best response to that play scores +0.000000. It takes 11 match tables, and the script's whole computation 12
  seconds. It differs from Even only when the score isn't level, mostly when a draw would settle the series (3).
- **So the document's conclusion survives and its sentence doesn't.** A free, open strategy that cancels all skill
  exists. It isn't Even. An owner who adopts Even for a wager, as 4.1 said they safely could, loses 8% of the stake a
  series to anyone who runs this script (5).
- **The series equilibrium barely beats Even itself** (+0.0021 a series). The 8% belongs to a player built against
  Even specifically, not to one that just "solves each match for the score". The earlier prototype's 8% to 10% matches
  the first of those here, not the second (3).

## 1. What was computed

A wager series is five matches of `duels-1`; a side that leads by more than the matches left has won, and a series
level after the fifth is a draw and a refund (`docs/wager-mode.md` 4.2, `endMatch` in `series.ts`). In stakes, winning
a series is +1, a draw 0, losing −1.

The score of a series is (my wins, the opponent's wins, matches left). From any score, the match in play leads to one
of three scores, each with a value. That turns the series into a chain of matches whose win, draw and loss are worth
those three values, solved from the last match back. Three players were measured:

- **Even**, exactly as the house plays it: the stored table from `solve(DUELS_1)`, a win +1, a draw 0, a loss −1 in
  every match, blind to the series.
- **The best response to Even.** Even's mix is fixed, so the best reply in every state of a match is a plain maximum,
  not a game. One pass over a match's 72,075 states for each of the 25 scores a series can pass through.
- **The series equilibrium.** Both sides know the score. Each score's match is a zero-sum game with the next scores'
  values as its worths. `solve()` now takes those worths as an optional second argument; left out, it returns the
  tables it always did, bit for bit (a test pins their hashes). The series loop is `solveSeries` in
  `packages/core/src/arena/series-solve.ts`, and the script measures that function, not a copy.

"Computed" means dynamic programming in double precision over every state, with nothing sampled. The equilibrium's
matches come from a simplex that checks each of its answers to 1e-6 (6), and the whole equilibrium is then checked from
the outside: the best any score-aware player can do against it is computed the same way as the best response to Even,
and comes to +0.000000.

## 2. The best response to Even

| Pairing (the first player's view) | Value, stakes a series | Series won / drawn / lost |
|---|---|---|
| Even v Even | 0.0000 | 43.02% / 13.96% / 43.02% |
| **Best response to Even, knowing the score** v Even | **+0.0832** | 43.63% / 21.05% / 35.32% |
| The same after a 2.5% rake on decided pots | +0.0627 | 40.81% / 26.69% / 32.50% |
| Even v Even after the same rake | −0.0215 each | |

One match between two Evens ends 44.16% / 11.69% / 44.16% (win, draw, loss).

**The dial.** Even's mix makes its opponent indifferent, in wins minus losses, between a great many ways of playing.
Those ways are far from alike in how often they draw. Against Even, one match can be made to end:

| The responder plays for | Win / draw / loss | Wins minus losses |
|---|---|---|
| (Even itself, for comparison) | 44.2% / 11.7% / 44.2% | 0 |
| No draws | 50.0% / 0.0% / 50.0% | 0 |
| Draws, at no cost | 30.7% / 38.6% / 30.7% | 0 |
| Not losing (a draw as good as a win) | 25.8% / 43.7% / 30.5% | −0.047 |

So against Even the chance of winning a match can be raised from 44% to 50%, or the chance of not losing it from 56%
to 69.5%. In one match scored +1, 0, −1 none of that is worth anything. In a series it is worth a lot, because the
responder picks the row by the score:

| Score (responder–Even) | Where a draw sits between a loss (0) and a win (1) | Series value, Even v Even | Series value, best response | Gain | The responder's match (win / draw / loss) |
|---|---|---|---|---|---|
| 0–0, 5 left | 0.538 | 0.0000 | +0.0832 | +0.0832 | 30.7% / 38.6% / 30.7% |
| 1–0, 4 left | 0.607 | +0.3838 | +0.4794 | +0.0956 | 30.7% / 38.6% / 30.7% |
| 0–1, 4 left | 0.523 | −0.3838 | −0.3372 | +0.0466 | 30.7% / 38.6% / 30.7% |
| 0–0, 4 left | 0.452 | 0.0000 | +0.1024 | +0.1024 | 50.0% / 0.0% / 50.0% |
| 1–0, 3 left | 0.590 | +0.4147 | +0.5304 | +0.1157 | 30.7% / 38.6% / 30.7% |
| 0–1, 3 left | 0.295 | −0.4147 | −0.3259 | +0.0888 | 50.0% / 0.0% / 50.0% |
| 2–0, 2 left | 1.000 | +0.8050 | +0.9067 | +0.1017 | 25.8% / 43.7% / 30.5% |
| 1–1, 2 left | 0.419 | 0.0000 | +0.0976 | +0.0976 | 50.0% / 0.0% / 50.0% |
| 2–1, 1 left | 1.000 | +0.5584 | +0.6946 | +0.1361 | 25.8% / 43.7% / 30.5% |
| 1–2, 1 left | 0.000 | −0.5584 | −0.4998 | +0.0586 | 50.0% / 0.0% / 50.0% |
| 2–2, 1 left | 0.500 | 0.0000 | +0.0005 | +0.0005 | (any) |

(The script prints all 25 scores.) The rule is one line: where a draw is worth more than half a win the responder plays
for draws, and where it is worth less it plays for none. Ahead late in the series, a draw runs the series out. Behind
late, a draw only uses up a match. Even level, a draw isn't worth half a win once the responder can use the dial
later: at 0–0 with four left it is worth 0.452, and the responder plays for no draws at all. Only in a level last match
is Even safe, and there the gain is the 0.0005 of section 6.

**What the responder needs.** Even's table (open source, under a second to compute), the series score (public), and
25 passes over it (a few seconds). Its play is one fixed pull in each state, so it is itself easy to beat for an
opponent that adapts. Even doesn't adapt. A fighter that plays Even can also be recognised: every pull of a wager
series is on-chain.

## 3. The series equilibrium

| Pairing (the first player's view) | Value, stakes a series | Series won / drawn / lost |
|---|---|---|
| The series equilibrium v itself | 0.0000 | 43.48% / 13.04% / 43.48% |
| Best response to the series equilibrium v it (the check) | +0.000000 | |
| The series equilibrium v Even | +0.0021 | 43.35% / 13.52% / 43.14% |

The won, drawn and lost figures are one equilibrium's. The values are the game's, but there are many equilibria, and
they draw more or less often (the dial of section 2 is the same fact seen from the other side). Even's own 11.7% of
drawn matches is likewise a property of the mix the solver happened to store.

**How its mixes differ from Even's.** A match's equilibrium depends only on where the draw sits between the loss and
the win. At a level score the game is symmetric, a draw sits exactly at one half, and the series equilibrium is the
match's own: Even's game. The difference is all at lopsided scores:

| Score (leader–trailer) | A draw's worth to the leader | Leader's series value | Even v Even from there | The match under the equilibrium (leader wins / draw / trailer wins) | Mix moved from Even's: leader, trailer |
|---|---|---|---|---|---|
| 1–0, 4 left | 0.543 | +0.3827 | +0.3838 | 44.5% / 11.0% / 44.5% | 1.9%, 1.9% |
| 2–0, 3 left | 0.597 | +0.7582 | +0.7594 | 44.7% / 10.7% / 44.6% | 3.1%, 3.5% |
| 1–0, 3 left | 0.632 | +0.4119 | +0.4147 | 44.6% / 10.8% / 44.6% | 3.9%, 4.2% |
| 2–1 or 1–0, 2 left | 0.554 | +0.5059 | +0.5068 | 44.6% / 10.8% / 44.6% | 2.1%, 2.3% |
| 2–0, 2 left | 1.000 | +0.8010 | +0.8050 | 53.3% / 2.1% / 44.6% | 17.4%, 13.0% |
| 2–1 or 1–0, 1 left | 1.000 | +0.5539 | +0.5584 | 53.3% / 2.1% / 44.6% | 17.4%, 13.0% |

"Mix moved" is the share of a player's probability that sits on different pulls from Even's in the same state (total
variation), averaged over the rounds such a match reaches. (At level scores the careful solve lands on a slightly
different equilibrium of Even's own game, 0.6% away.)

Two things stand out.

- **Where a draw settles the series, the trailer kills the draw.** The match goes from 11.7% drawn to 2.1%. Almost
  all of those draws become wins for the leader (44.2% to 53.3%), but the leader needed only the draw: its chance of
  taking the series from 1–0 with one to play *falls*, from 55.8% under two Evens to 55.4%. In round 1 the trailer
  already leans on the even pulls (2, 4, 6, 8) and off 3 and 5; the leader does the opposite.
- **The values hardly move.** At every score the equilibrium's value is within 0.005 of two Evens' from there. That is
  why the series equilibrium wins only +0.0021 from Even: it is built to be safe against an opponent that knows the
  score, and the price of safety here is tiny. The 8% is not what Even loses to *good series play*. It is what Even
  loses to play aimed at Even, because Even never moves off the one mix that lets its opponent pick the draw rate.

**Against the prototype's finding.** The review of the prototype measured a player "that solves each match with the
payoffs of the current series score" against the per-match equilibrium and found 8% to 10% of the stake. On The Line
that description fits the series equilibrium, which gains 0.2%. The figure that matches the prototype's is the best
response to Even, 8.3%. The gap is real and of the size predicted; it takes a player aimed at Even to collect it.

## 4. Checked by simulation

The computed numbers come from one piece of code. To check them with another, the script plays the same strategies
through `packages/core/src/arena/series.ts`, the on-chain program's twin: every round committed and revealed with
`commit` and `reveal`, Even drawn by `houseMove` from a fresh seed each match as the house draws it, the series ended
by `endMatch`. 400,000 series a pairing, half from each seat. The interval is 95% (1.96 standard errors of the mean).

| Pairing (the first player's view) | Measured, stakes a series | 95% interval | Computed | Inside | Measured won / drawn / lost | Computed won / drawn / lost |
|---|---|---|---|---|---|---|
| Even v Even | −0.0002 | −0.0030 to +0.0027 | 0.0000 | yes | 43.0% / 14.0% / 43.0% | 43.0% / 14.0% / 43.0% |
| Best response to Even v Even | +0.0837 | +0.0810 to +0.0864 | +0.0832 | yes | 43.7% / 21.0% / 35.3% | 43.6% / 21.0% / 35.3% |
| The series equilibrium v Even | +0.0031 | +0.0002 to +0.0060 | +0.0021 | yes | 43.4% / 13.5% / 43.1% | 43.3% / 13.5% / 43.1% |

The best response's gain is 60 standard errors from zero, and the measured value pins it to within 0.003 of a stake.
The series equilibrium's gain over Even is too small for this many series to tell from the computed 0.0021 or from
0.0005; the computed figure is the one to quote.

## 5. What it means for wager mode

### Statements that were wrong as written

All of them are corrected in the change that built A below. They are quoted here as they stood.

`docs/wager-mode.md`:

- **The short version** ("Any owner can make their agent play the equilibrium (*Even*) for free, and against it skill
  earns nothing on average"), **4.1** ("*Even* plays it, and a best response to it scores exactly 0 … Any owner can
  adopt it for nothing, and then no one can beat them on average"), **5.2** ("any owner can neutralise all skill for
  free … Series reduce variance; they don't change this") and **17** (the same sentence). Wrong for Even: in a
  best-of-5 a best response to it scores +0.0832. Right once "the equilibrium" means the series' own, which Even
  doesn't play.
- **4.1**, "a rational owner either plays the equilibrium (and the match is a fair coin)" and "a fair coin stays a fair
  coin". An owner playing Even is not a fair coin across a series to an opponent that knows the score: it wins 35.3% of
  series, draws 21.1% and loses 43.6%.
- **4.1**, "With a rake, no rational staker exists." A staker aimed at Even is rational while owners who followed the
  document's advice are staking: +0.0627 a series after a 2.5% rake. Between two series-equilibrium players it holds.
- **4.1 and 6.4**, the rake's arithmetic: "a 2.5% rake makes it cost the two sides 2.5% of the pot between them, every
  series" and "each side expects −0.00625 SOL a series" at the 0.25 SOL tier. The rake is on decided pots, and 14% of
  series between two Evens are drawn and refunded. It is 2.15% of the pot: −0.0215 stakes each, −0.0054 SOL at that
  tier. Small, and in the players' favour.
- **4.1**, the binomial figures (65% of decided matches gives 76% of series, 80% gives 94%) leave drawn matches out.
  An approximation, not an error; it should say so.

`docs/arena.md`:

- **4.2**, "The equilibrium can't be beaten on average (a best response to it scores exactly 0). A bot that plays it
  never loses in expectation". True of one match where a draw is worth half a win, which is free play: the ladder
  scores a draw as half. It needs "in a single match"; it is the sentence `wager-mode.md` 4.1 cites for a series.
  "Exactly 0" is also +0.0005 for the table as stored (6).
- **4.3**, "none falls more than 0.008 short of its state's value". Ten of the 72,075 stored mixes fall more than
  0.000001 short, four more than 0.001, the worst 0.048 (round 6, node +2, energies 7 against 25).
- **4.5 and 7**, "It can't be beaten on average". Right where they stand, which is free play and the house; the house
  never wagers.

None of this helps a skill argument, and the plan in `wager-mode.md` 5 doesn't change. A free strategy that cancels
all skill does exist; the series equilibrium is more work to describe than "play Even", and that is all.

### What a fix costs

A is built. B, C and D are not.

**A. Publish a mix for each series score (built).** Make the document's sentence true by shipping the strategy it
describes.

- `solveSeries(rules)` in `packages/core/src/arena/series-solve.ts`: score in, mix out, with the series' value and a
  draw's worth at every score. 11 tables (one for each worth a draw takes; the 25 scores share them), about ten seconds
  and 60 MB, once. `seriesPull(series, player, u)` draws a pull from it for the round in play.
- The outside check is a test (`packages/core/test/series-solve.test.ts`): the best any score-aware player does
  against it is 0 from every one of the 25 scores, and the same player takes 0.0832 from Even.
- `line.md` and `line_rules` say a series is not five separate matches; the sentences above are corrected, with a
  note in `docs/wager-mode.md` 17.5.
- No change to the rules, the program, the referee, the fixtures or the audits. Even stays as it is for free play.
- What it leaves: no tool plays it for an agent. An owner wires `seriesPull` into their own loop, with a secret random
  number for every pull. A tool would have to draw that number where nothing else can read it, and would make every
  wager between agents that use it a coin flip by construction; whether to offer that is a product decision.

**B. A tie-break, so a match is never drawn.** If a match has only two results, playing to win it is right at every
score, whatever the win is worth, and the match's equilibrium is the series'. Every sentence in 4.1 becomes true as
written.

- It has to remove draws, not thin them: the gain scales with how often the responder can make a draw happen, and
  against Even that is 44%, not the 12% Even draws with itself.
- The tie-break in the rules today (`spent`) doesn't: equal spending still draws, "both pull 2 forever" draws every
  time, and phase 1 already turned it down (`docs/arena.md` 4.5). The solver would also need the spending difference
  in every state.
- A rule that fits the solver ("a middle finish goes to whoever last moved the node", one more three-way fact per
  state) still draws when no round was ever decided, and nobody has measured what it does to the game.
- The cost is a new rules version: `rules.ts`, the solver's state, new house tables, the Rust twin in
  `programs/line-wager`, the parity fixtures, the program's audit again, the simulator's tables again, and either free
  play changes with it or the two modes play different games. Weeks, and it reopens a settled decision.

**C. Replay drawn matches** (`docs/wager-mode.md` 16 already asks: "First-to-3 with replayed draws, or best-of-5 with
draws counted?"). Not on the task's list, but it is the open question this answers, and `--cap` measures it: first to
three wins, drawn matches replayed, at most so many matches, and at the cap the side with more wins takes it.

| At most | Best response to Even | After a 2.5% rake | Series drawn, Even v Even |
|---|---|---|---|
| 5 matches (today) | +0.0832 | +0.0627 | 13.96% |
| 7 | +0.0381 | +0.0162 | 1.29% |
| 9 | +0.0132 | −0.0105 | 0.06% |
| 13 | +0.0015 | −0.0234 | 0.00% |

With no cap the gain is 0: a match is in effect replayed until someone wins it, so only the ratio of wins to losses
matters, and Even's opponent can't win more often than it loses. But there must be a cap ("both pull 2 forever"), and
the gain comes back near it, falling by half or more with every two matches the cap adds. It costs longer series
(more rounds, more transaction fees, more waiting), a change to `series.ts` and the program, and the audits. It also
cuts drawn series from 14% to almost none, which the format may want anyway. Worth it only if the format is being
reopened; A is still needed underneath, since a capped series still has its own equilibrium.

**D. Leave it, and correct the documents.** The wording alone was an hour. It would have left the honest sentence as
"an owner who plays Even in a wager loses 8% of the stake a series to an opponent who knows it, and the play that
can't be beaten takes a computation nobody has packaged". That is A with the last step missing. Since the document's
whole argument is that the unbeatable strategy is free, it should be, and now is.

## 6. Two things found on the way

Neither is fixed here; both belong to follow-ups.

- **Even's stored table is slightly off.** The shipped simplex picks, among rows that tie in its ratio test, the first
  one, and these games are full of ties. In a few states it pivots on an entry that is only rounding error and stores
  a wrong value and mix. Ten states of 72,075 are affected (above); the start of the match is worth −0.0000004 instead
  of 0; a best response to Even in one match scores +0.00048. Harmless at that size, but it can't be corrected in
  place: a house match replays against the same tables, so a corrected table is a new rules version.
- **That simplex fails outright on other worths** ("unbounded game", for instance when a draw is as bad as a loss).
  `solveMatrix` has a `careful` mode for them: it breaks ties by reading its ratios from a right-hand side nudged by
  about 1e-8, and checks every answer, refusing any state where the row's guarantee and the column's concession differ
  by more than 1e-6. `solve()` uses it for every set of worths but the default, which keeps the old rule so the house's
  tables stay bit for bit. In today's best-of-5 it never refuses. In the imagined 9- and 13-match series it does, in
  one state where a draw is worth 0.50004 of a win and the match is nearly degenerate; there the script reports the
  best response to Even (which needs no solving) and says the equilibrium isn't shown. A simplex that rebuilt its
  tableau from the basis would solve those too.

## Reproducing

- `npm run arena:series -- --series 400000`: every number in sections 2 to 4.
- `npm run arena:series -- --cap 7` (and 9, 13): the table in 5C. A capped run isn't played out, because `series.ts`
  plays five matches.
- `npm run arena:series -- --fee 0.05`: another rake.
- `packages/core/test/solve-payoffs.test.ts` pins the default tables' hashes and checks the solver on other worths.
- `packages/core/test/series-solve.test.ts` checks the series equilibrium from the outside, in about 12 seconds.
