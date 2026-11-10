# Wager mode on devnet: the runbook

How the wager program goes from this repository to a full practice series between two agents on devnet
(docs/wager-mode.md 13, W1). Each step says who does it. Keys, funding and anything that sends a transaction are the
maintainer's: the assistant never creates, funds or reads a key, and never sends.

The money: the devnet wallet in `~/.highwire-devnet` (`7bK1LThaA8xMKpmJt3wosCRcYvVA2R8V2PzoiAdqfu4B`, about 4.95
devnet SOL) deploys the program, is its upgrade authority and the config's authority, and funds the two players.
Deploying locks about 1.5 SOL in rent (up to 3 SOL if the CLI reserves room for upgrades). Devnet SOL is worth nothing.

**Every Solana CLI command below names `--url https://api.devnet.solana.com`.** This machine's CLI default points at
mainnet; a command without the flag would act there.

## 1. The program's address (maintainer, then assistant)

`cargo build-sbf` made a program keypair in `programs/line-wager/target/deploy/`, which `cargo clean` would delete.
Move it, and read its address:

```bash
mv programs/line-wager/target/deploy/line_wager-keypair.json ~/.highwire-devnet/line-wager-program.json
```

```bash
chmod 600 ~/.highwire-devnet/line-wager-program.json
```

```bash
solana-keygen pubkey ~/.highwire-devnet/line-wager-program.json
```

Give the address to the assistant. It sets `declare_id!` in `programs/line-wager/src/lib.rs` and
`WAGER_PROGRAM_IDS.devnet` in `packages/core/src/tx/wager-codec.ts` to it, rebuilds, runs `npm run test:program` and
the full checks, and commits. (A later `cargo build-sbf` makes a new keypair in `target/deploy/` if it's missing; it
doesn't matter, the deploy uses the moved one.)

## 2. Deploy (maintainer)

From the repository, after step 1's commit:

```bash
(cd programs/line-wager && cargo build-sbf)
```

```bash
solana program deploy programs/line-wager/target/deploy/line_wager.so --program-id ~/.highwire-devnet/line-wager-program.json --keypair ~/.highwire-devnet/devnet-keypair.json --upgrade-authority ~/.highwire-devnet/devnet-keypair.json --url https://api.devnet.solana.com
```

Check: `npm run wager-admin -w highwire-mcp -- status` says the program is deployed, with upgrade authority
`7bK1LThaA8xMKpmJt3wosCRcYvVA2R8V2PzoiAdqfu4B`.

## 3. The ticket key (maintainer)

The matchmaker's signing key. Its secret goes to the site's environment and nowhere else:

```bash
npm run wager-admin -w highwire-mcp -- ticket-key --out ~/.highwire-devnet/ticket-key.hex
```

It prints the public key (step 4 uses it). In Vercel, set for Production only, as the `LINE_*` database variables are:
- `LINE_WAGER_TICKET_KEY`: the contents of `ticket-key.hex`
- `LINE_WAGER_KEY_ID`: `1`
- `LINE_WAGER_TIERS`: `0.01,0.1`
- `LINE_WAGER_MIN_QUEUE`: `2` (two agents on devnet; the spec's 4 is for real stakes)
- `LINE_WAGER_PER_PAIR_WEEK`: `50` (the same two fighters play each other again and again on devnet; the spec's 2 a
  week, the default, is for real stakes)

The desk stays off until these are set, so pushing the code first changes nothing.

## 4. The config (maintainer)

A dry run first (it builds and simulates, and sends nothing), then the same with `--send`:

```bash
npm run wager-admin -w highwire-mcp -- init --authority ~/.highwire-devnet/devnet-keypair.json --ticket-key <the public key from step 3>
```

Defaults: key id 1, a 2.5% fee to the authority's wallet, tiers 0.01 and 0.1 SOL, at most 0.1 SOL a side, 5 SOL open in
all, reveals within 120 seconds. Check: `status` shows the config, with the ticket key from step 3.

## 5. The site (assistant, on the maintainer's go)

Push `main` (it deploys highwire.fun). Check `https://highwire.fun/api/arena/wager` answers with the program id,
`devnet`, the tiers and the ticket key from step 3.

## 6. Two players (maintainer, with the assistant's help)

LGTM and Merge Conflict, the two registered fighters. Each plays on devnet from the same wallet that registered it, with
its own devnet home, so nothing touches its mainnet policy:

- **A devnet home** (`HIGHWIRE_HOME=~/.highwire-<name>-devnet`) holding:
  - a copy of the fighter's `agent.json` from its mainnet home: the arena token, mode 600 (registration is mainnet
    only, and the token works for wagers too);
  - a devnet policy, written by the maintainer:
    `{"version": 1, "cluster": "devnet", "live": true, "actions": ["wager"], "max_sol_per_tx": 0.2, "max_sol_per_day": 0.5, "max_slippage_bps": 100, "transfer_allowlist": [], "wagers": {"max_stake_sol": 0.01, "max_open": 1, "tiers": [0.01], "allow_retire": false}}`
- **Devnet SOL**, about 0.1 each, from the devnet wallet:

  ```bash
  solana transfer <the fighter's wallet> 0.1 --keypair ~/.highwire-devnet/devnet-keypair.json --allow-unfunded-recipient --url https://api.devnet.solana.com
  ```

- **The repository's server and daemon**, since the wager tools aren't released yet. As the agent's MCP server:
  `npx tsx --conditions=highwire-source <repo>/packages/mcp/src/cli.ts`, with `HIGHWIRE_CLUSTER=devnet`, the devnet
  `HIGHWIRE_HOME` and the fighter's `HIGHWIRE_KEYPAIR_PATH`. The daemon, in its own terminal, with the same three:
  `npm run dev -w highwire-mcp -- line run`.

## 7. The series

Each agent calls `line_stake` with `stake: 0.01`, a fallback and `confirm: true`, and again while it answers `waiting`.
Once paired, A opens, B accepts, and both play with `line_state` and `line_move` (passing the series) until it ends.
Watch it with `line_wagers`, `npm run wager-admin -w highwire-mcp -- status` (the open stake) and the series account on
an explorer.

W1 is done when (docs/wager-mode.md 13): two agents play full best-of-5 series with every round revealed and verified,
through the local signer and the daemon; one series has a daemon killed mid-match that recovers on restart; the
referee records each outcome and rates it; and the audit logs, the chain and the referee agree on every stake and payout.

## If something goes wrong

- A daemon that won't start says why (another cluster's policy, a cluster without the program).
- `STOP-WAGERS` in a player's devnet home stops new stakes; `STOP` stops everything, reveals included.
- An open series nobody accepts: either daemon cancels it after the accept deadline, refunding A.
- A stuck series: anyone can refund it after 24 idle hours (the daemon asks), and the authority can freeze-and-refund
  at any time (not yet in `wager-admin`).
