// Live smoke test for the site and the hosted MCP endpoint. Starts `next dev`
// on a free port, then checks the pages (and /sign's security headers),
// /api/health and /mcp with the real MCP client against api.higher.fun.
// Needs network access.
//
//   npm run smoke -w highwire-web
//   SMOKE_URL=https://<domain> npm run smoke -w highwire-web   (a deployed site; starts nothing)
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The hosted endpoint serves every tool, the build tools included (HOSTED_TRANSACTION_TOOLS).
const EXPECTED_TOOLS = 22;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} didn't come up within ${ms / 1000}s`);
}

let dev: ChildProcess | undefined;
let base = process.env.SMOKE_URL?.replace(/\/$/, "");
if (!base) {
  const port = await freePort();
  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  dev = spawn(process.execPath, [nextBin, "dev", "--port", String(port)], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    detached: true,
  });
  base = `http://localhost:${port}`;
}
const stop = () => {
  if (dev?.pid) {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
};

let failed = 0;
function check(name: string, ok: boolean, detail: string) {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
}

try {
  await waitFor(`${base}/api/health`, 120_000);

  const health = (await (await fetch(`${base}/api/health`)).json()) as { ok: boolean; version: string };
  check("GET /api/health", health.ok === true, `version ${health.version}`);

  const home = await (await fetch(base)).text();
  check("GET /", home.includes("Highwire, the agent wire for higher.fun"), `${home.length} bytes`);

  for (const [path, text] of [
    ["/docs", "Highwire docs"],
    ["/terms", "Draft, pending legal review"],
    ["/privacy", "Draft, pending legal review"],
    ["/changelog", "0.3.0"],
  ] as const) {
    const page = await (await fetch(`${base}${path}`)).text();
    check(`GET ${path}`, page.includes(text), `${page.length} bytes`);
  }

  const sign = await fetch(`${base}/sign`);
  const csp = sign.headers.get("content-security-policy") ?? "";
  check(
    "GET /sign",
    sign.ok && /connect-src [^;]*solana\.com/.test(csp) && csp.includes("frame-ancestors 'none'") && sign.headers.get("referrer-policy") === "no-referrer",
    csp ? `CSP connect-src: ${/connect-src ([^;]*)/.exec(csp)?.[1]}` : "no CSP header",
  );

  const pre = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { Origin: "https://example.com" } });
  check("OPTIONS /mcp", pre.status === 204 && pre.headers.get("access-control-allow-origin") === "*", `${pre.status}`);

  const get = await fetch(`${base}/mcp`);
  check("GET /mcp", get.status === 405, `${get.status} (stateless: POST only)`);

  const client = new Client({ name: "smoke-http", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const { tools } = await client.listTools();
  check("tools/list", tools.length === EXPECTED_TOOLS, `${tools.length} tools`);

  const res = await client.callTool({ name: "get_platform_info", arguments: {} });
  const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
  if (res.isError) check("tools/call get_platform_info", false, text);
  else {
    const out = JSON.parse(text) as { launchFee: { sol: number }; solUsd?: number };
    check("tools/call get_platform_info", true, `launch fee ${out.launchFee.sol} SOL, SOL $${out.solUsd}`);
  }

  const quote = await client.callTool({ name: "quote_trade", arguments: { mint: "7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh", side: "buy", sol: 0.1 } });
  const quoteText = (quote.content as Array<{ text: string }>)[0]?.text ?? "";
  check("tools/call quote_trade", !quote.isError, quote.isError ? quoteText : `0.1 SOL buys ${JSON.parse(quoteText).tokensOut} $HIGH`);
  await client.close();
} catch (err) {
  failed++;
  console.log(`FAIL ${err instanceof Error ? err.message : String(err)}`);
} finally {
  stop();
}

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
