import { MCP_URL } from "./site.ts";

// How to add Highwire to each client: the hosted server (one click, a command or a config), and, for clients that run
// local servers, the local server with the signer. Every format here was checked against the client's own docs or
// source in November 2026 (the `docs` link on each); test/connect.test.ts checks the snippets parse and say what they
// should. Clients disagree on how to spell Streamable HTTP, and some fall back to SSE without it: OpenClaw needs
// transport "streamable-http", Cline type "streamableHttp", Gemini CLI the httpUrl key, Goose type streamable_http
// with a uri.

export const CLAUDE_CODE_COMMAND = `claude mcp add --transport http highwire ${MCP_URL}`;

export const CLAUDE_CONNECTOR_LINK =
  "https://claude.ai/customize/connectors?" +
  new URLSearchParams({ modal: "add-custom-connector", connectorName: "Highwire", connectorUrl: MCP_URL }).toString();

export const CURSOR_LINK =
  "cursor://anysphere.cursor-deeplink/mcp/install?" +
  new URLSearchParams({ name: "highwire", config: Buffer.from(JSON.stringify({ url: MCP_URL })).toString("base64") }).toString();

export const VSCODE_LINK = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "highwire", type: "http", url: MCP_URL }))}`;

export const REMOTE_CONFIG = JSON.stringify({ mcpServers: { highwire: { url: MCP_URL } } }, null, 2);

/** The example wallet path in local setups; the reader swaps in their own. */
export const WALLET_PATH = "/Users/you/.highwire/wallet.json";

/** The local server from npm, with the local signer's tools once the wallet's path is set. */
export const LOCAL_COMMAND = `claude mcp add highwire -e HIGHWIRE_KEYPAIR_PATH=${WALLET_PATH} -- npx -y highwire-mcp`;

type Format = "shell" | "json" | "toml" | "yaml";

/** How one client connects: to the hosted server, and (where it can run one) to the local server with the signer. */
export interface ClientSetup {
  id: string;
  name: string;
  remote: {
    note?: string;
    /** A one-click install link. */
    link?: { href: string; label: string };
    /** A command to run or a config to paste. */
    code?: { label: string; text: string; format: Format };
    steps?: string[];
  };
  /** The local server with the local signer, for clients that run local (stdio) servers. */
  local?: { code: { label: string; text: string; format: Format }; note?: string };
  /** The client's own documentation for adding a server, where each format was confirmed. */
  docs: string;
}

const json = (o: unknown) => JSON.stringify(o, null, 2);
const STDIO = { command: "npx", args: ["-y", "highwire-mcp"], env: { HIGHWIRE_KEYPAIR_PATH: WALLET_PATH } };

const GOOSE_LINK =
  "goose://extension?" +
  new URLSearchParams({ url: MCP_URL, type: "streamable_http", id: "highwire", name: "Highwire", description: "higher.fun for agents" }).toString();

export const CLIENTS: ClientSetup[] = [
  {
    id: "claude",
    name: "Claude",
    remote: {
      note: "claude.ai and the desktop apps, on any plan.",
      link: { href: CLAUDE_CONNECTOR_LINK, label: "Add to Claude" },
      steps: ["The button opens Claude's connector settings with Highwire filled in. Check it and click Add.", "In a chat, open + → Connectors and turn Highwire on."],
    },
    local: {
      code: { label: "Claude Desktop config", text: json({ mcpServers: { highwire: STDIO } }), format: "json" },
      note: "In Claude Desktop: Settings → Developer → Edit Config, add this, then quit and reopen it.",
    },
    docs: "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    remote: { code: { label: "command", text: CLAUDE_CODE_COMMAND, format: "shell" } },
    local: { code: { label: "local command", text: LOCAL_COMMAND, format: "shell" } },
    docs: "https://code.claude.com/docs/en/mcp",
  },
  {
    id: "codex",
    name: "Codex",
    remote: {
      note: "The Codex CLI, the IDE extension and the ChatGPT desktop app share one MCP config.",
      code: { label: "command", text: `codex mcp add highwire --url ${MCP_URL}`, format: "shell" },
    },
    local: { code: { label: "local command", text: `codex mcp add highwire-local --env HIGHWIRE_KEYPAIR_PATH=${WALLET_PATH} -- npx -y highwire-mcp`, format: "shell" } },
    docs: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
  },
  {
    id: "cursor",
    name: "Cursor",
    remote: { link: { href: CURSOR_LINK, label: "Add to Cursor" }, code: { label: "MCP config", text: REMOTE_CONFIG, format: "json" } },
    local: { code: { label: "~/.cursor/mcp.json", text: json({ mcpServers: { "highwire-local": { type: "stdio", ...STDIO } } }), format: "json" }, note: "In ~/.cursor/mcp.json (or .cursor/mcp.json in a project)." },
    docs: "https://cursor.com/docs/mcp",
  },
  {
    id: "vscode",
    name: "VS Code",
    remote: { link: { href: VSCODE_LINK, label: "Add to VS Code" }, steps: ["Or run MCP: Add Server from the command palette, choose HTTP, and paste the URL above."] },
    docs: "https://code.visualstudio.com/docs/copilot/customization/mcp-servers",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    remote: { code: { label: "command", text: `gemini mcp add -s user --transport http highwire ${MCP_URL}`, format: "shell" } },
    local: {
      code: { label: "local command", text: `gemini mcp add -s user -e HIGHWIRE_KEYPAIR_PATH=${WALLET_PATH} highwire-local npx -- -y highwire-mcp`, format: "shell" },
      note: "Gemini CLI drops any variable with KEY in its name from your shell, so the wallet's path must be given here, as -e.",
    },
    docs: "https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md",
  },
  {
    id: "devin",
    name: "Windsurf / Devin",
    remote: {
      note: "Windsurf is now Devin Desktop. In the app: Customize → MCPs; or add this to ~/.config/devin/mcp_config.json (%APPDATA%\\devin\\mcp_config.json on Windows).",
      code: { label: "mcp_config.json", text: json({ mcpServers: { highwire: { url: MCP_URL } } }), format: "json" },
    },
    local: { code: { label: "mcp_config.json", text: json({ mcpServers: { "highwire-local": STDIO } }), format: "json" } },
    docs: "https://docs.devin.ai/desktop/devin-local/customizations",
  },
  {
    id: "zed",
    name: "Zed",
    remote: {
      note: "In Zed: Settings → AI → MCP Servers → Add Remote Server, or add this to your settings file (zed: open settings file).",
      code: { label: "settings.json", text: json({ context_servers: { highwire: { url: MCP_URL } } }), format: "json" },
    },
    local: { code: { label: "settings.json", text: json({ context_servers: { "highwire-local": STDIO } }), format: "json" } },
    docs: "https://zed.dev/docs/ai/mcp",
  },
  {
    id: "goose",
    name: "Goose",
    remote: {
      link: { href: GOOSE_LINK, label: "Add to Goose" },
      steps: ["Or in Goose: goose configure → Add Extension → Remote Extension (Streamable HTTP), and paste the URL above."],
    },
    local: {
      code: {
        label: "~/.config/goose/config.yaml",
        text: `extensions:\n  highwire-local:\n    type: stdio\n    name: highwire-local\n    enabled: true\n    cmd: npx\n    args: ["-y", "highwire-mcp"]\n    envs:\n      HIGHWIRE_KEYPAIR_PATH: "${WALLET_PATH}"\n    timeout: 300`,
        format: "yaml",
      },
      note: "Under extensions in ~/.config/goose/config.yaml.",
    },
    docs: "https://goose-docs.ai/docs/getting-started/using-extensions",
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    remote: {
      code: { label: "command", text: `hermes mcp add highwire --url ${MCP_URL}`, format: "shell" },
      steps: ["When it asks whether the server needs authentication, answer n. Then enable its tools."],
    },
    local: {
      code: { label: "local command", text: `hermes mcp add highwire-local --command npx --env HIGHWIRE_KEYPAIR_PATH=${WALLET_PATH} --args -y highwire-mcp`, format: "shell" },
      note: "Run /reload-mcp in a session afterwards.",
    },
    docs: "https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp",
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    remote: {
      note: "Stop the local Gateway first: adding a server needs it stopped.",
      code: { label: "command", text: `openclaw mcp add highwire --url ${MCP_URL} --transport streamable-http`, format: "shell" },
    },
    local: { code: { label: "local command", text: `openclaw mcp add highwire-local --command npx --arg -y --arg highwire-mcp --env HIGHWIRE_KEYPAIR_PATH=${WALLET_PATH}`, format: "shell" } },
    docs: "https://docs.openclaw.ai/cli/mcp",
  },
  {
    id: "cline",
    name: "Cline",
    remote: {
      note: "In Cline: MCP Servers → Configure → Configure MCP Servers, and add this under mcpServers.",
      code: { label: "cline_mcp_settings.json", text: json({ mcpServers: { highwire: { type: "streamableHttp", url: MCP_URL } } }), format: "json" },
    },
    local: { code: { label: "cline_mcp_settings.json", text: json({ mcpServers: { "highwire-local": STDIO } }), format: "json" } },
    docs: "https://docs.cline.bot/mcp/mcp-overview",
  },
  {
    id: "continue",
    name: "Continue",
    remote: {
      note: "MCP works in agent mode. Add this to your config.yaml.",
      code: { label: "config.yaml", text: `mcpServers:\n  - name: highwire\n    type: streamable-http\n    url: ${MCP_URL}`, format: "yaml" },
    },
    local: {
      code: {
        label: "config.yaml",
        text: `mcpServers:\n  - name: highwire-local\n    type: stdio\n    command: npx\n    args: ["-y", "highwire-mcp"]\n    env:\n      HIGHWIRE_KEYPAIR_PATH: "${WALLET_PATH}"`,
        format: "yaml",
      },
    },
    docs: "https://docs.continue.dev/customize/deep-dives/mcp",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    remote: {
      steps: [
        "On chatgpt.com, open Plugins, then + → Add custom MCP server.",
        "Name it Highwire, paste the URL above, and choose No authentication.",
        "Accept the warning, create it, and install it. ChatGPT asks before any tool that isn't read-only.",
      ],
    },
    docs: "https://developers.openai.com/api/docs/guides/custom-mcp-server",
  },
];
