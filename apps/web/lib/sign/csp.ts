import { createHash } from "node:crypto";
import { THEME_SCRIPT } from "../theme.ts";

// The sign page's Content-Security-Policy, set per request by proxy.ts with a fresh nonce. Next.js puts the nonce on
// its own scripts, so no other inline script can run: an HTML injection stays inert. The theme script, the one inline
// script of our own, is allowed by its hash. The page may connect only to the Solana RPCs, so it cannot send anything
// to Highwire or anyone else. Wallet extensions inject their own scripts outside the page's CSP; their icons are data:
// URIs.

const PUBLIC_RPCS = ["https://api.mainnet-beta.solana.com", "https://api.devnet.solana.com"];

/** The RPC origins the sign page may call: the configured ones (NEXT_PUBLIC_*), else the public endpoints. */
export function rpcOrigins(): string[] {
  const configured = [process.env.NEXT_PUBLIC_SOLANA_RPC_URL, process.env.NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL];
  const urls = [configured[0] || PUBLIC_RPCS[0]!, configured[1] || PUBLIC_RPCS[1]!];
  return [...new Set(urls.map((u) => new URL(u).origin))];
}

const THEME_HASH = `'sha256-${createHash("sha256").update(THEME_SCRIPT).digest("base64")}'`;

export function signCsp(nonce: string, isDev = process.env.NODE_ENV === "development"): string {
  return [
    "default-src 'none'",
    // 'strict-dynamic': scripts the nonce'd ones load may run; 'self' is ignored by browsers that understand it.
    `script-src 'self' 'nonce-${nonce}' ${THEME_HASH} 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // Dev adds 'self' for hot reload's websocket.
    `connect-src ${rpcOrigins().join(" ")}${isDev ? " 'self'" : ""}`,
    "manifest-src 'self'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}
