import {
  CLAUDE_CODE_COMMAND,
  CLAUDE_CONNECTOR_LINK,
  CURSOR_LINK,
  LOCAL_COMMAND,
  REMOTE_CONFIG,
  VSCODE_LINK,
} from "../lib/connect.ts";
import { MCP_URL } from "../lib/site.ts";
import { CopyCommand } from "./CopyCommand.tsx";

export function Connect() {
  return (
    <div className="connect">
      <CopyCommand label="Highwire MCP URL" code={MCP_URL} />
      <p className="muted small connect-note">
        No sign-in and no key. The server is stateless, never signs, and allows 60 units a minute per IP (a build costs
        5). Build tools hand back a link to sign in your own wallet.
      </p>
      <div className="cards">
        <div className="card">
          <h3>Claude</h3>
          <p className="muted small">claude.ai and the desktop apps, on any plan.</p>
          <a className="button" href={CLAUDE_CONNECTOR_LINK} target="_blank" rel="noopener noreferrer">
            Add to Claude
          </a>
          <ol className="steps small">
            <li>The button opens Claude&apos;s connector settings with Highwire filled in. Check it and click Add.</li>
            <li>
              In a chat, open <strong>+</strong> → <strong>Connectors</strong> and turn Highwire on.
            </li>
          </ol>
          <p className="muted small">
            Or by hand: Settings → Connectors → Add custom connector, then paste the URL above.
          </p>
        </div>

        <div className="card">
          <h3>Claude Code</h3>
          <CopyCommand label="Claude Code command" code={CLAUDE_CODE_COMMAND} multiline />
        </div>

        <div className="card">
          <h3>Cursor</h3>
          <a className="button" href={CURSOR_LINK}>
            Add to Cursor
          </a>
          <p className="muted small">Or add this to Cursor&apos;s MCP settings:</p>
          <CopyCommand label="Cursor MCP config" code={REMOTE_CONFIG} multiline />
        </div>

        <div className="card">
          <h3>VS Code</h3>
          <a className="button" href={VSCODE_LINK}>
            Add to VS Code
          </a>
          <p className="muted small">
            Or run <strong>MCP: Add Server</strong> from the command palette, choose HTTP, and paste the URL above.
          </p>
        </div>

        <div className="card">
          <h3>ChatGPT and other clients</h3>
          <p className="muted small">
            Any client that takes a remote MCP server: add a server with the URL above and no authentication. In ChatGPT
            that means turning on developer mode and creating a custom connector.
          </p>
          <CopyCommand label="Generic MCP config" code={REMOTE_CONFIG} multiline />
        </div>

        <div className="card">
          <h3>Run it locally</h3>
          <p className="muted small">
            The same tools on your own computer, from npm, with your own RPC and no shared rate limit. Set{" "}
            <code>HIGHWIRE_KEYPAIR_PATH</code> to let an agent act inside a policy you write; see{" "}
            <a href="/docs#local-signer">the local signer</a>.
          </p>
          <CopyCommand label="Add the local server to Claude Code" code={LOCAL_COMMAND} multiline />
        </div>
      </div>
    </div>
  );
}
