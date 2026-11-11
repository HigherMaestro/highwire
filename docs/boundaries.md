# PRD: Boundaries inside the repository

Status: **approved 2026-11-10, with the recommended answer to each decision in 9. Phases 1 to 3 are built (the switch,
the package and its hooks, the deploy rule); the tag, the freeze and CI aren't.** Not legal advice: who may distribute or operate wagering software is
counsel's question (docs/wager-mode.md 5), and nothing here answers it.

Highwire started as an MCP server for higher.fun. It now also holds a game (The Line), a referee, a wager program and
the tools to stake on it. This document decides how to keep those apart **without splitting the repository**: what a
person gets when they install the MCP server, what a push to `main` deploys, and what an auditor is asked to read.

**The short version.**
- **One repository stays.** The game's rules and the wager program change together (the Rust replays fixtures the
  TypeScript writes), so two repositories would make every rules change a coordinated release.
- **Wagering becomes its own package, `highwire-wager`, that nobody gets by accident.** `highwire-mcp` 0.15.0 on npm
  registers `line_stake` and `line_wagers`, and describes them to the agent, for anyone who sets up the local signer.
  Staking still needs the owner's policy to allow it and the reveal daemon running, but every such agent is shown a
  tool that stakes SOL.
- **A switch first, the package second.** A default-off switch (`HIGHWIRE_WAGERS=1`, built) closes the gap in the next
  release.
  Moving about 2,300 lines into a package needs four extension points, and is the real work.
- **A push that can't change the site shouldn't deploy it.** One rule in `vercel.json`, written as a short list of
  paths that are safe to skip, so a mistake builds too often rather than too rarely.
- **The audit has its scope** since this was drafted (docs/audit/line-wager.md, and a reproducible build). What's left
  is a tag, a freeze while the audit is out, and the parity tests run by CI (there is none today).
- **A later split has one trigger:** a separate entity operating wager mode (docs/wager-mode.md 5.6). This design
  makes that a lift-out of one package and one part of the relay, and doesn't do it now.

## 1. Why now

| What | Today | The problem |
|---|---|---|
| Installing the MCP server | `npx highwire-mcp` with a signer registers the staking tools | a general higher.fun tool carries wagering, in every country, to people who never asked for it. docs/wager-mode.md 1 already says wagering is "a separate module (`line-wager`), never on by default" |
| The dependency tree | `highwire-core` exports the wager builders and codec; `highwire-agent` exports the reveal daemon | anyone depending on either ships wager code |
| Deploys | every push to `main` builds and deploys highwire.fun | a change to the Rust program, a research note or a test deploys production, and the referee runs in that deployment |
| The audit | docs/audit/line-wager.md scopes it to the Rust (landed while this was drafted) | nothing marks the commit sent, or says when a later change touches it |
| Checks | `npm run test:program` is run by hand "before every commit that touches either side" | nothing stops a commit that breaks parity |

## 2. Goals, non-goals, success

**Goals**
- A default install of `highwire-mcp`, `highwire-core` or `highwire-agent` contains no code that can stake, and no
  staking tool appears unless the owner installed and turned on something named for it.
- Free play on The Line is untouched: same tools, same names, same behaviour.
- A push that changes only the program, research, tests or scripts doesn't deploy the site.
- The audit's scope is pinned to a tag, and CI fails a commit that breaks rules parity.
- If an operating entity is ever set up, its code can leave in one move.

**Non-goals**
- Splitting the repository, or moving The Line itself out of Highwire.
- Changing any rule of the game, the program's instructions or its accounts.
- Anything on mainnet. Setting `WAGER_PROGRAM_IDS.mainnet` stays behind W0 and W2 of docs/wager-mode.md 13.
- Deciding the operating entity, the licence or the jurisdictions.
- Geo-blocking inside an npm package. It can't be enforced there; eligibility stays at the wager desk, which signs the
  tickets (docs/wager-mode.md 8).

**Success**
- `npm pack` of `highwire-mcp`, `highwire-core` and `highwire-agent` has no file with wager code, and a test says so.
- With no switch set, `tools/list` over stdio with a signer has no `line_stake` or `line_wagers`, and `line_state`,
  `line_move` and `line_retire` refuse a `series`.
- A scripted devnet series (`wager-pair`) still plays and settles through the new package.
- A commit touching only `programs/` or `docs/research/` produces no deployment; one touching `CHANGELOG.md` does.
- `npm run test:program` runs in CI on every pull request that touches the program or the arena's rules.

## 3. Where wagering lives today

About 5,700 lines, counting tests and the program:

| Package | Wager code | Stays or moves |
|---|---|---|
| `programs/line-wager` | the program: 1,485 lines of Rust | stays |
| `highwire-core` `src/arena/` | `rules.ts`, `series.ts` (the program's twin): no money, no chain | stays: it's the game, and replays in the browser use it |
| `highwire-core` `src/tx/` | `wager-codec.ts`, `wager.ts`, `wager-history.ts` (1,084 lines), and the wager entries in `decode.ts` | moves |
| `highwire-agent` | `wager-runner.ts`, `wager-secrets.ts` (370 lines): the reveal daemon | moves |
| `highwire-agent` | the `wager` action and the `wagers` section of the policy; the signer's wager checks | the policy's shape stays (one file, one schema); the checks move behind a hook |
| `highwire-mcp` | `tools/wager.ts` (351 lines), `line-cli.ts` (`highwire line run`, `line series`), `scripts/wager-admin.ts`, `wager-pair.ts` | moves |
| `highwire-relay` (private) | `arena/wager.ts`: the desk and the tickets (528 lines) | stays for now, behind its own entry; it's what an operator would take (8) |
| `apps/web` | `/line/practice` and its data, read from the chain | stays, importing the new package |

What stands between an agent and a stake today: the local signer, `"wager"` in the policy's actions with a `wagers`
section, the reveal daemon working for that wallet, and the desk pairing on that cluster. The first three are the
owner's doing, so nobody stakes by accident. The gap is what the agent is shown.

What makes the package more than moving files: `line_state`, `line_move` and `line_retire` serve free play **and** staked
series (a `series` argument), the signer refuses any instruction its decoder doesn't know, and the policy checks a
wager's stake against the owner's limits.

## 4. The options

| | What it is | For | Against |
|---|---|---|---|
| **A. A switch** | the wager tools need `HIGHWIRE_WAGERS=1`; off by default | hours; closes the default-install gap in the next release | the code still ships to everyone; "a separate module" isn't true yet |
| **B. A package** | `highwire-wager`, with its own bin; `highwire-mcp`, `-core` and `-agent` carry no wager code | meets every goal; one thing to audit on the client side; one thing to hand to an operator | days, and four extension points in code the signer's safety rests on |
| **C. A repository** | wagering in its own repository | the cleanest wall | parity across two repositories; two release trains; nothing a package doesn't give until there's a second entity |

**Recommendation: A now, B before the audit, C only on the trigger in 8.**

## 5. The design

### 5.1 The switch (phase 1)

- `HIGHWIRE_WAGERS=1` in the server's environment registers the wager tools. Unset, `line_stake` and `line_wagers`
  don't exist, the three shared tools' descriptions say nothing of staking, and a `series` argument is refused
  (`wagers_off`) with a line saying how the owner turns wagering on.
- **Refused, never dropped.** An unknown argument is silently removed, and `line_retire` with its `series` removed
  would forfeit the free match in play. So the argument stays in the schema while the tools are off, to be refused.
- **The reveal daemon isn't behind the switch** (a change from the draft). Starting `highwire line run` is already the
  owner's own act, it stakes nothing, and a daemon that refused to start after an upgrade would leave an open series
  unrevealed, which forfeits matches. A switch there would add a way to lose money and protect nothing.
- It's a second lock, not a replacement: the policy's `wager` action and `wagers` section still decide what may be
  staked (docs/wager-mode.md 7.3), and `highwire add` still never offers it.
- The hosted endpoint is unchanged: it has no signer, so it never had these tools.

### 5.2 The package (phase 2)

`highwire-wager`, published, versioned with the others, depending on `highwire-mcp`, `highwire-agent` and
`highwire-core`, and never the other way round (a test checks the three import nothing from it).

- **How an owner turns it on:** they run a different server. `npx -y highwire-wager` is `highwire-mcp`'s stdio server
  with the wager tools added, and `highwire-wager run` is the daemon. Their MCP client's config names the package, so
  wagering is a choice visible in one line. *(Alternative: a flag on `highwire-mcp` that loads the package if it's
  installed. Rejected: with `npx` there's no "installed", and a flag that changes what code loads is easy to miss.)*
- **Four extension points** (the tools and the CLI in 2a, the decoder and the policy check in 2b), each an argument
  the host passes in code. Nothing is discovered from disk or from the
  environment, so a look-alike package can't register itself:
  1. **Tools:** `createServer` takes extra tool groups, and the play tools take an optional handler for a `series`.
     Tool names don't change (`line_stake`, `line_wagers`, and `series` on the three shared tools).
  2. **The decoder:** `decode.ts` takes extra program decoders. Without one, the wager program is an unknown program and
     the signer refuses it, which is the right default.
  3. **The policy check:** the signer takes a checker for the `wager` action. Without one, a `wager` intent is refused.
  4. **The CLI:** `highwire line …` moves to the new bin; `highwire-mcp`'s help points to it.
- **`highwire-relay` and `apps/web`** import the codec and the history from `highwire-wager`.
- **npm:** the name is free today. Publish it as soon as the package exists, so nobody else takes it.
- **0.15.0 can't be recalled.** It has the tools, devnet only. The release that removes them says so in the changelog,
  and the two practice fighters' setup (docs/wager-devnet.md 6) changes to the new server.

### 5.3 Deploys (phase 3)

- **The rule:** an `ignoreCommand` in `apps/web/vercel.json` (`apps/web/scripts/ignore-build.mjs`) that skips the build
  only when **every** changed file is under a short skip list: `programs/`, `docs/research/`, `packages/*/test/`,
  `packages/*/scripts/`. Anything else builds. Whole folders only: the draft's `*.rs` went, since a `.rs` file under
  `apps/web/public` would be something the site serves, and the program's Rust is all under `programs/` anyway.
- **When it can't tell, it builds:** no earlier deployment of the branch, a commit it can't find, git failing, or
  nothing changed at all (a redeploy asked for on purpose, as when a setting changes).
- **Why a skip list and not a build list:** the site reads `CHANGELOG.md`, `ideas/` and
  `packages/mcp/package.json` at build time, besides every package it imports. A list of what to build would miss the
  next such file and leave the site stale; a list of what to skip can only err toward building.
- **It compares against the last deployed commit** (`VERCEL_GIT_PREVIOUS_SHA`), not the previous one, so a push of
  several commits is judged whole. If that commit isn't in Vercel's shallow clone, it builds.
- **Tried on a preview branch**, one push of each kind, before `main` relies on it (2026-11-10, a throwaway branch,
  since deleted). What Vercel reported for each commit:

  | Push | Changed since the last deployed commit | Vercel |
  |---|---|---|
  | the branch's first | (no earlier deployment) | built |
  | program only, pushed before the first deployment finished | (still no earlier deployment) | built |
  | the changelog, with that program change | program, changelog | built |
  | changelog only | changelog | built |
  | site code only | a file under `apps/web/public` | built |
  | program only | program | **skipped** |
  | a research note | program, research | **skipped** |
  | a package's test and scripts | program, research, test, scripts | **skipped** |
  | program and site code together | all of those, and site code | built |

  A skipped build shows on GitHub as a passing `Vercel` status, "Canceled by Ignored Build Step", so a pull request's
  checks stay green. The second row was the trial's own doing: the branch's first commit already had a status from
  another branch, so the trial didn't wait for this branch's first deployment. With none to compare with, the rule
  built, as it should. The skips are judged over everything since the last *deployed* commit, not the last push: the
  three skipped rows each include the ones before.
- *(Alternative: Vercel's own "skip unaffected projects" setting. It's a project setting, outside the repository and
  outside review; the maintainer can turn it on as well.)*

### 5.4 The audit's scope (phase 4)

- **The scope exists:** docs/audit/line-wager.md lists the program's eight files as in scope, and the rules' twin, the
  client's builders and checks, the daemon and the desk as context. The program builds reproducibly
  (`solana-verify build programs/line-wager`). Neither is this document's work.
- **After phase 2 the pack names the package:** "the client" becomes `highwire-wager` and the hooks it plugs into.
- **A tag** (`audit/line-wager-1`) on the commit sent, with the program's hash from that commit's build, in the pack.
- **Frozen while it's out:** a pull request touching the program after the tag needs the maintainer's say-so, and CI
  says when one does.

### 5.5 CI (with phase 4)

GitHub Actions, free for a public repository:
- every pull request: `npm run typecheck`, `npm test`, `npm run build`;
- when `programs/` or `packages/core/src/arena/` changes: `npm run test:program` (the Rust toolchain, pinned);
- never `npm run smoke`, `simulate` or `rehearse`: they need the network and live RPCs, and stay manual.

No secrets go into CI. Nothing in it deploys or publishes.

## 6. Considerations and risks

- **The signer's hooks are the dangerous part.** Phase 2 changes code that decides whether a transaction is safe to
  sign. Each hook defaults to refusing, the existing attack tests (`attacks.test.ts`) must pass unchanged, and new ones
  cover a host that passes no hook, a wrong hook, and a hook for another program.
- **A package doesn't change who the operator is.** Highwire still runs the matchmaker, the program's authority and the
  pages. The package is about what users install, not about legal exposure.
- **Distribution:** an npm package reaches every country. That's true of the code on GitHub already; what a user in a
  blocked country can't get is a ticket.
- **One version train, one more package.** Releases gain a publish step (`highwire-core`, `highwire-agent`,
  `highwire-mcp`, then `highwire-wager`) and the release notes in AGENTS.md change with it.
- **A skipped deploy that should have built** leaves the site stale without an error. The skip list is short for that
  reason, and the preview trial covers each path in it.
- **Moving files loses nothing if done as renames:** history follows, and the parity fixtures don't change by a byte
  (a test compares them before and after).
- **Prototype games** (`packages/core/scripts/games/`) aren't shipped and aren't affected.

## 7. Phases and acceptance

Each phase is its own pull request, and each needs the one before it merged.

1. **The switch.** *Done when* the tool list and the three shared tools behave as in "Success" with and without
   `HIGHWIRE_WAGERS`, the runbooks and `line.md` say how to turn it on, and a devnet series still settles with it on.
   *Built:* everything but the devnet series, which is the maintainer's to run (`wager-pair`: it sends transactions).
2. **The package**, in two pull requests, the dangerous part alone in the second:
   - **2a. Everything but the safety checks.** The tools, the builders, the history, the reveal daemon, the CLI and the
     maintainer's scripts move to `highwire-wager`; `highwire-mcp` takes the tools as a `WagerExtension` passed in code.
     The switch from phase 1 goes: running `highwire-wager` is the opt-in. *Done when* the import-direction test
     passes, `highwire-wager`'s server lists every tool the old one did, the local rehearsal passes, and every test
     that moved passes unchanged but for its imports. *Built.*
   - **2b. The codec and the signer's hooks.** `wager-codec.ts`, the wager branches of `decode.ts` (`assertSafe` and
     the plain-language decoding) and of the signer and policy move behind the decoder and policy hooks in 5.2, each
     refusing by default. *Done when* `highwire-core` and `highwire-agent` have no wager code, `attacks.test.ts`
     passes unchanged, and new tests cover a host with no hook, a wrong hook and a hook for another program. *Built:* core takes
     `ProgramGuard`s and the signer `ActionExtension`s. The wager attacks moved with the checks, their refusals word
     for word; the rest of `attacks.test.ts` is unchanged. What stays in `highwire-agent` is the policy's `wagers` shape,
     the audit log's `wager` and `series` fields and the paths of the wager files: data, not checks.
3. **The deploy rule.** *Done when* a preview branch has shown a skip for a program-only push and a build for a
   changelog-only push, a code push and a mixed push. *Built, and shown* (5.3).
4. **The tag, the freeze and CI.** *Done when* the pack names the tag and its build hash, CI is green on `main` and red
   on a branch that deliberately breaks parity, and a pull request touching the program after the tag is flagged.

## 8. The later split

One trigger: **counsel's answer names an operating entity other than Highwire** (docs/wager-mode.md 5.6, 15). Then that
entity takes, to its own repository and deployment: `highwire-relay`'s wager desk, the identity store (not built), the
wager pages, the admin tool and the program's authority keys. `highwire-wager` and the program stay open source here or
move with it, as counsel advises. Phase 2 is what makes that a move of whole directories.

## 9. Decisions (made 2026-11-10: the recommended answer to each)

1. **A then B:** the switch now, the package before the audit.
2. **The name:** `highwire-wager`. (`highwire-line` is free too, but the package is the staking, not the game.)
3. **How it's turned on:** its own server and bin, not a flag that loads it.
4. **The deploy rule in `vercel.json`**, reviewed like code. The Vercel project setting is the maintainer's to add.
5. **CI on GitHub Actions:** yes.
6. **How much the audit covers:** the program, as docs/audit/line-wager.md has it; the client is context.

## 10. Open questions

- Should `highwire-core/arena`'s `series.ts` move too? It has no money in it and the browser replays need it; this
  draft keeps it.
- Does the policy's `wagers` section stay in `highwire-agent`'s schema when nothing in that package reads it?
- Whether `ideas/modules/line-play` gets a sibling module for wagering, or stays silent about it until W3.
