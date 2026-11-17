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
        No sign-in and no key. To buy, sell, launch or claim, Highwire hands back a link you sign in your own wallet. For
        an agent that acts on its own, each client below also shows the local server.
      </p>
      <ConnectPicker clients={CLIENTS} />
    </div>
  );
}
