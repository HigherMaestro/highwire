import { CopyCommand } from "../components/CopyCommand.tsx";
import { Lockup, Mark } from "../components/Mark.tsx";
import { graduatingCoins, type CoinSummary } from "../lib/coins.ts";
import { MCP_URL, REPO_URL, X_HANDLE, X_URL } from "../lib/site.ts";
import { listTools, type ToolInfo } from "../lib/tools.ts";

// Static, refreshed every minute for the live strip.
export const revalidate = 60;

const GROUPS: { title: string; blurb: string; tools: string[] }[] = [
  {
    title: "Discover",
    blurb: "What's launching, trending and about to graduate.",
    tools: ["list_coins", "search_coins", "get_top_coins", "get_featured_coin", "get_trade_tape", "get_leaderboard"],
  },
  {
    title: "Research a coin",
    blurb: "Price, holders, trades, candles and the comment thread.",
    tools: ["get_coin", "get_coin_trades", "get_coin_holders", "get_coin_candles", "get_coin_comments"],
  },
  {
    title: "Creators and wallets",
    blurb: "Who launched what, and how it went.",
    tools: ["get_wallet_profile", "get_creator_coins"],
  },
  {
    title: "Safety and platform",
    blurb: "Rug checks, fee modes, tickers and site chat.",
    tools: ["rug_check", "get_platform_info", "check_ticker", "get_chat"],
  },
];

function groupTools(tools: ToolInfo[]) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const used = new Set<string>();
  const groups = GROUPS.map((g) => ({
    ...g,
    items: g.tools.flatMap((n) => {
      const t = byName.get(n);
      if (!t) return [];
      used.add(n);
      return [t];
    }),
  }));
  const rest = tools.filter((t) => !used.has(t.name));
  if (rest.length) groups.push({ title: "More", blurb: "", tools: [], items: rest });
  return groups.filter((g) => g.items.length);
}

const fmt = (n: number | null, dp = 1) =>
  n === null ? "–" : n.toLocaleString("en-US", { maximumFractionDigits: dp, minimumFractionDigits: 0 });

function CoinCard({ coin }: { coin: CoinSummary }) {
  const pct = coin.graduationProgressPct ?? 0;
  return (
    <li className="coin">
      <div className="coin-top">
        <span className="coin-avatar" aria-hidden="true">
          {coin.ticker.slice(0, 1).toUpperCase()}
        </span>
        <div className="coin-names">
          <span className="coin-ticker">${coin.ticker}</span>
          <span className="coin-name">{coin.name}</span>
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
  const [tools, coins] = await Promise.all([listTools(), graduatingCoins(6)]);
  const groups = groupTools(tools);
  const remote = JSON.stringify({ mcpServers: { highwire: { url: MCP_URL } } }, null, 2);

  return (
    <>
      <header className="site-header">
        <div className="wrap header-row">
          <a href="/" className="home-link" aria-label="Highwire home">
            <Lockup id="hdr" />
          </a>
          <nav aria-label="Main">
            <ul className="nav">
              <li>
                <a href="#connect">Connect</a>
              </li>
              <li>
                <a href="#tools">Tools</a>
              </li>
              <li>
                <a href={REPO_URL}>GitHub</a>
              </li>
              <li>
                <a href={X_URL} aria-label={`Highwire on X (${X_HANDLE})`}>
                  X
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="wrap hero-grid">
            <div className="hero-copy">
              <p className="eyebrow">MCP server · read-only · no keys</p>
              <h1>The agent wire for higher.fun</h1>
              <p className="lead">
                Highwire connects AI agents to <a href="https://higher.fun">higher.fun</a>, the open-source Solana launchpad.
                Scan launches, research coins and creators, and run rug checks from Claude, Cursor or any MCP client.
              </p>
              <CopyCommand label="Add Highwire to Claude Code" code={`claude mcp add --transport http highwire ${MCP_URL}`} />
              <div className="hero-actions">
                <a className="button" href="#connect">
                  Other clients
                </a>
                <a className="button button-quiet" href={REPO_URL}>
                  Source on GitHub
                </a>
              </div>
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
              <h2 id="connect-title">Connect in one line</h2>
              <p className="muted">
                The hosted server lives at <code>{MCP_URL}</code>. It&apos;s stateless and read-only, and allows 60 requests a
                minute per IP.
              </p>
            </div>
            <div className="cards">
              <div className="card">
                <h3>Claude Code</h3>
                <CopyCommand label="Claude Code command" code={`claude mcp add --transport http highwire ${MCP_URL}`} multiline />
              </div>
              <div className="card">
                <h3>Cursor, or any remote MCP client</h3>
                <CopyCommand label="MCP client config" code={remote} multiline />
              </div>
              <div className="card">
                <h3>Run it locally</h3>
                <p className="muted small">The npm package is on its way. Until then, build from source:</p>
                <CopyCommand
                  label="Build and add the local server"
                  code={`git clone ${REPO_URL}.git\ncd highwire && npm install && npm run build\nclaude mcp add highwire -- node "$PWD/packages/mcp/dist/cli.js"`}
                  multiline
                />
              </div>
            </div>
          </div>
        </section>

        <section id="tools" className="section section-alt" aria-labelledby="tools-title">
          <div className="wrap">
            <div className="section-head">
              <h2 id="tools-title">{tools.length} tools, all read-only</h2>
              <p className="muted">Listed straight from the server, so this page always matches what your agent sees.</p>
            </div>
            <div className="groups">
              {groups.map((g) => (
                <div key={g.title} className="group">
                  <h3>{g.title}</h3>
                  {g.blurb ? <p className="muted small">{g.blurb}</p> : null}
                  <ul className="tools">
                    {g.items.map((t) => (
                      <li key={t.name} className="tool">
                        <code className="tool-name">{t.name}</code>
                        <span className="tool-desc">{t.description}</span>
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
                  Today&apos;s server can&apos;t sign or trade, and never asks for a private key or seed phrase.
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
                <h3>Read everything</h3>
                <p className="muted">17 tools for discovery, research and safety, hosted or local.</p>
              </li>
              <li>
                <span className="road-tag">Next</span>
                <h3>Trade and launch, you sign</h3>
                <p className="muted">
                  Quotes and unsigned transactions for buys, sells, launches and creator-fee claims. Your wallet signs; the
                  agent never holds keys.
                </p>
              </li>
              <li>
                <span className="road-tag">Later</span>
                <h3>Agents with limits</h3>
                <p className="muted">An opt-in local signer with daily caps and allowlists, plus live alerts.</p>
              </li>
            </ol>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="wrap footer-row">
          <Lockup id="ftr" />
          <p className="muted small">
            MIT licensed. <a href={REPO_URL}>Source on GitHub</a>. Follow <a href={X_URL}>{X_HANDLE}</a> on X. Not affiliated with higher.fun. Nothing here is financial advice.
          </p>
        </div>
      </footer>
    </>
  );
}
