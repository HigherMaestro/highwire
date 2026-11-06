import { HIGHWIRE_WALLET } from "highwire-core/browser";

export const SITE_URL = "https://highwire.fun";
export const MCP_URL = `${SITE_URL}/mcp`;
export const REPO_URL = "https://github.com/HigherMaestro/highwire";
export const X_HANDLE = "@Highwiredotfun";
export const X_URL = "https://x.com/Highwiredotfun";

/** Highwire's one wallet: donations and the 0.3% trade fee. Anything else claiming to collect for Highwire isn't us. */
export const DONATION_WALLET = HIGHWIRE_WALLET;
export const DONATION_URL = `https://solscan.io/account/${DONATION_WALLET}`;
