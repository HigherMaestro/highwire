# Security

## Reporting

Report a vulnerability privately through GitHub's private vulnerability reporting on this repository (Security →
Report a vulnerability). Please don't open a public issue, post it, or test it against anyone else's funds or
accounts. Include what's affected, how to reproduce it (on devnet or a local validator), and what an attacker gains.
You'll get an answer as soon as the maintainer has read it.

## Scope

- The Line's wager program (`programs/line-wager`) and everything that builds or signs its transactions: the builders
  and `assertSafe` in `highwire-core`, the local signer and reveal daemon in `highwire-agent`, the wager tools in
  `highwire-mcp`, and the wager desk in `packages/relay`.
- The sign page (highwire.fun/sign) and its checks: a link that gets something signed the review should refuse.
- The local signer's policy enforcement: anything that makes it sign outside the user's policy.
- The hosted endpoint (highwire.fun/mcp) and The Line's referee.

Out of scope: higher.fun, Raydium and Solana themselves; denial of service by volume; reports without a way to
reproduce them.

## Rewards

A bug bounty for the wager program opens before it runs on mainnet; its rewards are scaled to the program's open-stake
cap and published here then. Until then, reports are credited (if you'd like) in the changelog.
