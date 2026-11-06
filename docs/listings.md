# Directory listings

Where Highwire is listed, what each directory needs, and the copy to paste. Checked 2026-11-06. Update the tool
counts and version with each release.

## Status

| Directory | Status | Next step |
|---|---|---|
| Official MCP Registry | Listed: `fun.highwire/highwire`, 0.9.0 | Published with every release |
| Glama connector | Listed, **ownership verified** (claim file at highwire.fun/.well-known/glama.json), scored A (3.5/5) | Keep the claim file published |
| Glama server | Listed, **claimed** (glama.json), description current, Docker build passing (installs highwire-mcp from npm), first Glama release made | Bump the build step's version with each release |
| awesome-remote-mcp-servers | PR open: punkpeye/awesome-remote-mcp-servers#4072, checks passing | Wait for review |
| awesome-mcp-servers | PR open: punkpeye/awesome-mcp-servers#18795, checks passing | Wait for review |
| mcp.so | Submitted: chatmcp/mcpso#6871 (the free route; the web form is now a $39 paid listing) | Wait for review |
| Smithery | Closed to submissions since 2026-10-31: now a curated, read-only directory run by Arcade | None |
| PulseMCP | Not listed; its submissions and imports are paused (checked 2026-11-06) | Check again later |
| Cursor | No directory listing needed | "Add to Cursor" button (step 7) |
| Claude Connectors Directory | Skip: its policy says "We do not generally allow cryptocurrency software" | Users can still add `https://highwire.fun/mcp` as a custom connector |

The GitHub repo's topics (added 2026-11-06) help directories and GitHub search find it:

```bash
gh repo edit HigherMaestro/highwire --add-topic mcp --add-topic mcp-server --add-topic model-context-protocol --add-topic solana --add-topic ai-agents --add-topic higher-fun --add-topic memecoin
```

## The copy

**Name:** Highwire

**Short description (116 characters, for the awesome lists):**
Research, rug-check and watch higher.fun coins on Solana, and build trades and launches you sign in your own wallet.

**One-liner (197 characters, for directory cards):**
Highwire lets AI agents use higher.fun, the open-source Solana launchpad: research and rug-check coins, watch the
market live, and build trades, launches and fee claims you sign in your own wallet.

**Description:**
Highwire is an MCP server for higher.fun, the open-source Solana launchpad. Ask your agent what's launching, what's
trending, who holds a coin or whether it looks safe, and it answers from higher.fun's data and the chain itself. Watch
launches, graduations and big trades as they happen. Quote and build trades, coin launches and creator fee claims as
unsigned transactions: each comes with a link to review it, rebuilt from the transaction's own bytes, and sign it in
your own wallet. Highwire never holds a key.

Run it locally and an agent can act on its own inside limits you write: trade, launch, claim, place stop-loss,
take-profit and recurring-buy orders, and see its profit and loss. Agents with a shell can launch a coin from their
own wallet with one command, following highwire.fun/skill.md.

26 tools on the hosted endpoint, no key or sign-up. Trades it builds carry a 0.3% fee, shown in each transaction;
launches, claims and everything else are free.

**Categories:** Finance, Crypto / Blockchain, Trading

**Connect:**
- Hosted (Streamable HTTP, no authentication): `https://highwire.fun/mcp`
- Claude Code: `claude mcp add --transport http highwire https://highwire.fun/mcp`
- Local (stdio): `npx -y highwire-mcp`, or in an MCP client's config:
  ```json
  { "mcpServers": { "highwire": { "command": "npx", "args": ["-y", "highwire-mcp"] } } }
  ```

**Links:**
- Homepage: https://highwire.fun
- Docs: https://highwire.fun/docs
- Agent instructions: https://highwire.fun/skill.md
- Source: https://github.com/HigherMaestro/highwire (MIT)
- npm: https://www.npmjs.com/package/highwire-mcp
- Registry: `fun.highwire/highwire`
- Privacy: https://highwire.fun/privacy
- Terms: https://highwire.fun/terms
- Support: GitHub issues, or X @Highwiredotfun

**Icon:** `brand/png/mark-1024.png` (paper) or `brand/png/mark-dark-1024.png` (ink); `brand/png/icon-512.png` where a
small square is asked for.

## 1. Glama: claim both listings

The **server** listing is claimed through a `glama.json` file in the repo's root naming GitHub maintainers:

```json
{ "$schema": "https://glama.ai/mcp/schemas/server.json", "maintainers": ["HigherMaestro"] }
```

Once it's pushed, sign in at https://glama.ai with the HigherMaestro GitHub account, open
https://glama.ai/mcp/servers/HigherMaestro/highwire and choose Claim. Then replace the stale description with the
description above.

The **connector** listing (https://glama.ai/mcp/connectors/fun.highwire/highwire) is claimed by proving you own
highwire.fun: Glama gives a token to serve as a file on the site or as a DNS record. Bring the token back and it can be
served from `apps/web/public`.

Badges, once listed (both are needed below):

```markdown
[![Highwire MCP connector](https://glama.ai/mcp/connectors/fun.highwire/highwire/badges/score.svg)](https://glama.ai/mcp/connectors/fun.highwire/highwire)
[![HigherMaestro/highwire MCP server](https://glama.ai/mcp/servers/HigherMaestro/highwire/badges/score.svg)](https://glama.ai/mcp/servers/HigherMaestro/highwire)
```

## 2. awesome-remote-mcp-servers (hosted endpoints)

https://github.com/punkpeye/awesome-remote-mcp-servers. Rules: **star the repo first** (PRs from accounts that haven't
are not merged), the Glama connector badge is required (CI checks it exists), entries are alphabetical within the
category, and the description is one sentence of at most 120 characters.

Add under **💰 Finance**, in alphabetical order:

```markdown
- [Highwire](https://highwire.fun) `https://highwire.fun/mcp`
  [![Highwire MCP connector](https://glama.ai/mcp/connectors/fun.highwire/highwire/badges/score.svg)](https://glama.ai/mcp/connectors/fun.highwire/highwire)
  🔓 - Research, rug-check and watch higher.fun coins on Solana, and build trades and launches you sign in your own wallet.
```

PR title: `Add Highwire (higher.fun on Solana)`.

## 3. awesome-mcp-servers (installable servers)

https://github.com/punkpeye/awesome-mcp-servers. Edit `README.md` only, add one line in the most specific category in
alphabetical order, and match the existing format exactly.

Add under **💰 Finance & Fintech**:

```markdown
- [HigherMaestro/highwire](https://github.com/HigherMaestro/highwire) [![HigherMaestro/highwire MCP server](https://glama.ai/mcp/servers/HigherMaestro/highwire/badges/score.svg)](https://glama.ai/mcp/servers/HigherMaestro/highwire) 📇 ☁️ 🏠 🍎 🪟 🐧 - Research, rug-check and watch higher.fun coins on Solana, and build trades and launches you sign in your own wallet. Hosted at `https://highwire.fun/mcp` or `npx -y highwire-mcp`.
```

📇 TypeScript, ☁️ hosted and 🏠 local, and all three operating systems.

## 4. mcp.so

Submit at https://mcp.so/submit (or open an issue on https://github.com/chatmcp/mcpso). It asks for the repo URL, the
description, how to install it, the transport, and whether it needs authentication:

- Repo: https://github.com/HigherMaestro/highwire
- Install: `npx -y highwire-mcp` (stdio), or the hosted URL `https://highwire.fun/mcp` (Streamable HTTP)
- Authentication: none
- Description: the one-liner above

## 5. Smithery

https://smithery.ai/new, the URL method for a server that's already hosted: enter `https://highwire.fun/mcp`. Any
Streamable HTTP server works; no `smithery.yaml` is needed for this route. Then fill the listing from the copy above.

## 6. PulseMCP

https://www.pulsemcp.com imports servers from the official MCP Registry each week, so Highwire should appear without a
submission. Search for it in a browser (the site blocks scripted requests); if it's missing, use its submit form.

## 7. Cursor

Cursor installs servers from a link rather than a directory submission. For a README or the site:

```markdown
[Add Highwire to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=highwire&config=eyJ1cmwiOiJodHRwczovL2hpZ2h3aXJlLmZ1bi9tY3AifQ==)
```

The config is base64 of `{"url":"https://highwire.fun/mcp"}`. Click it once in Cursor before publishing it.

## Not listed on purpose

- **Claude Connectors Directory.** Anthropic's Software Directory Policy says "We do not generally allow cryptocurrency
  software in our directory." A submission would likely be refused. Claude users can add `https://highwire.fun/mcp`
  as a custom connector.
