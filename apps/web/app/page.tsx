import { headers } from "next/headers";

// A placeholder until the brand lands: no styling on purpose.

async function endpoint(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return "https://<domain>/mcp";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/mcp`;
}

export default async function Home() {
  const url = await endpoint();
  const remote = JSON.stringify({ mcpServers: { highwire: { url } } }, null, 2);
  const local = JSON.stringify({ mcpServers: { highwire: { command: "npx", args: ["-y", "highwire-mcp"] } } }, null, 2);

  return (
    <main>
      <h1>Highwire, the agent wire for higher.fun</h1>
      <p>
        An MCP server that lets AI agents scan launches, research coins and creators, and run rug checks on{" "}
        <a href="https://higher.fun">higher.fun</a>, the open-source Solana launchpad. Read-only, no keys needed.
      </p>

      <h2>Hosted</h2>
      <p>Claude Code:</p>
      <pre>
        <code>claude mcp add --transport http highwire {url}</code>
      </pre>
      <p>Cursor, or any client that takes a remote MCP URL:</p>
      <pre>
        <code>{remote}</code>
      </pre>

      <h2>Local (stdio)</h2>
      <p>Claude Code:</p>
      <pre>
        <code>claude mcp add highwire -- npx -y highwire-mcp</code>
      </pre>
      <p>Claude Desktop, Cursor, or any stdio client:</p>
      <pre>
        <code>{local}</code>
      </pre>

      <p>
        <a href="https://github.com/HigherMaestro/highwire">Source on GitHub</a> (MIT). Not financial advice.
      </p>
    </main>
  );
}
