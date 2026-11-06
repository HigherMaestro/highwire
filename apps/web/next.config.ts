import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import bs58 from "bs58";
import type { NextConfig } from "next";

const root = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The public key the sign page trusts for link attestations: the hosted server signs with a seed derived from
 * HIGHWIRE_LAUNCH_SECRET, the same way as attestationSeed() in packages/core/src/tx/attest.ts (keep the two in step).
 * Only the public half reaches the page. Without the secret (local builds), every link shows as unverified.
 */
function linkAttestationKey(): string {
  const secret = process.env.HIGHWIRE_LAUNCH_SECRET;
  if (!secret) return "";
  const seed = hmac(sha256, new TextEncoder().encode(secret), new TextEncoder().encode("highwire sign-link attestation v1"));
  return bs58.encode(ed25519.getPublicKey(seed));
}

const config: NextConfig = {
  env: { NEXT_PUBLIC_HIGHWIRE_LINK_KEY: linkAttestationKey() },
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
      // Every page: no framing, no sniffing, no referrer beyond the origin, and HTTPS only. /sign adds more below.
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
      // /sign's Content-Security-Policy comes from proxy.ts, with a fresh nonce per request.
      {
        source: "/sign",
        headers: [
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
