import { CLIENTS } from "../lib/connect.ts";
import { MCP_URL } from "../lib/site.ts";
import { ConnectPicker } from "./ConnectPicker.tsx";
import { CopyCommand } from "./CopyCommand.tsx";

// Connect: the URL, then each client's setup, one at a time (lib/connect.ts).

export function Connect() {
  return (
    <div className="connect">
      <CopyCommand label="Highwire MCP URL" code={MCP_URL} />
      <p className="muted small connect-note">
        No sign-in and no key. The hosted server is stateless, never signs, and allows 60 units a minute per IP (a build
        costs 5). Build tools hand back a link to sign in your own wallet. For an agent that acts on its own, each client
        below also shows the local server.
      </p>
      <ConnectPicker clients={CLIENTS} />
    </div>
  );
}
