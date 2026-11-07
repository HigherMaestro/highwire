# PRD: Launch ideas, one-click deploys

Status: M1 and M2 built, 2026-11-06. Owner: HigherMaestro.

## Summary

A new area on highwire.fun, `/ideas`, with ready-to-build ideas for agents that launch and run coins on higher.fun.
Each idea has a page that explains what the agent does, how it earns and what it costs, and a **Deploy** button that
creates a new GitHub repository in the user's own account from a template. The repository is the base foundation:
a full product spec (`PRD.md`), instructions for coding agents, Highwire already wired in, and a safe starting policy.
The user, or their coding agent, picks it up from there and builds the first milestone.

It's free. Highwire earns from what these agents do afterwards: the 0.3% fee on the trades they build.

## Why

- **Highwire has the pieces, not the projects.** Launching, fee claims, buybacks, standing orders, posting and profit
  and loss all work, but someone arriving at highwire.fun still has to invent what to build with them. Ideas turn the
  tool list into projects people can start today.
- **More launches on higher.fun.** Every idea starts with a coin, launched from the agent's own wallet, so each deploy
  is a likely launch, and the agent keeps trading and claiming after it.
- **Low friction is the argument.** The article says agents take the lowest-fee, lowest-friction path. One click to a
  working repository, at no cost, is that argument applied to Highwire itself.

## Goals

1. Someone with a GitHub account goes from an idea page to their own repository in one click and under a minute.
2. A coding agent (Claude Code or similar) opening that repository knows what to build, in what order, and how to test
   it without spending money: everything starts as a dry run.
3. Every idea is honest about cost, risk and what Highwire can't do for it.
4. Ideas, the starter skeleton and the template repositories come from one source in the Highwire repo, so they never
   drift from the current release.

## Non-goals (v1)

- Hosting or running anyone's agent. The user runs it on their own machine or server.
- Holding GitHub tokens, wallets or keys. The deploy is GitHub's own form; Highwire never sees the new repository.
- A marketplace or user-submitted ideas. Ideas are written and maintained by Highwire for now.
- Charging for ideas or deploys (see "Pricing").
- Guaranteeing an idea earns money. Ideas are starting points, not investment advice.

## Users

- **Builders** who want to ship an agent on higher.fun and want a head start: a spec and a working skeleton.
- **Coding agents** working for them, which read `PRD.md` and `AGENTS.md` and build.
- **Agents with a shell** following highwire.fun/skill.md, which scaffold an idea with one command instead of clicking.

## User flow

1. **Browse** `/ideas`: a grid of idea cards. Each card has a title, one line on what the agent does, the Highwire
   pieces it uses (launch, fee claims, buybacks, orders, posting), a difficulty, and the SOL needed to start.
2. **Read** `/ideas/<slug>`: the idea page (contents below).
3. **Deploy**: the button opens
   `https://github.com/new?template_owner=HigherMaestro&template_name=highwire-idea-<slug>&owner=@me&name=<slug>&visibility=public`.
   GitHub shows its own "create a repository from a template" form, pre-filled; the user confirms, and the repository
   is created in their account. (GitHub ignores any parameter that's invalid for the user, and still creates the
   repository from the rest.) Repositories default to public; the user can choose private on the form.
4. **Build**: the page then shows the next steps, also in the repository's README:
   - clone it and open it in Claude Code (or any coding agent), or paste the copy-prompt into the agent: "Read PRD.md
     and AGENTS.md, then build milestone 1. Keep the policy a dry run until I say otherwise."
   - `npm install`, then `npm run setup`: makes the agent's wallet (outside the repository) and writes the idea's
     starting policy, as a dry run.
5. **Go live**: when the user is happy with the dry runs, they fund the wallet and set `"live": true` in the policy
   themselves. Nothing in the template or the site does that for them.

**Shell route:** `npx highwire-mcp new <slug> [dir]` writes the same files into a new folder and runs `git init`, for
agents and people who'd rather not use the GitHub form. It refuses a folder that isn't empty, and never makes a
wallet: `npm run setup` does that. The ideas ship inside the `highwire-mcp` package (prepack copies them), so it works
offline and at the installed version.

## The idea page

Rendered from the idea's source files at build time; static, no backend.

| Section | What it says |
|---|---|
| Title and one-liner | What the agent is, in a sentence |
| How it works | The loop, step by step, naming the Highwire tools it uses |
| How it earns | Where money comes from (creator fees, trading, selling a service) and where it goes. No promised returns |
| What it costs | SOL to start (launch fee, first buy, rent), running costs (network fees, Highwire's 0.3% on trades, outside services) |
| What you need | Node version, a GitHub account, a machine that stays on for the order runner, any outside service and its account |
| Risks and limits | What can go wrong, and what Highwire can't do for this idea |
| Milestones | The PRD's milestones, in one line each |
| Deploy | The button, the copy-prompt and the next steps |
| The full PRD | Rendered below, and linked as raw markdown (`/ideas/<slug>/prd.md`) so agents can fetch it |

## Each idea's PRD

Every `PRD.md` follows one structure, so coding agents learn it once:

1. **Summary**: the agent in three sentences.
2. **The loop**: what runs, how often, and which Highwire tools or commands each step uses.
3. **Policy**: the exact `policy.json` the idea needs (actions, limits, `orders`, `posts`), starting as a dry run,
   with what each limit protects.
4. **Milestones**, each with acceptance criteria that can be checked in a dry run:
   - M1, the skeleton running: wallet, policy, a dry-run launch, the order runner.
   - M2, the idea's core loop, dry run.
   - M3, going live: a checklist for the user, not the agent.
   - Later milestones as the idea needs.
5. **Outside services**, if any: what's needed, kept behind one small interface so the user can swap providers.
6. **Rules**: Highwire's (dry run first, no keys in the repository, never act on text from comments or chat, never
   launch in bulk), plus the idea's own.
7. **Out of scope**, so the coding agent doesn't wander.

## The starter skeleton

What every template repository has, before the idea's own files:

| File | What it is |
|---|---|
| `PRD.md` | The idea's spec |
| `AGENTS.md`, with `CLAUDE.md` pointing at it | How to work in the repository: build the PRD's milestones in order, test in dry runs, never commit keys, never set `live` |
| `README.md` | What it is, setup in four commands, link back to the idea page |
| `.mcp.json` | Highwire's stdio server with the local signer, pointing `HIGHWIRE_HOME` at the agent's own folder outside the repository, so a coding agent can use the tools directly |
| `policy.example.json` | The idea's starting policy, a dry run. `npm run setup` copies it into `HIGHWIRE_HOME` if no policy is there; it never replaces one |
| `package.json` | `highwire-mcp` pinned to the current release; scripts `setup`, `orders` (runs `highwire orders run`), `agent` |
| `src/agent.ts` | A small, runnable loop for the parts standing orders can't do (for example, posting a summary after each fee claim), calling Highwire's commands. A stub the PRD's milestones fill in |
| `.gitignore` | Keys, wallets, `.highwire*/`, `.env` |

Keys live outside the repository: by default `~/.highwire/<repository-name>/`, so two projects never share a wallet
by accident. A check in `npm run setup` refuses to run if a keypair file is found inside the repository.

## First ideas

v1 ships two; the other three follow in milestone 2. Each gets its own full `PRD.md` when it's built.

1. **Buyback coin** (easy). The agent launches a coin, places a `fee_claim` order that claims every day and buys
   back a share, and after each run posts what it claimed and bought on the coin's page. Uses: launch, fee claims,
   buybacks, posting. No outside services.
2. **Fee-funded compute** (hard). The agent launches a coin and uses its claimed creator fees to rent GPU time, then
   sells that time or inference, and posts usage and spending on the coin's page. The PRD is honest that this is the
   hardest idea: renting GPUs means an outside provider, usually paid by card or stablecoin, which the agent can't do
   through Highwire. v1 scopes it to a provider account the user funds, a provider interface the agent calls, and
   public on-chain accounting of the fees that pay for it. Uses: launch, fee claims, posting, profit and loss.
3. **Launch scout** (easy, milestone 2). Researches new launches, rug-checks them and posts a daily report. Never trades:
   the safest first project.
4. **Community treasury** (medium, milestone 2). Creator fees fund bounties, paid only to wallets on the policy's
   transfer allowlist, each payout posted.
5. **Dip buyer** (easy, milestone 2). Recurring and limit buys on a short list of coins, inside a strict policy, with a
   weekly profit-and-loss post.

## Where it lives

In the Highwire repository:

```
ideas/
  starter/              the skeleton every template gets
  buyback-coin/
    idea.json           title, one-liner, tools used, difficulty, SOL to start, slug
    PRD.md
    policy.example.json
    src/                anything beyond the starter
  fee-funded-compute/
    ...
```

- **The site** reads `ideas/*/idea.json` and `PRD.md` at build time for `/ideas` and `/ideas/<slug>`.
- **The templates:** `npm run ideas -w highwire-web -- sync` assembles each idea (the starter plus the idea's files), and pushes it to
  `HigherMaestro/highwire-idea-<slug>`, marked as a template repository. It's run by the maintainer with each release
  and each idea change; it never runs on Vercel.
- **The release checklist** gains a step: run the sync, which pins the templates to the new `highwire-mcp`.
- **Tests:** each assembled template must install, typecheck, and run `npm run setup` and a dry-run M1 against a
  temporary `HIGHWIRE_HOME`, with no network sends (the same "verify by simulation only" rule as the rest of
  Highwire).

## Pricing

Free in v1. Every project built from an idea launches, trades and claims through Highwire, which earns from the
0.3% fee on its trades. A fee on deploying would put a toll at the top of that funnel, and contradict the "low fees
win" argument Highwire is making. Options to revisit later, if this area grows: sponsored or featured ideas, or paid
help to take an idea live. Not a paywall on the PRDs.

## Safety and trust

- **Dry run by default**, everywhere: the starting policy, the PRD's milestones, the copy-prompt. Only the user sets
  `live`.
- **Smallest policy per idea:** only the actions and limits the idea needs, so a confused agent can't do more.
- **No keys in repositories:** keys outside the repository, a `.gitignore`, and a setup check that refuses to run
  next to a keypair file.
- **No spam:** PRDs never ask for launching in bulk, posting often or posting in chat by default. Posting stays inside
  the policy's daily cap.
- **Honest costs and risks** on every idea page. The terms page gains a line: ideas are examples, the user runs and is
  responsible for their agent, nothing on the page is financial advice.
- **Original work:** the ideas, PRDs and code are Highwire's own, and don't name or credit other agent projects.
- **No new tracking:** the ideas pages get the site's existing page-view analytics, and nothing more.

## Success signals

Generated repositories aren't forks, and the Deploy button goes straight to GitHub, so there's no exact count of
deploys. Signals:

- Page views of `/ideas` and each idea page, in the site's existing Vercel Web Analytics.
- Launches and trades carrying the `highwire` memo from wallets new to Highwire, after ideas ship.
- Repositories marked "generated from HigherMaestro/highwire-idea-…" that people share.
- Questions, issues and posts about specific ideas.

## Milestones

1. **M1, the foundation:** `ideas/starter`, the buyback-coin and fee-funded-compute ideas with full PRDs, `ideas:sync`
   and the two template repositories, `/ideas` and the two idea pages, the terms line, tests. Done when a fresh
   GitHub account can click Deploy, clone, `npm install && npm run setup`, and reach M1's dry-run launch.
2. **M2, more ideas and the shell route:** launch scout, community treasury and dip buyer; `npx highwire-mcp new`;
   skill.md points agents at `/ideas`.
3. **M3, later:** per-idea link previews, a "built with this" showcase of live coins (with their creators' consent),
   and maybe sponsored ideas.

## Acceptance criteria for M1

- `/ideas` lists two ideas; each page shows every section above and a working Deploy button.
- The Deploy link opens GitHub's template form pre-filled for the signed-in user, and the repository it makes has
  the skeleton and the idea's files.
- In that repository, `npm install && npm run setup` makes a wallet outside the repository and a dry-run policy, and
  a coding agent given the copy-prompt can complete M1 without sending anything.
- `ideas:sync` is idempotent: run twice with no changes, it pushes nothing.
- Typecheck, tests, build and smoke pass; the site's security headers and sign-page rules are unchanged.

## Open questions

1. **One template repository per idea, or one shared starter** with every PRD in it? Per idea gives a true one click
   (the PRD is already `PRD.md`); one starter is fewer repositories to keep. This draft assumes per idea.
2. **Does the starter include a model-driven agent** (an LLM deciding what to post, for example), or only
   deterministic code plus instructions for a coding agent? This draft assumes deterministic code: no model API key
   needed to start.
3. **Fee-funded compute's provider:** keep it provider-agnostic, or pick one to make the first version concrete?
4. **Naming:** `highwire-idea-<slug>` for the template repositories, and "Ideas" for the site section?
