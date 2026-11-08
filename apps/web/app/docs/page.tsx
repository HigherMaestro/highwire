import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteFooter, SiteHeader } from "../../components/Chrome.tsx";
import { Connect } from "../../components/Connect.tsx";
import { AmbientWire } from "../../components/hero/AmbientWire.tsx";
import { SectionNav } from "../../components/ideas/SectionNav.tsx";
import { getCatalog, groupTools, type ToolInfo } from "../../lib/catalog.ts";
import { MCP_URL, REPO_URL, pageMetadata } from "../../lib/site.ts";

export const metadata: Metadata = {
  ...pageMetadata({
    title: "Docs",
    description: "Connect Highwire to your MCP client, and every tool, prompt and resource it offers, with parameters.",
    path: "/docs",
  }),
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
  ["max_sol_per_tx", "The most SOL one execute may spend: a buy, a launch fee plus first buy, or SOL sent, plus up to 0.03 SOL of rent and fees."],
  ["max_sol_per_day", "The most SOL in any 24 hours, counted from the audit log: what the wallet actually spent, rent and fees included."],
  ["max_slippage_bps", "The most slippage a trade or first buy may allow."],
  ["coins", "allow: only these coins; deny: never these. For trades and coin transfers."],
  ["creators", "allow: only trade coins launched by these wallets."],
  ["transfer_allowlist", "The only wallets transfers may go to. Empty by default."],
  ["orders", "kinds: which standing orders an agent may place (stop_loss, take_profit, limit_buy, recurring_buy, fee_claim); max_open: how many at once (default 10). Without it, none."],
  ["posts", "comments: own (only coins the wallet launched, the default), any or none; chat: true to allow higher.fun's site chat; max_per_day (default 10). Without it, none."],
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

const SECTIONS = [
  { id: "connect", label: "Connect" },
  { id: "signing", label: "Signing" },
  { id: "local-signer", label: "Local signer" },
  { id: "tools", label: "Tools" },
  { id: "prompts", label: "Prompts" },
  { id: "resources", label: "Resources" },
  { id: "recipes", label: "Recipes" },
  { id: "limits", label: "Limits and errors" },
  { id: "troubleshooting", label: "Troubleshooting" },
];

const n = (id: string) => String(SECTIONS.findIndex((s) => s.id === id) + 1).padStart(2, "0");

function Head({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  return (
    <div className="section-head">
      <h2 id={`${id}-h`} className="sec-h">
        <span className="sec-n">{n(id)}</span>
        {title}
      </h2>
      {children ? <p className="muted">{children}</p> : null}
    </div>
  );
}

/** Numbered steps as cards: a short title, then what happens. */
function Steps({ steps }: { steps: [string, ReactNode][] }) {
  return (
    <ol className="doc-steps">
      {steps.map(([title, body], i) => (
        <li key={title}>
          <span className="doc-step-n">{String(i + 1).padStart(2, "0")}</span>
          <strong>{title}</strong>
          <span className="muted">{body}</span>
        </li>
      ))}
    </ol>
  );
}

const SIGNING: [string, ReactNode][] = [
  [
    "The link carries the transaction",
    <>
      It rides in the part after <code>#</code>, which browsers never send to a server, so Highwire never sees it. The page
      sends nothing to Highwire.
    </>,
  ],
  [
    "The page checks it again",
    <>
      It decodes every instruction from the transaction itself, not from the link&apos;s description, and refuses anything
      Highwire doesn&apos;t build: a program off the allow-list, SOL sent to someone else, another platform, another fee
      payer.
    </>,
  ],
  [
    "You see what it does",
    <>
      What you spend and receive, the fees, the fee payer, when it expires, and each transaction in order (a launch with a
      creator lock has two).
    </>,
  ],
  ["It simulates in your browser", <>Against a Solana RPC called directly, and shows the change to your SOL balance.</>],
  [
    "Your wallet signs",
    <>
      Connect Phantom, Solflare, Backpack or any Wallet Standard wallet. The page only signs with the fee payer&apos;s
      account, then sends, confirms, and links to Solscan and the coin on higher.fun.
    </>,
  ],
];

const SIGNER: [string, ReactNode][] = [
  [
    "Write a policy",
    <>
      <code>npx highwire-mcp policy init</code> writes a starting one to <code>~/.highwire/policy.json</code>: devnet, dry
      run, trades and claims, 0.1 SOL a transaction, 0.5 SOL a day. Without a policy, nothing executes.
    </>,
  ],
  [
    "Point it at a keypair",
    <>
      Set <code>HIGHWIRE_KEYPAIR_PATH</code> to a Solana CLI keypair file in your MCP client&apos;s config for the local
      server. The key is read from that file only, never from a tool argument, and never leaves your machine. Use a wallet
      that holds only what you&apos;re willing to let an agent spend.
    </>,
  ],
  [
    "Dry runs first",
    <>
      <code>execute_trade</code>, <code>execute_launch</code>, <code>execute_claim</code> and <code>execute_transfer</code>{" "}
      build exactly what the build tools build, simulate it, and check your policy, but sign nothing until the policy says{" "}
      <code>&quot;live&quot;: true</code>.
    </>,
  ],
  [
    "Every execute is logged",
    <>
      To <code>~/.highwire/audit.jsonl</code>: refusals, dry runs, and each signature, written as it&apos;s sent. The daily
      limit counts from it.
    </>,
  ],
  [
    "Stop it any time",
    <>
      Create <code>~/.highwire/STOP</code>. Every execute is refused until you delete it.
    </>,
  ],
];

export default async function Docs() {
  const catalog = await getCatalog();
  const groups = groupTools(catalog.tools);
  const hosted = catalog.tools.filter((t) => t.hosted).length;
  const builds = catalog.tools.filter((t) => t.builds && t.hosted).length;
  const localOnly = catalog.tools.length - hosted;

  return (
    <>
      <SiteHeader />
      <main>
        <section className="page-hero docs-hero" aria-labelledby="docs-title">
          <AmbientWire />
          <div className="wrap page-hero-copy">
            <p className="eyebrow">Docs · generated from the running server</p>
            <h1 id="docs-title">Highwire docs</h1>
            <p className="lead">
              Highwire is an MCP server for <a href="https://higher.fun">higher.fun</a>. Connect it, and your agent can read the
              market, check coins, and build trades and launches you sign in your own wallet.
            </p>
            <dl className="fee-hero-facts">
              <div>
                <dt>Hosted tools</dt>
                <dd>{hosted}</dd>
              </div>
              <div>
                <dt>With the local server</dt>
                <dd>{catalog.tools.length}</dd>
              </div>
              <div>
                <dt>Build a transaction</dt>
                <dd>{builds}</dd>
              </div>
              <div>
                <dt>Prompts · resources</dt>
                <dd>
                  {catalog.prompts.length} · {catalog.resources.length}
                </dd>
              </div>
            </dl>
            <div className="fee-hero-ctas">
              <a className="button" href="#connect">
                Connect your agent
              </a>
              <a className="button button-quiet" href="/skill.md">
                skill.md for agents
              </a>
            </div>
          </div>
        </section>
        <SectionNav sections={SECTIONS} />

        <div className="wrap docs-body">
          <section id="connect" className="doc-block" aria-labelledby="connect-h">
            <Head id="connect" title="Connect" />
            <Connect />
          </section>

          <section id="signing" className="doc-block" aria-labelledby="signing-h">
            <Head id="signing" title="Signing">
              Highwire never signs and never holds a key. A build tool returns an unsigned transaction and a{" "}
              <code>sign_url</code>, a link to <a href="/sign">highwire.fun/sign</a>. Your agent gives you the link; you open it
              and sign in your own wallet.
            </Head>
            <Steps steps={SIGNING} />
            <div className="doc-note">
              <p>
                <strong>How long links last.</strong> Trade and claim links work for up to 10 minutes. Only your wallet signs
                them, so the page fetches a fresh blockhash when it opens and again right before your wallet signs, changes
                nothing else, and checks and simulates again. Past 5 minutes it tells you how old the quote is; your minimum out
                is still enforced. Past 10 minutes it asks you to have your agent rebuild it, since prices move.
              </p>
              <p>
                Launch links last about a minute, because the new coin&apos;s address is already signed into the transaction.
                For a launch, rebuild with the same <code>idempotency_key</code>: it keeps the same coin, so it can&apos;t be
                created or paid for twice. Every transaction Highwire builds also carries a memo, <code>highwire</code>, so its
                use can be counted on-chain.
              </p>
            </div>
          </section>

          <section id="local-signer" className="doc-block" aria-labelledby="local-signer-h">
            <Head id="local-signer" title="Local signer">
              For agents that act on their own, the local server can sign with a keypair on your machine. It&apos;s off unless
              you turn it on, it never runs on the hosted endpoint, and it signs only inside a policy file you write. No tool
              can change that file.
            </Head>
            <Steps steps={SIGNER} />
            <div className="table-wrap fee-panel fee-table-panel">
              <table className="params">
                <caption className="sr-only">Policy keys</caption>
                <thead>
                  <tr>
                    <th scope="col">Policy key</th>
                    <th scope="col">What it limits</th>
                  </tr>
                </thead>
                <tbody>
                  {POLICY_KEYS.map(([k, v]) => (
                    <tr key={k}>
                      <td data-label="Policy key">
                        <code>{k}</code>
                      </td>
                      <td data-label="What it limits">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">
              Transfers go only to wallets on <code>transfer_allowlist</code>, and the sign page never signs them, since a sign
              link can come from anyone.
            </p>
            <div className="doc-cards">
              <div className="card">
                <h3>Launch on your own</h3>
                <p className="muted">
                  An agent with a shell can launch from its own wallet with no one in the loop:{" "}
                  <code>npx highwire-mcp wallet new</code> makes the wallet, <code>policy init --launch</code> writes a launch
                  policy, <code>launch --name … --ticker … --image …</code> signs in, uploads and launches through{" "}
                  <code>execute_launch</code>, and <code>claim</code> collects the creator fees. Point an agent at{" "}
                  <a href="/skill.md">highwire.fun/skill.md</a> and it can do the rest.
                </p>
              </div>
              <div className="card">
                <h3>Standing orders</h3>
                <p className="muted">
                  With an <code>orders</code> section in the policy, an agent can place a stop-loss, a take-profit, a limit buy, a
                  recurring buy or a fee claim with <code>place_order</code>. <code>highwire orders run</code> fills them while
                  it runs: price orders against the coin&apos;s on-chain price (the live feed only says when to look), recurring
                  buys and fee claims on their schedule. A fee claim collects the wallet&apos;s creator fees once enough is
                  waiting, and can spend a share of each claim buying the coin back;{" "}
                  <code>highwire orders claim --every-hours 24</code> places one from the shell. Every fill passes the whole
                  policy again, is simulated and is logged with its order&apos;s id. <code>highwire orders list</code> and{" "}
                  <code>highwire orders cancel</code> show and cancel them.
                </p>
              </div>
              <div className="card">
                <h3>Posting</h3>
                <p className="muted">
                  With a <code>posts</code> section, <code>post_comment</code> and <code>post_chat</code> post on higher.fun as
                  the wallet: a comment on its own coin (or any coin, if you allow it) or a message in the site chat. Plain text
                  only: links and wallet or mint addresses are refused. Each post is logged before it goes up and counts against
                  the daily cap.
                </p>
              </div>
            </div>
          </section>

          <section id="tools" className="doc-block" aria-labelledby="tools-h">
            <Head id="tools" title="Tools">
              {catalog.tools.length} tools. The hosted endpoint serves {hosted} of them; the other {localOnly}, which sign with
              your own key, run only on the local server. Amounts come back in SOL, whole tokens and percentages, and prices are
              SOL per whole token. Coin text written by users is marked and flagged, so agents treat it as data.
            </Head>
            <nav className="doc-chips" aria-label="Tool groups">
              {groups.map((g) => (
                <a key={g.id} href={`#group-${g.id}`}>
                  {g.title} <span className="muted">{g.items.length}</span>
                </a>
              ))}
            </nav>
            {groups.map((g) => (
              <div key={g.id} className="doc-group">
                <h3 id={`group-${g.id}`}>{g.title}</h3>
                {g.items.map((t) => (
                  <ToolDoc key={t.name} tool={t} />
                ))}
              </div>
            ))}
          </section>

          <section id="prompts" className="doc-block" aria-labelledby="prompts-h">
            <Head id="prompts" title="Prompts">
              Ready-made workflows your client can offer as slash commands or templates.
            </Head>
            <div className="doc-cards">
              {catalog.prompts.map((p) => (
                <div key={p.name} className="card doc-item">
                  <h4>
                    <code>{p.name}</code>
                  </h4>
                  <p className="small">{p.title}</p>
                  <p className="muted">{p.description}</p>
                  {p.args.length ? (
                    <p className="small muted">
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

          <section id="resources" className="doc-block" aria-labelledby="resources-h">
            <Head id="resources" title="Resources">
              Reference your client can load into the agent&apos;s context.
            </Head>
            <div className="doc-cards">
              {catalog.resources.map((r) => (
                <div key={r.uri} className="card doc-item">
                  <h4>
                    <code>{r.uri}</code>
                  </h4>
                  <p className="muted">{r.description || r.title}</p>
                </div>
              ))}
            </div>
          </section>

          <section id="recipes" className="doc-block" aria-labelledby="recipes-h">
            <Head id="recipes" title="Recipes">
              Things to ask your agent, and the tools it will reach for.
            </Head>
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

          <section id="limits" className="doc-block" aria-labelledby="limits-h">
            <Head id="limits" title="Limits and errors" />
            <div className="doc-cards">
              <div className="card">
                <h3>Stateless</h3>
                <p className="muted">
                  The hosted server at <code>{MCP_URL}</code> speaks stateless Streamable HTTP: POST JSON-RPC, get JSON back. GET
                  returns 405.
                </p>
              </div>
              <div className="card">
                <h3>60 units a minute</h3>
                <p className="muted">
                  Per IP: a build tool call costs 5, anything else 1. For heavy use, run it locally and point{" "}
                  <code>SOLANA_RPC_URL</code> at your own RPC.
                </p>
              </div>
              <div className="card">
                <h3>Errors say what to do</h3>
                <p className="muted">
                  A failed call comes back with <code>isError</code> set and a JSON body of <code>error</code>,{" "}
                  <code>code</code> and, when there&apos;s a fix, <code>next_step</code>.
                </p>
              </div>
            </div>
            <div className="table-wrap fee-panel fee-table-panel">
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

          <section id="troubleshooting" className="doc-block" aria-labelledby="troubleshooting-h">
            <Head id="troubleshooting" title="Troubleshooting" />
            <dl className="doc-faq">
              <div>
                <dt>Claude added Highwire but doesn&apos;t use it.</dt>
                <dd>
                  Connectors are off per chat by default. Open <strong>+</strong> → <strong>Connectors</strong> and turn Highwire
                  on.
                </dd>
              </div>
              <div>
                <dt>Opening the URL in a browser shows an error.</dt>
                <dd>That&apos;s expected. The endpoint only answers MCP clients, which POST to it.</dd>
              </div>
              <div>
                <dt>I get rate_limited.</dt>
                <dd>You used the minute&apos;s 60 units (a build costs 5). Wait a moment, or run the server locally.</dd>
              </div>
              <div>
                <dt>The sign page says the link has expired.</dt>
                <dd>
                  Trade and claim links last up to 10 minutes, launch links about a minute. Ask your agent to build the
                  transaction again and open the new link.
                </dd>
              </div>
              <div>
                <dt>The sign page doesn&apos;t list my wallet.</dt>
                <dd>Unlock the wallet extension and reload. On a phone, open the link in your wallet app&apos;s own browser.</dd>
              </div>
              <div>
                <dt>rug_check reports an RPC timeout.</dt>
                <dd>
                  The on-chain check uses a public Solana RPC, which is sometimes busy. The rest of the check still runs. Locally,
                  set <code>SOLANA_RPC_URL</code> to your own RPC.
                </dd>
              </div>
              <div>
                <dt>Prices look tiny.</dt>
                <dd>They&apos;re SOL per whole token. New coins often trade at a few millionths of a SOL each.</dd>
              </div>
              <div>
                <dt>Something else.</dt>
                <dd>
                  Open an issue on <a href={`${REPO_URL}/issues`}>GitHub</a>.
                </dd>
              </div>
            </dl>
          </section>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
