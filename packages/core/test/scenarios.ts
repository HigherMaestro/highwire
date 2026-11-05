import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";

// Real mainnet coins and wallets the transaction tests replay. Recorded with
// `npm run record-fixtures -w highwire-core`; every build only ever simulated.

/** $SI: a New school coin on the bonding curve when recorded. */
export const CURVE_COIN = new PublicKey("EE3p42u2rACc3PEDcgVdqfg8JRxSYdvbn53rFoc3i1ix");
/** $Fischer: an Old school coin that has graduated to its CPMM pool. */
export const GRADUATED_COIN = new PublicKey("ESWuXHiwswpkfhQtA6A1tAtiBJh9A5hUDYj5fEYhigh");
/** A wallet holding SOL and $SI. */
export const TRADER = new PublicKey("H4dxJQN6DRqCPva9yaX2Nt3mAkvgo7pyQZr93fLke1U5");
/** A wallet holding $Fischer. */
export const GRADUATED_HOLDER = new PublicKey("DFZYHaTZiRFWo23q5NQZCBTxXGZi36ZwVNP62iyB2Vmj");
/** $PHILCOIN's creator, with curve and pool creator fees to claim (and SOL to pay for the claim). */
export const CREATOR = new PublicKey("3nG8WsVqotPWH74NRUpLwfQ1NMabdorWQ52YvbrVHA2E");
/** $PHILCOIN: a graduated coin with pool creator fees waiting. */
export const CLAIM_COIN = new PublicKey("Ea5dBrJZN58yV1nm1Q4DybJNYKeTvwpb2GEkXyW64bUH");

/** $HIGH: higher.fun's own New school coin, graduated, with locked-LP fees harvested. */
export const NEW_SCHOOL_GRADUATED = new PublicKey("7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh");

/** A fixed mint for the launch scenario, so the replayed build is deterministic. Never funded. */
export const LAUNCH_MINT = Keypair.fromSeed(createHash("sha256").update("highwire simulation launch mint").digest());
export const LAUNCH_URI = "https://highwire.fun/sim/metadata.json";

export const SCENARIOS = ["buy-curve", "sell-curve", "buy-graduated", "sell-graduated", "launch-rewards", "claim", "positions", "positions-mints", "transfer-sol", "transfer-coin", "fees"] as const;
export type Scenario = (typeof SCENARIOS)[number];
