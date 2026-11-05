import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "highwire-mcp";

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

async function load(): Promise<Catalog> {
  const server = createServer();
  const client = new Client({ name: "highwire-site", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const [{ tools }, { prompts }, { resources }, { resourceTemplates }] = await Promise.all([
      client.listTools(),
      client.listPrompts(),
      client.listResources(),
      client.listResourceTemplates(),
    ]);
    return {
      tools: tools.map((t) => ({
        name: t.name,
        title: t.title ?? t.annotations?.title ?? t.name,
        summary: firstSentence(t.description ?? ""),
        description: t.description ?? "",
        readOnly: t.annotations?.readOnlyHint === true,
        params: paramsOf(t.inputSchema as Parameters<typeof paramsOf>[0]),
      })),
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
    await client.close();
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
