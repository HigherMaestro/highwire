import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type ServerOptions } from "../src/server.ts";
import { serverOptionsFromEnv } from "../src/env.ts";
import { FAKE_OPTIONS } from "./fake.ts";

// Link battles' tools (docs/link-battles.md 6): off until rated play opens (HIGHWIRE_LINK=1 turns them on), link_rules
// asks the referee, and link_practice exists only with the local signer (it plays with the fighter's arena token). The
// referee's practice routes are tested in highwire-relay with a fake engine.

async function connect(opts: Partial<ServerOptions>) {
  const server = createServer({ ...FAKE_OPTIONS, ...opts } as ServerOptions);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("link battles' tools are off by default and with HIGHWIRE_LINK unset", async () => {
  assert.equal(serverOptionsFromEnv({}).link, false);
  assert.equal(serverOptionsFromEnv({ HIGHWIRE_LINK: "1" }).link, true);
  const names = (await (await connect({})).listTools()).tools.map((t) => t.name);
  assert.ok(!names.some((n) => n.startsWith("link_")));
});

test("with them on and no signer, only the rules, read from the referee", async () => {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "relay.test") {
      calls.push(url.pathname);
      return Response.json({ format: "colosseum-1", banned_moves: ["Counter"] });
    }
    return (FAKE_OPTIONS.fetch as typeof globalThis.fetch)(input, init);
  }) as typeof globalThis.fetch;
  const client = await connect({ link: true, fetch, relayUrl: "https://relay.test" });
  const names = (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("link_"));
  assert.deepEqual(names, ["link_rules"], "link_practice needs the local signer");
  const res = await client.callTool({ name: "link_rules", arguments: {} });
  const body = JSON.parse((res.content as { text: string }[])[0]!.text);
  assert.equal(body.format, "colosseum-1");
  assert.deepEqual(calls, ["/api/link/rules"]);
});
