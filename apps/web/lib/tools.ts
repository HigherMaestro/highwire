import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "highwire-mcp";

export interface ToolInfo {
  name: string;
  title: string;
  description: string;
}

/** The tool list, read from the real server so the site can't drift from it. No network involved. */
export async function listTools(): Promise<ToolInfo[]> {
  const server = createServer();
  const client = new Client({ name: "highwire-site", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => ({
      name: t.name,
      title: t.title ?? t.annotations?.title ?? t.name,
      description: firstSentence(t.description ?? ""),
    }));
  } finally {
    await client.close();
  }
}

function firstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](\s|$)/);
  return (match ? match[0] : text).trim();
}
