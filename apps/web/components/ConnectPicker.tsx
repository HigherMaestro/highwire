"use client";

import { useEffect, useState } from "react";
import type { ClientSetup } from "../lib/connect.ts";
import { CopyCommand } from "./CopyCommand.tsx";

// Connect, one client at a time: a row of clients, and the chosen one's setup underneath, so the section stays short
// however many clients there are. Each shows how to connect (a one-click link, a command or a config), and, where the
// client can run a local server, how to let an agent act on its own through the local signer. The choice is kept in
// the URL's hash (#connect-<id>) so a link can open on a client.

export function ConnectPicker({ clients }: { clients: ClientSetup[] }) {
  const [id, setId] = useState(clients[0]!.id);

  useEffect(() => {
    const fromHash = () => {
      const m = /^#connect-([a-z0-9-]+)$/.exec(window.location.hash);
      if (m && clients.some((c) => c.id === m[1])) setId(m[1]!);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [clients]);

  const c = clients.find((x) => x.id === id) ?? clients[0]!;
  return (
    <div className="picker">
      <div className="picker-tabs" role="tablist" aria-label="Your client">
        {clients.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            id={`connect-tab-${x.id}`}
            aria-selected={x.id === c.id}
            aria-controls="connect-panel"
            className={x.id === c.id ? "is-on" : ""}
            onClick={() => {
              setId(x.id);
              history.replaceState(null, "", `#connect-${x.id}`);
            }}
          >
            {x.name}
          </button>
        ))}
      </div>
      <div className="picker-panel" id="connect-panel" role="tabpanel" aria-labelledby={`connect-tab-${c.id}`}>
        <div className="picker-part">
          <h3>Connect</h3>
          {c.remote.note ? <p className="muted small">{c.remote.note}</p> : null}
          {c.remote.link ? (
            <a className="button" href={c.remote.link.href} {...(c.remote.link.href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
              {c.remote.link.label}
            </a>
          ) : null}
          {c.remote.code ? <CopyCommand label={`${c.name}: ${c.remote.code.label}`} code={c.remote.code.text} multiline={c.remote.code.text.includes("\n") || c.remote.code.text.length > 60} /> : null}
          {c.remote.steps?.length ? (
            <ol className="steps small">
              {c.remote.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          ) : null}
        </div>
        {c.local ? (
          <div className="picker-part">
            <h3>Act on its own</h3>
            <p className="muted small">
              The local server from npm, with the local signer: the agent can launch, trade and play The Line from its own
              wallet, inside a policy only you write. {c.local.note ?? ""}
            </p>
            <CopyCommand label={`${c.name}: ${c.local.code.label}`} code={c.local.code.text} multiline />
            <p className="muted small">
              Replace the path with your wallet&apos;s (<code>npx -y highwire-mcp wallet new</code> makes one). See{" "}
              <a href="/docs#local-signer">the local signer</a>.
            </p>
          </div>
        ) : null}
        <p className="muted small picker-source">
          From {c.name}&apos;s own docs: <a href={c.docs}>{c.docs.replace(/^https:\/\//, "").replace(/\/$/, "")}</a>
        </p>
      </div>
    </div>
  );
}
