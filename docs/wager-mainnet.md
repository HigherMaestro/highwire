# Wager mode on mainnet: the runbook

How wager mode goes from devnet to mainnet (docs/wager-mode.md 13, W2), set up so that when counsel's clearance comes,
going live is **one switch**: unpause the program and point the site's desk at mainnet. Everything else is done ahead of
time, with the program deployed and its config **paused**, so nothing can be staked before the switch.

Each step says who does it. Keys, funding and anything that sends a transaction are the maintainer's; the assistant
never creates, funds or reads a key, and never sends. **Every Solana CLI command below names its `--url`**: this
machine's CLI default isn't to be trusted for either cluster.

## What isn't in this runbook

- **Counsel's clearance** (docs/wager-mode.md 5, W0): the gate. Nothing here moves real money before it.
- **Owner checks** (identity, age, country, sanctions, loss limits, self-exclusion; 8 and 11): not built, by decision,
  until counsel says which are required. If counsel requires any, they're built then, and the switch waits for them.
- **The external audit and the bug bounty** (W2): bought, not built. `docs/audit/line-wager.md` is the auditors' pack;
  `SECURITY.md` says how to report.

## The keys

| Key | What it does | Where it lives |
|---|---|---|
| **The program's address** (`line-wager-program.json`) | Decides where the program first deploys. Useless after the deploy | `~/.highwire-mainnet/`, mode 600, plus one offline backup |
| **The authority** (a Ledger: `usb://ledger?key=0` to the Solana CLI, account `44'/501'/0'`, which is wager-admin's `--ledger`) | The program's upgrade authority and the config's authority: pauses, freezes, changes the config, upgrades the program | The Ledger. Its recovery phrase on paper, offline |
| **The deployer** (a fresh hot keypair, `~/.highwire-mainnet/deployer.json`) | Pays for the deploy's few hundred transactions, then hands the upgrade authority to the Ledger. Holds nothing after | This machine, for the deploy only |
| **The fee account** | Receives the fee. Signs nothing for the program | A wallet of its own: never the authority, never a player |
| **The mainnet ticket key** | The wager desk signs pairings with it. Never moves money (docs/wager-mode.md 7.7) | Vercel only, `LINE_WAGER_MAINNET_TICKET_KEY` (Production, Sensitive). Separate from devnet's |

One device controls the program. There's no timelock on upgrades without a multisig, so an upgrade always starts by
pausing (section 8), and the Ledger's recovery phrase is the one thing that must never be lost or seen.

wager-admin's Ledger libraries are installed apart from the workspace, once: `npm ci --prefix tools/ledger`.

On the Ledger: install the Solana app, and turn on **Allow blind signing** in its settings (the wager program's
instructions aren't ones the app can show field by field). wager-admin prints each message's hash before asking the
device to sign: approve only if the device shows the same. Check the address against `solana-keygen pubkey
usb://ledger?key=0` before every use: the bare `usb://ledger` is a different account.

## 1. The program's address (maintainer, then assistant)

```bash
mkdir -p ~/.highwire-mainnet && chmod 700 ~/.highwire-mainnet && solana-keygen new --no-bip39-passphrase -o ~/.highwire-mainnet/line-wager-program.json && chmod 600 ~/.highwire-mainnet/line-wager-program.json && solana-keygen pubkey ~/.highwire-mainnet/line-wager-program.json
```

The assistant sets `WAGER_PROGRAM_IDS.mainnet` in `packages/core/src/tx/wager-codec.ts` to that address, and it ships in
the next release. It's inert until the switch: agents' `line_stake` refuses while the referee's desk is on devnet, and
the program refuses to open anything while its config is paused.

## 2. The build anyone can check (assistant)

The deployed binary must be the one the audit read, and anyone must be able to rebuild it from this repository and get
the same bytes:

```bash
(cd programs/line-wager && solana-verify build)
```

```bash
solana-verify get-executable-hash programs/line-wager/target/deploy/line_wager.so
```

It builds in Solana's pinned Docker image (`solana-verify` 0.5.2, `cargo install solana-verify --version 0.5.2
--locked`; Docker running), so the hash doesn't depend on this machine. Record the commit and the hash in section 10
below and in the audit's report. Deploy this build's `line_wager.so`, not one from `cargo build-sbf`: the two differ.

## 3. The SOL (maintainer)

A deploy is a few hundred transactions (the program is about 221 KB, written a chunk at a time), too many to approve on a
Ledger one by one, so a fresh hot keypair pays for it and then hands the upgrade authority to the Ledger:

```bash
solana-keygen new --no-bip39-passphrase -o ~/.highwire-mainnet/deployer.json && chmod 600 ~/.highwire-mainnet/deployer.json && solana-keygen pubkey ~/.highwire-mainnet/deployer.json
```

What it costs (rent as `solana rent` gave it, November 2026):

| | SOL | |
|---|---|---|
| The program's data account (221,208 bytes) | 1.125 | locked while the program exists; `solana program close` returns it |
| The deploy's buffer | 1.125 | only during the deploy: returned to the deployer at the end |
| The deploy's ~220 transactions, with a priority fee | about 0.002 | spent |
| The config account (the Ledger pays) | about 0.002 | locked while the config exists |

So fund the deployer with **2.3 SOL** (it needs both rents at once for a moment, and gets about 1.13 back), and the
Ledger with **0.02 SOL**. In all, about **1.13 SOL stays locked** and well under 0.01 SOL is spent. The fee account
needs nothing to receive. An upgrade to a larger build needs its own buffer's rent for a moment, and `solana program
extend` locks more for the extra bytes.

## 4. Rehearse (assistant)

```bash
npm run rehearse-wagers -w highwire-mcp
```

The whole stack on a local validator: a full series with a missed commit, a retirement, a series never accepted and
cancelled, a pause, and a freeze, through the real tools, signer, daemons and desk. All checks must pass, on the commit
being deployed.

## 5. Deploy, paused (maintainer)

Use a mainnet RPC of your own for these (the public one drops a deploy's writes), and a priority fee. First the deploy,
paid and signed by the deployer:

```bash
solana program deploy programs/line-wager/target/deploy/line_wager.so --program-id ~/.highwire-mainnet/line-wager-program.json --keypair ~/.highwire-mainnet/deployer.json --upgrade-authority ~/.highwire-mainnet/deployer.json --with-compute-unit-price 10000 --url <your mainnet RPC>
```

Then hand the upgrade authority to the Ledger at once (one approval on the device; the Ledger signs to show it's a key
someone holds):

```bash
solana program set-upgrade-authority <program address> --upgrade-authority ~/.highwire-mainnet/deployer.json --new-upgrade-authority usb://ledger?key=0 --keypair ~/.highwire-mainnet/deployer.json --url <your mainnet RPC>
```

Send what's left in the deployer to the Ledger, and delete `deployer.json`. Nothing else can set up the config: only the
upgrade authority, now the Ledger, can (and wager-admin checks it's signing as that key before building anything).

Then check it, and set up the config **paused** in the same transaction (wager-admin always pauses on mainnet). A dry run
first, then the same with `--send`; the send asks you to type "mainnet":

```bash
npm run wager-admin -w highwire-mcp -- status --cluster mainnet
```

```bash
npm run wager-admin -w highwire-mcp -- init --cluster mainnet --ledger --ticket-key <mainnet ticket key's public key> --fee-account <the fee account> --tiers 0.1 --max-stake 0.1 --open-cap 1
```

The spec's closed beta (W2): one 0.1 SOL tier, 0.1 SOL a side at most, 1 SOL open in all. `status` must then say
**PAUSED** and show this config.

Verify the deployed bytes against the repository (step 2):

```bash
solana-verify get-program-hash -u https://api.mainnet-beta.solana.com <program address>
```

It must equal the hash recorded in section 10.

## 6. The mainnet ticket key and the site's settings (maintainer)

```bash
npm run wager-admin -w highwire-mcp -- ticket-key --cluster mainnet --out ~/.highwire-mainnet/ticket-key.hex
```

(Make this one before step 5: `init` takes its public key.) In Vercel, Production only, each Sensitive:

| Variable | Value |
|---|---|
| `LINE_WAGER_MAINNET_TICKET_KEY` | the contents of `ticket-key.hex` |
| `LINE_WAGER_MAINNET_KEY_ID` | `1` |
| `LINE_WAGER_MAINNET_RPC_URL` | a mainnet RPC of the site's own (required: the desk stays off without one) |
| `LINE_WAGER_MAINNET_TIERS` | `0.1` (the default) |
| `LINE_WAGER_MAINNET_MIN_QUEUE` | `4` (the default: four owners must wait at a tier) |
| `LINE_WAGER_MAINNET_PER_PAIR_WEEK` | `2` (the default) |

None of them does anything while `LINE_WAGER_CLUSTER` isn't `mainnet`. Devnet keeps its own (`LINE_WAGER_*`). The
mainnet desk's queue, series and ratings are kept apart from devnet's in the store, so practice never seeds or touches
them.

## 7. The switch (maintainer, on counsel's go)

Two actions, in this order:

1. **Open the program:**

   ```bash
   npm run wager-admin -w highwire-mcp -- unpause --cluster mainnet --ledger --send
   ```

2. **Point the desk at mainnet:** set `LINE_WAGER_CLUSTER` to `mainnet` in Vercel (Production) and redeploy.

Then check `https://highwire.fun/api/arena/wager` answers with `"cluster": "mainnet"` and the mainnet program, and
`status` says open. Agents wager on mainnet with a mainnet policy that has `"wager"` in its actions and a `wagers`
section, and their reveal daemon on mainnet (`HIGHWIRE_CLUSTER=mainnet highwire line run`).

To go back: pause (section 8), wait until `status` shows the open stake at 0 (every mainnet series settled: the desk
only reads the cluster it's on, so one left open would never be rated), then set `LINE_WAGER_CLUSTER` back to
`devnet`.

## 8. Running it

- **Stop new series at once:** `wager-admin -- pause --cluster mainnet --ledger --send`. Live series play on and settle;
  one opened but not accepted can only be cancelled (the daemons do it after its deadline, refunding A). The desk sees
  the pause within 30 seconds and stops pairing.
- **A stuck series:** anyone can refund it after 24 idle hours (the daemons ask); the authority can freeze it at once,
  both stakes back in full: `wager-admin -- freeze --cluster mainnet --ledger --series <id> --send`.
- **Change the fee, the tiers or the caps:** `wager-admin -- config --cluster mainnet --ledger …`. A new fee applies to
  series opened afterwards; the program refuses anything past its hard caps (5% fee, 10 SOL a side).
- **Rotate the ticket key** (monthly, and at once on suspicion): make a new key (`ticket-key --cluster mainnet --out`);
  `config --ticket-key <new public key> --key-id <next id>`; replace `LINE_WAGER_MAINNET_TICKET_KEY` and `_KEY_ID` in
  Vercel and redeploy. Tickets signed with the old key stop working at once, which is the point; the desk sees the
  program's new key id within 30 seconds and doesn't pair until its own matches.
- **Upgrade the program**, after the new build has been audited and rehearsed (step 4): pause; wait until `status`
  shows the open stake at 0 (every series settled); write the new build to a buffer from a fresh deployer, hand the
  buffer to the Ledger, and upgrade from it with one approval:

  ```bash
  solana program write-buffer programs/line-wager/target/deploy/line_wager.so --keypair ~/.highwire-mainnet/deployer.json --with-compute-unit-price 10000 --url <your mainnet RPC>
  ```

  ```bash
  solana program set-buffer-authority <buffer address> --buffer-authority ~/.highwire-mainnet/deployer.json --new-buffer-authority <the Ledger's address> --keypair ~/.highwire-mainnet/deployer.json --url <your mainnet RPC>
  ```

  ```bash
  solana program upgrade <buffer address> <program address> --upgrade-authority usb://ledger?key=0 --keypair usb://ledger?key=0 --url <your mainnet RPC>
  ```

  If the new build is larger than the program account, `solana program extend <program address> <bytes>` first. Verify
  its hash (step 2), then unpause.
- **Watch:** `status` for the open stake against the cap; `/line/practice` for series; the desk's sweep runs every
  minute and reads every outcome from the chain.

## 9. Known limits, accepted for the beta

- **A player whose reveal daemon is down forfeits matches**, by the rules (a missed reveal forfeits; a missed commit
  plays the fallback). On mainnet that costs real stakes. `line.md` and the tools say the daemon must run; run it as a
  service that restarts.
- **A settle whose log is cut short** (anyone can settle, through a program that logs enough to truncate the log) leaves
  that series unrated by the referee, after an hour; the money goes where the program says either way.
- **No owner checks** (above).

## 10. The deployed build

| Commit | `solana-verify` executable hash | Verified on mainnet |
|---|---|---|
| the release that records the reproducible build (2026-11-10) | `63b8fd6a68b89c7508e18c89d72a2d3bdaf4d5cdd13b72036d2c2d8c005d9f5f` | never deployed: superseded by the line below |
| "A wager commit names its match" (2026-11-10; docs/wager-mode.md 7.2.6) | `b2fd967c0910cbb02df2ffc3dc754d1160d9fc5140b1230ed95a6b04e30ee9a7` | not deployed yet |

Rebuild and record a new line whenever the program or its `Cargo.lock` changes. Devnet runs an earlier build
(`013472db…` by SHA-256), from before a commit named its match and before test-only dependencies were pinned back for
the reproducible build: it takes the earlier, 34-byte commit, until it's redeployed (docs/wager-devnet.md 9).
