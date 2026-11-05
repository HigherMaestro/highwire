import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const root = fileURLToPath(new URL("../..", import.meta.url));

const config: NextConfig = {
  // Build the workspace packages from source, so the site needs no prior build
  // step (on Vercel either). Turbopack has no custom export conditions, so
  // these aliases stand in for the "highwire-source" condition.
  transpilePackages: ["highwire-core", "highwire-mcp"],
  turbopack: {
    root,
    resolveAlias: {
      "highwire-core": "../../packages/core/src/index.ts",
      "highwire-mcp": "../../packages/mcp/src/index.ts",
    },
  },
  outputFileTracingRoot: root,
  // The repo's own AGENTS.md covers this app; don't let `next dev` write another.
  agentRules: false,
};

export default config;
