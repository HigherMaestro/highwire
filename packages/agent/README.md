# highwire-agent

The opt-in local signer behind [Highwire](https://github.com/HigherMaestro/highwire)'s execute tools. It signs
higher.fun transactions for one wallet, from a keypair file on your machine, and only inside a policy file you write.
Dry run until the policy says `"live": true`. MIT.

- `loadPolicy` and `checkPolicy`: the policy schema (cluster, `live`, actions, SOL per transaction and per 24 hours,
  slippage, coin and creator lists, the transfer allowlist) and the rule each execute must pass.
- `loadKeypair`: reads a Solana CLI keypair file, and warns when other users can read it. Never echoes the key.
- `AuditLog`: one JSON line per refusal, dry run and signature in `~/.highwire/audit.jsonl`, and the daily count.
- `LocalSigner`: checks an envelope from `highwire-core` against the policy, simulates each transaction again, then
  signs, sends and confirms, one execute at a time. `~/.highwire/STOP` refuses everything.
- `OrderBook` and `OrderRunner`: standing orders (stop-loss, take-profit, recurring buys) in `~/.highwire/orders.json`,
  filled through `LocalSigner` while `highwire orders run` runs, only the kinds the policy's `orders` section allows.

You don't use it directly: `highwire-mcp` turns it on when `HIGHWIRE_KEYPAIR_PATH` is set. See the main README's
Local signer section.
