import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HOSTED_TRANSACTION_TOOLS, LIST_ONLY_SIGNER, createServer } from "highwire-mcp";

// Everything the site says about the server comes from the server itself, so the
// pages can't drift from what an agent actually sees. No network involved.

export interface Param {
  name: string;
  type: string;
  required: boolean;
  description: string;
  default?: string;
}

export interface ToolInfo {
  name: string;
  title: string;
  summary: string;
  description: string;
  readOnly: boolean;
  /** Served by the hosted endpoint at /mcp. The rest run only on the local server. */
  hosted: boolean;
  /** Builds an unsigned transaction for the user's wallet. */
  builds: boolean;
  /** Returns a highwire.fun/sign link (every hosted build tool does; transfers never get one). */
  signLink: boolean;
  /** Signs and sends with the opt-in local signer, inside the user's policy. */
  executes: boolean;
  params: Param[];
}

export interface PromptInfo {
  name: string;
  title: string;
  description: string;
  args: { name: string; required: boolean; description: string }[];
}

export interface ResourceInfo {
  uri: string;
  title: string;
  description: string;
}

export interface Catalog {
  tools: ToolInfo[];
  prompts: PromptInfo[];
  resources: ResourceInfo[];
}

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  anyOf?: Schema[];
};

function typeOf(s: Schema): string {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.anyOf) return s.anyOf.map(typeOf).join(" | ");
  const base = Array.isArray(s.type) ? s.type.join(" | ") : (s.type ?? "any");
  const range =
    s.minimum !== undefined || s.maximum !== undefined
      ? ` (${s.minimum ?? "…"}–${s.maximum ?? "…"})`
      : s.maxLength !== undefined && !s.pattern
        ? ` (≤${s.maxLength} chars)`
        : "";
  return base + range;
}

function paramsOf(schema: { properties?: Record<string, Schema>; required?: string[] } | undefined): Param[] {
  const required = new Set(schema?.required ?? []);
  return Object.entries(schema?.properties ?? {}).map(([name, s]) => ({
    name,
    type: s.pattern?.startsWith("^[1-9A-HJ-NP-Za-km-z]") ? "Solana address" : typeOf(s),
    required: required.has(name) && s.default === undefined,
    description: s.description ?? "",
    ...(s.default !== undefined ? { default: JSON.stringify(s.default) } : {}),
  }));
}

function firstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](\s|$)/);
  return (match ? match[0] : text).trim();
}

let cached: Promise<Catalog> | undefined;

export function getCatalog(): Promise<Catalog> {
  cached ??= load();
  return cached;
}

async function connect(opts: Parameters<typeof createServer>[0]) {
  const server = createServer(opts);
  const client = new Client({ name: "highwire-site", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function load(): Promise<Catalog> {
  // The full local server (with the local signer's tools, listed from a signer that holds no key), and the hosted one
  // as the /mcp route configures it.
  const [client, hostedClient] = await Promise.all([
    connect({ signer: LIST_ONLY_SIGNER }),
    connect({ transactionTools: HOSTED_TRANSACTION_TOOLS, hosted: true }),
  ]);
  try {
    const [{ tools }, { prompts }, { resources }, { resourceTemplates }, hostedTools] = await Promise.all([
      client.listTools(),
      client.listPrompts(),
      client.listResources(),
      client.listResourceTemplates(),
      hostedClient.listTools(),
    ]);
    const hosted = new Set(hostedTools.tools.map((t) => t.name));
    return {
      tools: tools.map((t) => {
        const readOnly = t.annotations?.readOnlyHint === true;
        const executes = t.annotations?.destructiveHint === true;
        const builds = !readOnly && !executes;
        return {
          name: t.name,
          title: t.title ?? t.annotations?.title ?? t.name,
          summary: firstSentence(t.description ?? ""),
          description: t.description ?? "",
          readOnly,
          hosted: hosted.has(t.name),
          builds,
          signLink: builds && hosted.has(t.name),
          executes,
          params: paramsOf(t.inputSchema as Parameters<typeof paramsOf>[0]),
        };
      }),
      prompts: prompts.map((p) => ({
        name: p.name,
        title: p.title ?? p.name,
        description: p.description ?? "",
        args: (p.arguments ?? []).map((a) => ({ name: a.name, required: a.required === true, description: a.description ?? "" })),
      })),
      resources: [
        ...resources.map((r) => ({ uri: r.uri, title: r.title ?? r.name, description: r.description ?? "" })),
        ...resourceTemplates.map((r) => ({ uri: r.uriTemplate, title: r.title ?? r.name, description: r.description ?? "" })),
      ],
    };
  } finally {
    await Promise.all([client.close(), hostedClient.close()]);
  }
}

export const TOOL_GROUPS: { id: string; title: string; blurb: string; tools: string[] }[] = [
  {
    id: "discover",
    title: "Discover",
    blurb: "What's launching, trending and about to graduate.",
    tools: ["list_coins", "search_coins", "get_top_coins", "get_featured_coin", "get_trade_tape", "get_leaderboard"],
  },
  {
    id: "research",
    title: "Research a coin",
    blurb: "Price, holders, trades, candles and the comment thread.",
    tools: ["get_coin", "get_coin_trades", "get_coin_holders", "get_coin_candles", "get_coin_comments"],
  },
  {
    id: "wallets",
    title: "Creators and wallets",
    blurb: "Who launched what, and how it went.",
    tools: ["get_wallet_profile", "get_creator_coins"],
  },
  {
    id: "safety",
    title: "Safety and platform",
    blurb: "Rug checks, fee modes, tickers and site chat.",
    tools: ["rug_check", "get_platform_info", "check_ticker", "get_chat"],
  },
  {
    id: "trade",
    title: "Trade and launch",
    blurb: "Quotes, positions, and transactions you review and sign in your own wallet on highwire.fun/sign.",
    tools: ["quote_trade", "get_wallet_positions", "build_trade", "build_launch", "build_claim_creator_fees"],
  },
  {
    id: "signer",
    title: "Local signer",
    blurb: "Opt-in, on your own machine: signs and sends only inside the policy file you write, and dry-runs by default.",
    tools: ["get_signer_status", "execute_trade", "execute_launch", "execute_claim", "execute_transfer", "build_transfer"],
  },
];

/** Tools in their groups, with any tool the groups don't name collected under "More". */
export function groupTools(tools: ToolInfo[]) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const used = new Set<string>();
  const groups = TOOL_GROUPS.map((g) => ({
    ...g,
    items: g.tools.flatMap((n) => {
      const t = byName.get(n);
      if (!t) return [];
      used.add(n);
      return [t];
    }),
  }));
  const rest = tools.filter((t) => !used.has(t.name));
  if (rest.length) groups.push({ id: "more", title: "More", blurb: "", tools: [], items: rest });
  return groups.filter((g) => g.items.length);
}
