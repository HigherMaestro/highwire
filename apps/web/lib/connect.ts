import { MCP_URL } from "./site.ts";

// One-click install links for each client. These are the formats each client
// documents; if one changes, the manual steps beside it still work.

export const CLAUDE_CODE_COMMAND = `claude mcp add --transport http highwire ${MCP_URL}`;

export const CLAUDE_CONNECTOR_LINK =
  "https://claude.ai/customize/connectors?" +
  new URLSearchParams({ modal: "add-custom-connector", connectorName: "Highwire", connectorUrl: MCP_URL }).toString();

export const CURSOR_LINK =
  "cursor://anysphere.cursor-deeplink/mcp/install?" +
  new URLSearchParams({ name: "highwire", config: Buffer.from(JSON.stringify({ url: MCP_URL })).toString("base64") }).toString();

export const VSCODE_LINK = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "highwire", type: "http", url: MCP_URL }))}`;

export const REMOTE_CONFIG = JSON.stringify({ mcpServers: { highwire: { url: MCP_URL } } }, null, 2);

/** The local server from npm, with the local signer's tools available once HIGHWIRE_KEYPAIR_PATH is set. */
export const LOCAL_COMMAND = "claude mcp add highwire -- npx -y highwire-mcp";
