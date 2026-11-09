import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIENTS, CURSOR_LINK, VSCODE_LINK, WALLET_PATH } from "../lib/connect.ts";
import { MCP_URL } from "../lib/site.ts";

// Every client's setup on the Connect section (lib/connect.ts): it points at the hosted URL, its config parses, the
// local version carries the wallet's path in the server's own env, and each client gets Streamable HTTP spelled its
// own way (several fall back to SSE otherwise).

const byId = (id: string) => CLIENTS.find((c) => c.id === id)!;

test("every client has a way to connect, its own docs, and a unique id", () => {
  assert.ok(CLIENTS.length >= 14);
  assert.equal(new Set(CLIENTS.map((c) => c.id)).size, CLIENTS.length);
  for (const c of CLIENTS) {
    assert.ok(c.remote.link || c.remote.code || c.remote.steps?.length, c.id);
    assert.match(c.docs, /^https:\/\//, c.id);
    const text = `${c.remote.link?.href ?? ""} ${c.remote.code?.text ?? ""}`;
    if (c.remote.link || c.remote.code) assert.ok(text.includes(MCP_URL) || text.includes(encodeURIComponent(MCP_URL)) || c.id === "cursor", `${c.id} points at the hosted URL`);
  }
});

test("every JSON config parses, and no YAML config has a tab or odd indentation", () => {
  for (const c of CLIENTS) {
    for (const code of [c.remote.code, c.local?.code]) {
      if (!code) continue;
      if (code.format === "json") assert.doesNotThrow(() => JSON.parse(code.text), `${c.id}: ${code.label}`);
      if (code.format === "yaml") {
        assert.ok(!code.text.includes("\t"), c.id);
        for (const line of code.text.split("\n")) assert.equal((/^ */.exec(line)![0].length) % 2, 0, `${c.id}: ${line}`);
      }
    }
  }
});

test("every local setup runs the npm server with the wallet's path in its own env", () => {
  const local = CLIENTS.filter((c) => c.local);
  assert.ok(local.length >= 11);
  for (const c of local) {
    const t = c.local!.code.text;
    assert.ok(t.includes("highwire-mcp"), c.id);
    assert.ok(t.includes("HIGHWIRE_KEYPAIR_PATH") && t.includes(WALLET_PATH), `${c.id} sets the wallet's path`);
  }
});

test("Streamable HTTP, spelled each client's way", () => {
  assert.match(byId("openclaw").remote.code!.text, /--transport streamable-http/);
  assert.equal(JSON.parse(byId("cline").remote.code!.text).mcpServers.highwire.type, "streamableHttp");
  assert.match(byId("gemini").remote.code!.text, /--transport http /);
  assert.match(byId("continue").remote.code!.text, /type: streamable-http/);
  const goose = new URL(byId("goose").remote.link!.href);
  assert.equal(goose.protocol, "goose:");
  assert.equal(goose.searchParams.get("url"), MCP_URL);
  assert.equal(goose.searchParams.get("type"), "streamable_http");
  assert.match(byId("codex").remote.code!.text, new RegExp(`--url ${MCP_URL.replace(/[.]/g, "\\.")}$`));
  assert.equal(JSON.parse(byId("zed").remote.code!.text).context_servers.highwire.url, MCP_URL);
  assert.equal(JSON.parse(byId("cursor").local!.code.text).mcpServers["highwire-local"].type, "stdio");
});

test("the one-click links carry the URL in each client's format", () => {
  const cursor = new URL(CURSOR_LINK);
  assert.deepEqual(JSON.parse(Buffer.from(cursor.searchParams.get("config")!, "base64").toString()), { url: MCP_URL });
  assert.deepEqual(JSON.parse(decodeURIComponent(VSCODE_LINK.slice("vscode:mcp/install?".length))), { name: "highwire", type: "http", url: MCP_URL });
});
