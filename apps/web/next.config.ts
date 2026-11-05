import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const root = fileURLToPath(new URL("../..", import.meta.url));
const isDev = process.env.NODE_ENV === "development";

const PUBLIC_RPCS = ["https://api.mainnet-beta.solana.com", "https://api.devnet.solana.com"];

/** The RPC origins the sign page may call: the configured ones (NEXT_PUBLIC_*), else the public endpoints. */
function rpcOrigins(): string[] {
  const configured = [process.env.NEXT_PUBLIC_SOLANA_RPC_URL, process.env.NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL];
  const urls = [configured[0] || PUBLIC_RPCS[0]!, configured[1] || PUBLIC_RPCS[1]!];
  return [...new Set(urls.map((u) => new URL(u).origin))];
}

/**
 * The signing page's policy. Scripts and styles come from this site only ('unsafe-inline' because Next.js inlines its
 * bootstrap scripts in static pages and the theme script runs before paint; no third-party script is allowed). The page
 * may connect only to the Solana RPCs, so it cannot send anything to Highwire or anyone else. Wallet extensions inject
 * their own scripts outside the page's CSP; their icons are data: URIs.
 */
function signCsp(): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
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

const config: NextConfig = {
  // Build the workspace packages from source, so the site needs no prior build
  // step (on Vercel either). Turbopack has no custom export conditions, so
  // these aliases stand in for the "highwire-source" condition.
  transpilePackages: ["highwire-core", "highwire-mcp"],
  turbopack: {
    root,
    resolveAlias: {
      "highwire-core/browser": "../../packages/core/src/browser.ts",
      "highwire-core": "../../packages/core/src/index.ts",
      "highwire-mcp": "../../packages/mcp/src/index.ts",
    },
  },
  outputFileTracingRoot: root,
  // The repo's own AGENTS.md covers this app; don't let `next dev` write another.
  agentRules: false,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/sign",
        headers: [
          { key: "Content-Security-Policy", value: signCsp() },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default config;
