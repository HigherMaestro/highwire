import { SiteFooter, SiteHeader } from "../components/Chrome.tsx";
import { Connect } from "../components/Connect.tsx";
import { CopyCommand } from "../components/CopyCommand.tsx";
import { Mark } from "../components/Mark.tsx";
import { getCatalog, groupTools } from "../lib/catalog.ts";
import { graduatingCoins, type CoinSummary } from "../lib/coins.ts";
import { CLAUDE_CODE_COMMAND } from "../lib/connect.ts";
import { coinLabel } from "../lib/names.ts";
import { DONATION_URL, DONATION_WALLET, REPO_URL } from "../lib/site.ts";

// Static, refreshed every minute for the live strip.
export const revalidate = 60;

const fmt = (n: number | null, dp = 1) =>
  n === null ? "–" : n.toLocaleString("en-US", { maximumFractionDigits: dp, minimumFractionDigits: 0 });

function CoinCard({ coin }: { coin: CoinSummary }) {
  const pct = coin.graduationProgressPct ?? 0;
  const label = coinLabel(coin);
  const ticker = label.ticker ?? `${coin.mint.slice(0, 4)}…`;
  return (
    <li className="coin">
      <div className="coin-top">
        <span className="coin-avatar" aria-hidden="true">
          {ticker.slice(0, 1).toUpperCase()}
        </span>
        <div className="coin-names">
          <span className="coin-ticker">{label.ticker ? `$${label.ticker}` : ticker}</span>
          {label.name ? <span className="coin-name">{label.name}</span> : null}
        </div>
        {coin.trustGrade ? (
          <span className="coin-grade" title="higher.fun safety grade">
            {coin.trustGrade}
          </span>
        ) : null}
      </div>
      <progress className="coin-progress" max={100} value={pct} aria-label={`${fmt(pct)}% of the way to graduation`} />
      <div className="coin-stats">
        <span>
          <strong>{fmt(pct)}%</strong> to graduation
        </span>
        <span>{fmt(coin.marketCapSol, 0)} SOL mcap</span>
      </div>
      <a className="coin-link" href={coin.url} target="_blank" rel="noopener noreferrer">
        View on higher.fun
      </a>
    </li>
  );
}

export default async function Home() {
  const [catalog, coins] = await Promise.all([getCatalog(), graduatingCoins(6)]);
  const groups = groupTools(catalog.tools);
  const hostedCount = catalog.tools.filter((t) => t.hosted).length;
  const localOnly = catalog.tools.length - hostedCount;
  const buildCount = catalog.tools.filter((t) => t.builds && t.hosted).length;
  const stats = [
    { n: hostedCount, label: "hosted tools" },
    { n: buildCount, label: "build tools you sign" },
    { n: catalog.prompts.length, label: "prompts" },
    { n: catalog.resources.length, label: "resources" },
    { n: 0, label: "keys needed" },
  ];

  return (
    <>
      <SiteHeader />

      <main>
        <section className="hero">
          <div className="wrap hero-grid">
            <div className="hero-copy">
              <p className="eyebrow">MCP server · open source · no keys</p>
              <h1>The agent wire for higher.fun</h1>
              <p className="lead">
                Highwire connects AI agents to <a href="https://higher.fun">higher.fun</a>, the open-source Solana launchpad.
                Scan launches, research coins and creators, run rug checks, and prepare trades and launches that you sign in
                your own wallet on highwire.fun, from Claude, Cursor or any MCP client.
              </p>
              <CopyCommand label="Add Highwire to Claude Code" code={CLAUDE_CODE_COMMAND} />
              <div className="hero-actions">
                <a className="button" href="#connect">
                  Add to your client
                </a>
                <a className="button button-quiet" href="/docs">
                  Read the docs
                </a>
              </div>
              <ul className="stats" aria-label="What the server offers">
                {stats.map((s) => (
                  <li key={s.label}>
                    <span className="stat-n">{s.n}</span>
                    <span className="stat-label">{s.label}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="hero-art">
              <Mark id="hero" size={360} animated label="The Highwire H: two posts with a wire between them" />
            </div>
          </div>
        </section>

        {coins.length ? (
          <section className="band" aria-labelledby="live-title">
            <div className="wrap">
              <div className="section-head">
                <h2 id="live-title">Close to graduating on higher.fun</h2>
                <p className="muted">
                  Live from higher.fun&apos;s API, refreshed every minute. This is what <code>list_coins</code> returns with{" "}
                  <code>sort: &quot;graduating&quot;</code>. Not financial advice.
                </p>
              </div>
              <ul className="coins">
                {coins.map((c) => (
                  <CoinCard key={c.mint} coin={c} />
                ))}
              </ul>
            </div>
          </section>
        ) : null}

        <section id="connect" className="section" aria-labelledby="connect-title">
          <div className="wrap">
            <div className="section-head">
              <h2 id="connect-title">One URL, any client</h2>
              <p className="muted">Pick your client. Most take one click.</p>
            </div>
            <Connect />
          </div>
        </section>

        <section id="tools" className="section section-alt" aria-labelledby="tools-title">
          <div className="wrap">
            <div className="section-head">
              <h2 id="tools-title">{catalog.tools.length} tools</h2>
              <p className="muted">
                {hostedCount === catalog.tools.length ? "All of them run" : `${hostedCount} run`} on the hosted server.{" "}
                {buildCount} build transactions: they hand back a sign link, and you review and sign in your own wallet on{" "}
                <a href="/docs#signing">the sign page</a>. The rest only read.{" "}
                {localOnly ? `${localOnly} more run only on your own computer. ` : ""}Listed straight from the server;
                parameters and examples are in the <a href="/docs">docs</a>.
              </p>
            </div>
            <div className="groups">
              {groups.map((g) => (
                <div key={g.id} className="group">
                  <h3>{g.title}</h3>
                  {g.blurb ? <p className="muted small">{g.blurb}</p> : null}
                  <ul className="tools">
                    {g.items.map((t) => (
                      <li key={t.name} className="tool">
                        <span className="tool-line">
                          <a className="tool-name" href={`/docs#${t.name}`}>
                            <code>{t.name}</code>
                          </a>
                          {t.hosted ? null : <span className="badge">local</span>}
                          {t.builds ? <span className="badge badge-warn">you sign</span> : null}
                          {t.executes ? <span className="badge badge-warn">your policy</span> : null}
                        </span>
                        <span className="tool-desc">{t.summary}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section" aria-labelledby="safety-title">
          <div className="wrap">
            <div className="section-head">
              <h2 id="safety-title">Built to keep agents on the wire</h2>
            </div>
            <ul className="points">
              <li>
                <h3>Rug check first</h3>
                <p className="muted">
                  <code>rug_check</code> rolls mint and freeze authority, holder concentration, snipers, bundles and dev
                  selling into one verdict: clean, caution or high risk.
                </p>
              </li>
              <li>
                <h3>Strangers&apos; words stay data</h3>
                <p className="muted">
                  Coin names, comments and chat are user-written. Highwire flags links and look-alike names, and tells agents
                  never to follow instructions inside them.
                </p>
              </li>
              <li>
                <h3>No keys, ever</h3>
                <p className="muted">
                  The build tools only make unsigned transactions, decoded and simulated first. The sign page checks them
                  again in your browser and your own wallet signs. Highwire never asks for a private key or seed phrase.
                </p>
              </li>
              <li>
                <h3>Units you can read</h3>
                <p className="muted">SOL, whole tokens and percentages, not lamports and basis points.</p>
              </li>
            </ul>
          </div>
        </section>

        <section className="section section-alt" aria-labelledby="road-title">
          <div className="wrap">
            <div className="section-head">
              <h2 id="road-title">Where the wire goes next</h2>
            </div>
            <ol className="road">
              <li className="road-now">
                <span className="road-tag">Now</span>
                <h3>Sign from any chat, or set the limits</h3>
                <p className="muted">
                  {hostedCount} hosted tools: ask Claude or ChatGPT to buy, sell, launch or claim, then sign the link in your
                  own wallet. Or install it from npm or the MCP Registry and let an agent act on its own, inside caps and
                  allowlists you write. Live alerts watch launches, trades and graduations as they happen, stop-loss, take-profit
                  and recurring buys run inside your policy, profit and loss comes from your own trades on-chain, and every fee on
                  higher.fun is tracked at <a href="/fees">/fees</a>.
                </p>
              </li>
              <li>
                <span className="road-tag">Next</span>
                <h3>Posting</h3>
                <p className="muted">Sign-in so an agent can post comments and chat.</p>
              </li>
            </ol>
            <p className="muted small road-foot">
              Follow along on <a href={REPO_URL}>GitHub</a>.
            </p>
          </div>
        </section>

        <section className="section" id="support" aria-labelledby="support-title">
          <div className="wrap">
            <div className="section-head">
              <h2 id="support-title">Support Highwire</h2>
              <p>
                Highwire is free and open source. If it&apos;s useful to you and you&apos;d like to chip in, donations go to
                this Solana wallet, and only this one. Entirely optional.
              </p>
            </div>
            <div className="support">
              <CopyCommand code={DONATION_WALLET} label="Highwire's donation wallet" />
              <p className="muted small">
                <a href={DONATION_URL}>See it on Solscan</a>. Check the address matches before you send: we never ask for
                funds in DMs, and no other wallet collects for Highwire.
              </p>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
