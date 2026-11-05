import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "../../components/Chrome.tsx";
import { Connect } from "../../components/Connect.tsx";
import { getCatalog, groupTools, type ToolInfo } from "../../lib/catalog.ts";
import { MCP_URL, REPO_URL } from "../../lib/site.ts";

export const metadata: Metadata = {
  title: "Docs",
  description: "Connect Highwire to your MCP client, and every tool, prompt and resource it offers, with parameters.",
  alternates: { canonical: "/docs" },
};

const RECIPES: { title: string; ask: string; prompt: string; steps: string[] }[] = [
  {
    title: "Find coins worth a look",
    ask: "Find three coins close to graduating on higher.fun and rug-check them.",
    prompt: "scan_launches",
    steps: ["list_coins (sort: graduating, trending or new)", "rug_check on the best few", "get_coin for the survivors"],
  },
  {
    title: "Vet one coin",
    ask: "Is $TICKER on higher.fun safe? Check holders, trades and the creator.",
    prompt: "coin_due_diligence",
    steps: [
      "get_coin and rug_check",
      "get_coin_holders, ignoring the labelled curve, pool and lock",
      "get_coin_trades and get_coin_candles",
      "get_wallet_profile on the creator",
      "get_coin_comments for scams and sentiment",
    ],
  },
  {
    title: "Check a creator",
    ask: "What else has this wallet launched on higher.fun, and how did it go?",
    prompt: "creator_report",
    steps: ["get_wallet_profile", "get_creator_coins", "get_coin on their recent coins"],
  },
  {
    title: "Plan a launch",
    ask: "Help me plan a higher.fun launch for a cat coin. Old school or New school?",
    prompt: "plan_launch",
    steps: ["get_platform_info for the fee modes and launch fee", "check_ticker for each idea", "build_launch once you approve"],
  },
  {
    title: "Buy a coin",
    ask: "Buy 0.1 SOL of $TICKER on higher.fun for my wallet <address>, with 2% slippage.",
    prompt: "coin_due_diligence",
    steps: ["rug_check and quote_trade, shown to you", "build_trade after you approve", "you open sign_url and sign in your wallet"],
  },
];

const POLICY_KEYS: [string, string][] = [
  ["cluster", "mainnet or devnet. Required, so mainnet is always a deliberate choice."],
  ["live", "false (the default) makes every execute a dry run. true lets it sign and send."],
  ["actions", "Which of trade, launch, claim and transfer it may do."],
  ["max_sol_per_tx", "The most SOL one execute may spend: a buy, a launch fee plus first buy, or SOL sent."],
  ["max_sol_per_day", "The most SOL in any 24 hours, counted from the audit log."],
  ["max_slippage_bps", "The most slippage a trade or first buy may allow."],
  ["coins", "allow: only these coins; deny: never these. For trades and coin transfers."],
  ["creators", "allow: only trade coins launched by these wallets."],
  ["transfer_allowlist", "The only wallets transfers may go to. Empty by default."],
];

const ERRORS: [string, string][] = [
  ["not_found", "Unknown mint, wallet or coin. Check the address, or use search_coins."],
  ["bad_request", "A parameter was out of range or the wrong shape. The message says which."],
  ["rate_limited", "Too many requests. Wait a few seconds, then retry once."],
  ["simulation_failed", "The built transaction would fail on-chain: usually too little SOL or tokens, or the price moved. Quote again."],
  ["unsafe_transaction", "A safety check on the built transaction failed. Nothing to sign; please report it."],
  ["unavailable", "higher.fun or the Solana RPC didn't answer. Retry later."],
  ["no_policy", "The local signer has no policy file, so nothing executes. Run npx highwire-mcp policy init."],
  ["policy_refused", "The local signer's policy doesn't allow this. Only you can change the policy file."],
  ["signer_stopped", "~/.highwire/STOP exists, so the local signer refuses everything until you delete it."],
  ["internal_error", "Something unexpected. Please open an issue on GitHub."],
];

function ToolDoc({ tool }: { tool: ToolInfo }) {
  return (
    <article className="doc-tool" id={tool.name} aria-labelledby={`${tool.name}-h`}>
      <div className="doc-tool-head">
        <h4 id={`${tool.name}-h`}>
          <a href={`#${tool.name}`} className="anchor">
            <code>{tool.name}</code>
          </a>
        </h4>
        <span className="badges">
          {tool.hosted ? <span className="badge">hosted</span> : <span className="badge">local only</span>}
          {tool.readOnly ? (
            <span className="badge">read-only</span>
          ) : tool.executes ? (
            <span className="badge badge-warn">signs and sends inside your policy</span>
          ) : (
            <span className="badge badge-warn">builds a transaction you sign</span>
          )}
          {tool.signLink ? <span className="badge">returns a sign link</span> : null}
        </span>
      </div>
      <p className="muted">{tool.description}</p>
      {tool.params.length ? (
        <div className="table-wrap">
          <table className="params">
            <caption className="sr-only">Parameters for {tool.name}</caption>
            <thead>
              <tr>
                <th scope="col">Parameter</th>
                <th scope="col">Type</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {tool.params.map((p) => (
                <tr key={p.name}>
                  <td data-label="Parameter">
                    <code>{p.name}</code>
                    {p.required ? <span className="req"> required</span> : null}
                  </td>
                  <td data-label="Type" className="mono-cell">
                    {p.type}
                  </td>
                  <td data-label="Details">
                    {p.description}
                    {p.description && !/[.!?)]$/.test(p.description) ? "." : null}
                    {p.default ? <span className="muted"> Default {p.default}.</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">No parameters.</p>
      )}
    </article>
  );
}

export default async function Docs() {
  const catalog = await getCatalog();
  const groups = groupTools(catalog.tools);
  const toc = [
    ["connect", "Connect"],
    ["signing", "Signing"],
    ["local-signer", "Local signer"],
    ["tools", `Tools (${catalog.tools.length})`],
    ["prompts", `Prompts (${catalog.prompts.length})`],
    ["resources", `Resources (${catalog.resources.length})`],
    ["recipes", "Recipes"],
    ["limits", "Limits and errors"],
    ["troubleshooting", "Troubleshooting"],
  ];

  return (
    <>
      <SiteHeader />
      <main className="docs">
        <div className="wrap docs-grid">
          <nav className="docs-toc" aria-label="On this page">
            <p className="toc-title">On this page</p>
            <ul>
              {toc.map(([id, label]) => (
                <li key={id}>
                  <a href={`#${id}`}>{label}</a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="docs-body">
            <header className="docs-intro">
              <p className="eyebrow">Docs</p>
              <h1>Highwire docs</h1>
              <p className="lead">
                Highwire is an MCP server for <a href="https://higher.fun">higher.fun</a>. It gives agents{" "}
                {catalog.tools.filter((t) => t.hosted).length} hosted tools, of which{" "}
                {catalog.tools.filter((t) => t.builds && t.hosted).length} build transactions you sign in your own wallet,{" "}
                {catalog.prompts.length} prompts and {catalog.resources.length} resources. Everything below is generated
                from the running server.
              </p>
            </header>

            <section id="connect" aria-labelledby="connect-h">
              <h2 id="connect-h">Connect</h2>
              <Connect />
            </section>

            <section id="signing" aria-labelledby="signing-h">
              <h2 id="signing-h">Signing</h2>
              <p className="muted">
                Highwire never signs and never holds a key. A build tool returns an unsigned transaction and a{" "}
                <code>sign_url</code>, a link to <a href="/sign">highwire.fun/sign</a>. Your agent gives you the link; you open
                it and sign in your own wallet.
              </p>
              <ol className="plain">
                <li>
                  <strong>The link carries the transaction.</strong> It rides in the part after <code>#</code>, which browsers
                  never send to a server, so Highwire never sees it. The page sends nothing to Highwire.
                </li>
                <li>
                  <strong>The page checks it again.</strong> It decodes every instruction from the transaction itself, not from
                  the link&apos;s description, and refuses anything Highwire doesn&apos;t build: a program off the allow-list,
                  SOL sent to someone else, another platform, another fee payer.
                </li>
                <li>
                  <strong>You see what it does.</strong> What you spend and receive, the fees, the fee payer, when it expires,
                  and each transaction in order (a launch with a creator lock has two).
                </li>
                <li>
                  <strong>It simulates in your browser,</strong> against a Solana RPC called directly, and shows the change to
                  your SOL balance.
                </li>
                <li>
                  <strong>Your wallet signs.</strong> Connect Phantom, Solflare, Backpack or any Wallet Standard wallet. The page
                  only signs with the fee payer&apos;s account, then sends, confirms, and links to Solscan and the coin on
                  higher.fun.
                </li>
              </ol>
              <p className="muted">
                Trade and claim links work for up to 10 minutes. Only your wallet signs them, so the page fetches a fresh
                blockhash when it opens and again right before your wallet signs, changes nothing else, and checks and
                simulates again. Past 5 minutes it tells you how old the quote is; your minimum out is still enforced. Past 10
                minutes it asks you to have your agent rebuild it, since prices move. Launch links last about a minute,
                because the new coin&apos;s address is already signed into the transaction. For a launch, rebuild with the
                same <code>idempotency_key</code>: it keeps the same coin, so it can&apos;t be created or paid for twice. Every transaction Highwire builds also carries a memo, <code>highwire</code>, so its use can be
                counted on-chain.
              </p>
            </section>

            <section id="local-signer" aria-labelledby="local-signer-h">
              <h2 id="local-signer-h">Local signer</h2>
              <p className="muted">
                For agents that act on their own, the local server can sign with a keypair on your machine. It&apos;s off
                unless you turn it on, it never runs on the hosted endpoint, and it signs only inside a policy file you
                write. No tool can change that file.
              </p>
              <ol className="plain">
                <li>
                  <strong>Write a policy.</strong> <code>npx highwire-mcp policy init</code> writes a starting one to{" "}
                  <code>~/.highwire/policy.json</code>: devnet, dry run, trades and claims, 0.1 SOL a transaction, 0.5 SOL a
                  day. Without a policy, nothing executes.
                </li>
                <li>
                  <strong>Point it at a keypair.</strong> Set <code>HIGHWIRE_KEYPAIR_PATH</code> to a Solana CLI keypair file
                  in your MCP client&apos;s config for the local server. The key is read from that file only, never from a
                  tool argument, and never leaves your machine. Use a wallet that holds only what you&apos;re willing to let
                  an agent spend.
                </li>
                <li>
                  <strong>Dry runs first.</strong> <code>execute_trade</code>, <code>execute_launch</code>,{" "}
                  <code>execute_claim</code> and <code>execute_transfer</code> build exactly what the build tools build,
                  simulate it, and check your policy, but sign nothing until the policy says <code>&quot;live&quot;: true</code>.
                </li>
                <li>
                  <strong>Every execute is logged</strong> to <code>~/.highwire/audit.jsonl</code>: refusals, dry runs, and
                  each signature, written as it&apos;s sent. The daily limit counts from it.
                </li>
                <li>
                  <strong>Stop it any time</strong> by creating <code>~/.highwire/STOP</code>. Every execute is refused until
                  you delete it.
                </li>
              </ol>
              <div className="table-wrap">
                <table className="params">
                  <thead>
                    <tr>
                      <th>Policy key</th>
                      <th>What it limits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {POLICY_KEYS.map(([k, v]) => (
                      <tr key={k}>
                        <td>
                          <code>{k}</code>
                        </td>
                        <td>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted">
                Transfers go only to wallets on <code>transfer_allowlist</code>, and the sign page never signs them, since a
                sign link can come from anyone.
              </p>
            </section>

            <section id="tools" aria-labelledby="tools-h">
              <h2 id="tools-h">Tools</h2>
              <p className="muted">
                Amounts come back in SOL, whole tokens and percentages. Prices are SOL per whole token. Coin text written by
                users is marked and flagged, so agents treat it as data.
              </p>
              {groups.map((g) => (
                <div key={g.id} className="doc-group">
                  <h3 id={`group-${g.id}`}>{g.title}</h3>
                  {g.items.map((t) => (
                    <ToolDoc key={t.name} tool={t} />
                  ))}
                </div>
              ))}
            </section>

            <section id="prompts" aria-labelledby="prompts-h">
              <h2 id="prompts-h">Prompts</h2>
              <p className="muted">Ready-made workflows your client can offer as slash commands or templates.</p>
              <div className="doc-list">
                {catalog.prompts.map((p) => (
                  <div key={p.name} className="doc-item">
                    <h4>
                      <code>{p.name}</code> <span className="muted">· {p.title}</span>
                    </h4>
                    <p className="muted">{p.description}</p>
                    {p.args.length ? (
                      <p className="small">
                        Arguments:{" "}
                        {p.args.map((a, i) => (
                          <span key={a.name}>
                            {i ? ", " : ""}
                            <code>{a.name}</code>
                            {a.required ? " (required)" : " (optional)"}
                            {a.description ? `: ${a.description}` : ""}
                          </span>
                        ))}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>

            <section id="resources" aria-labelledby="resources-h">
              <h2 id="resources-h">Resources</h2>
              <div className="doc-list">
                {catalog.resources.map((r) => (
                  <div key={r.uri} className="doc-item">
                    <h4>
                      <code>{r.uri}</code>
                    </h4>
                    <p className="muted">{r.description || r.title}</p>
                  </div>
                ))}
              </div>
            </section>

            <section id="recipes" aria-labelledby="recipes-h">
              <h2 id="recipes-h">Recipes</h2>
              <p className="muted">Things to ask your agent, and the tools it will reach for.</p>
              <div className="recipes">
                {RECIPES.map((r) => (
                  <div key={r.title} className="card">
                    <h3>{r.title}</h3>
                    <p className="quote">&ldquo;{r.ask}&rdquo;</p>
                    <ol className="steps small">
                      {r.steps.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ol>
                    <p className="muted small">
                      Or run the <code>{r.prompt}</code> prompt.
                    </p>
                  </div>
                ))}
              </div>
            </section>

            <section id="limits" aria-labelledby="limits-h">
              <h2 id="limits-h">Limits and errors</h2>
              <ul className="plain">
                <li>
                  The hosted server at <code>{MCP_URL}</code> speaks stateless Streamable HTTP: POST JSON-RPC, get JSON back.
                  GET returns 405.
                </li>
                <li>
                  Each IP gets 60 units a minute: a build tool call costs 5, anything else 1. For heavy use, run it locally
                  and point <code>SOLANA_RPC_URL</code> at your own RPC.
                </li>
                <li>
                  A failed call comes back with <code>isError</code> set and a JSON body of <code>error</code>,{" "}
                  <code>code</code> and, when there&apos;s a fix, <code>next_step</code>.
                </li>
              </ul>
              <div className="table-wrap">
                <table className="params">
                  <caption className="sr-only">Error codes</caption>
                  <thead>
                    <tr>
                      <th scope="col">Code</th>
                      <th scope="col">Meaning</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ERRORS.map(([code, meaning]) => (
                      <tr key={code}>
                        <td data-label="Code">
                          <code>{code}</code>
                        </td>
                        <td data-label="Meaning">{meaning}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section id="troubleshooting" aria-labelledby="trouble-h">
              <h2 id="trouble-h">Troubleshooting</h2>
              <dl className="faq">
                <dt>Claude added Highwire but doesn&apos;t use it.</dt>
                <dd>
                  Connectors are off per chat by default. Open <strong>+</strong> → <strong>Connectors</strong> and turn
                  Highwire on.
                </dd>
                <dt>Opening the URL in a browser shows an error.</dt>
                <dd>That&apos;s expected. The endpoint only answers MCP clients, which POST to it.</dd>
                <dt>I get rate_limited.</dt>
                <dd>You used the minute&apos;s 60 units (a build costs 5). Wait a moment, or run the server locally.</dd>
                <dt>The sign page says the link has expired.</dt>
                <dd>
                  Trade and claim links last up to 10 minutes, launch links about a minute. Ask your agent to build the
                  transaction again and open the new link.
                </dd>
                <dt>The sign page doesn&apos;t list my wallet.</dt>
                <dd>
                  Unlock the wallet extension and reload. On a phone, open the link in your wallet app&apos;s own browser.
                </dd>
                <dt>rug_check reports an RPC timeout.</dt>
                <dd>
                  The on-chain check uses a public Solana RPC, which is sometimes busy. The rest of the check still runs.
                  Locally, set <code>SOLANA_RPC_URL</code> to your own RPC.
                </dd>
                <dt>Prices look tiny.</dt>
                <dd>They&apos;re SOL per whole token. New coins often trade at a few millionths of a SOL each.</dd>
                <dt>Something else.</dt>
                <dd>
                  Open an issue on <a href={`${REPO_URL}/issues`}>GitHub</a>.
                </dd>
              </dl>
            </section>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
