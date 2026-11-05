# highwire-core

The higher.fun client behind [Highwire](https://github.com/HigherMaestro/highwire): a typed client for
api.higher.fun, platform constants and fee modes, unit formatting (lamports to SOL, base units to tokens, bps to %),
the untrusted-content flags, a few Solana RPC reads, `evaluateRisk` (the rug-check verdict), the quote and unsigned
transaction builders, and sign links. No MCP dependency. MIT.

`highwire-core/browser` is the browser-safe part, for a signing page: the envelope format, `signUrl` and
`decodeSignPayload`, the decoder and `reviewEnvelope`, with no Node built-ins and no Raydium SDK.
