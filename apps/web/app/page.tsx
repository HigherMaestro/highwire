import { SiteFooter, SiteHeader } from "../components/Chrome.tsx";
import { Connect } from "../components/Connect.tsx";
import { CopyCommand } from "../components/CopyCommand.tsx";
import { LiveWire } from "../components/hero/LiveWire.tsx";
import { WireDive, type DiveStage } from "../components/hero/WireDive.tsx";
import { COLOR, Head, Tile } from "../components/fees/Parts.tsx";
import { getCatalog, groupTools } from "../lib/catalog.ts";
import { graduatingCoins, type CoinSummary } from "../lib/coins.ts";
import { CLAUDE_CODE_COMMAND } from "../lib/connect.ts";
import { feeSummary, pctOf, sol, updatedAt, usd } from "../lib/fees.ts";
import { listIdeas, listModules } from "../lib/ideas.ts";
import { inline, slug } from "../lib/markdown.tsx";
import { coinLabel } from "../lib/names.ts";
import { latestReleases, latestVersion, readChangelog } from "../lib/releases.ts";
import { DONATION_URL, DONATION_WALLET, REPO_URL } from "../lib/site.ts";
import { readTape } from "../lib/tape.ts";

// Static, refreshed every minute for the live strip.
export const revalidate = 60;

const DIVE: DiveStage[] = [
  {
    title: "The launchpad",
    body: "higher.fun: hundreds of coins, each on its own bonding curve, every trade on Solana. Highwire reads all of it, from higher.fun's API and the chain itself.",
  },
  {
    title: "One coin",
    body: "Ask about any coin and your agent sees what an analyst would: its holders and creator, its safety grade, its fees, a rug check, and the market moving live.",
  },
  {
    title: "One trade",
    body: "Every trade, launch and claim Highwire builds is decoded and simulated before you sign. The sign page rebuilds it from its own bytes, so you see exactly what it does.",
  },
  {
    title: "The wire",
    body: "Or let your agent walk it alone, inside limits only you can write: SOL caps, coin allowlists, slippage, a daily budget and a kill switch. Every step is logged.",
  },
];

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
  const [catalog, coins, tape, fees] = await Promise.all([
    getCatalog(),
    graduatingCoins(6),
    readTape(),
    // A cold cache that fails to read leaves the fee figures out rather than the whole page.
    feeSummary().catch(() => null),
  ]);
  const groups = groupTools(catalog.tools);
  const hostedCount = catalog.tools.filter((t) => t.hosted).length;
  const localOnly = catalog.tools.length - hostedCount;
  const buildCount = catalog.tools.filter((t) => t.builds && t.hosted).length;
  const changelog = readChangelog();
  const releases = latestReleases(changelog);
  const version = latestVersion(changelog);
  const ideas = listIdeas();
  const modules = listModules();

  return (
    <>
      <SiteHeader />

      <main>
        <section className="hero hero-live">
          <LiveWire initial={tape ?? []} />
          <div className="wrap hero-grid">
            <div className="hero-copy">
              <p className="eyebrow">MCP server · open source · on Solana</p>
              <h1>The agent wire for higher.fun</h1>
              <p className="lead">
                Highwire connects AI agents to <a href="https://higher.fun">higher.fun</a>, the open-source Solana launchpad.
                Research coins and creators, rug-check launches and follow every fee. Then trade, launch and claim: sign each
                step in your own wallet from any chat, or let an agent run on its own inside limits only you can write.
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
              <dl className="fee-hero-facts" aria-label="Highwire in numbers">
                <div>
                  <dt>Hosted tools</dt>
                  <dd>{hostedCount}</dd>
                </div>
                <div>
                  <dt>With the local server</dt>
                  <dd>{catalog.tools.length}</dd>
                </div>
                {fees ? (
                  <div>
                    <dt>Fees tracked</dt>
                    <dd>{sol(fees.feesSol)} SOL</dd>
                  </div>
                ) : null}
                {version ? (
                  <div>
                    <dt>Latest release</dt>
                    <dd>
                      <a className="hero-fact-link" href="/changelog">
                        {version}
                      </a>
                    </dd>
                  </div>
                ) : null}
              </dl>
            </div>
          </div>
        </section>

        <section id="ways" className="section" aria-labelledby="ways-title">
          <div className="wrap">
            <Head id="ways" n="01" title="Two ways to use it">
              Start in any chat with nothing to install. When you want an agent that acts on its own, run Highwire on your
              own computer and write its limits.
            </Head>
            <div className="ways">
              <article className="way">
                <p className="way-tag">Hosted · any MCP client</p>
                <h3>Sign each step</h3>
                <p className="muted">
                  Ask Claude, ChatGPT or Cursor to buy, sell, launch or claim. Highwire builds the transaction, decodes and
                  simulates it, and hands back a link. The sign page rebuilds what it does from the bytes alone, and your own
                  wallet signs.
                </p>
                <ul className="way-points">
                  <li>One URL: no sign-in, no keys, nothing to install</li>
                  <li>Coins, holders, creators, rug checks, fees and profit and loss</li>
                  <li>Trades, launches and fee claims you sign in your wallet</li>
                </ul>
                <div className="way-links">
                  <a className="button" href="#connect">
                    Add to your client
                  </a>
                  <a className="button button-quiet" href="/docs#signing">
                    How signing works
                  </a>
                </div>
              </article>
              <article className="way way-local">
                <p className="way-tag">Local · from npm</p>
                <h3>Let it run</h3>
                <p className="muted">
                  On your own computer, an agent can act alone, inside a policy only you can write: SOL caps per trade and per
                  day, coin and creator allowlists, slippage and a kill switch. Everything is a dry run until you set it live.
                </p>
                <ul className="way-points">
                  <li>Stop-loss, take-profit, limit and recurring buys, fee claims with buybacks</li>
                  <li>
                    Launch a coin from a shell by following <a href="/skill.md">one page</a>
                  </li>
                  <li>Live alerts, posts on its own coins, sends that can&apos;t be sandwiched</li>
                  <li>Every refusal, dry run and send in an audit log</li>
                </ul>
                <div className="way-links">
                  <a className="button" href="/docs#local-signer">
                    Set up the local signer
                  </a>
                  <a className="button button-quiet" href="/skill.md">
                    skill.md for agents
                  </a>
                </div>
              </article>
            </div>
          </div>
        </section>

        {fees || coins.length ? (
          <section id="live" className="section section-alt" aria-labelledby="live-title">
            <div className="wrap">
              <Head id="live" n="02" title="Live on higher.fun">
                What your agent can see right now. Fees are read from Solana every 10 minutes; coins from higher.fun&apos;s
                API every minute. Not financial advice.
              </Head>
              {fees ? (
                <>
                  <div className="fee-tiles fee-tiles-4">
                    <Tile label="Paid in fees" value={sol(fees.feesSol)} unit="SOL" sub={usd(fees.feesSol, fees.solUsd) ?? "across every coin"} />
                    <Tile label="Last 24 hours" value={sol(fees.last24hSol)} unit="SOL" sub={usd(fees.last24hSol, fees.solUsd) ?? "in fees"} />
                    <Tile
                      label="To creators"
                      value={sol(fees.creatorsSol)}
                      unit="SOL"
                      sub={`${pctOf(fees.creatorsSol, fees.feesSol)} of all fees`}
                      accent={COLOR.creator}
                    />
                    <Tile label="Graduated" value={fees.graduated.toLocaleString("en-US")} sub={`of ${fees.coins.toLocaleString("en-US")} coins`} />
                  </div>
                  <p className="fee-fresh live-fresh">
                    <span className="fee-fresh-dot" aria-hidden="true" />
                    Read {updatedAt(fees.readAt)} ·{" "}
                    <a href="/fees">every fee, and who got it →</a>
                  </p>
                </>
              ) : null}
              {coins.length ? (
                <>
                  <h3 className="live-sub">Close to graduating</h3>
                  <p className="muted small">
                    What <code>list_coins</code> returns with <code>sort: &quot;graduating&quot;</code>.
                  </p>
                  <ul className="coins">
                    {coins.map((c) => (
                      <CoinCard key={c.mint} coin={c} />
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          </section>
        ) : null}

        <WireDive stages={DIVE} />

        <section id="connect" className="section" aria-labelledby="connect-title">
          <div className="wrap">
            <Head id="connect" n="03" title="One URL, any client">
              Pick your client. Most take one click.
            </Head>
            <Connect />
          </div>
        </section>

        {releases.length ? (
          <section id="new" className="section section-alt" aria-labelledby="new-title">
            <div className="wrap">
              <Head id="new" n="04" title="What's new">
                The latest releases, straight from the changelog.
              </Head>
              <ol className="releases">
                {releases.map((r) => (
                  <li key={r.version}>
                    <a className="release" href={`/changelog#${slug(r.heading)}`}>
                      <span className="release-head">
                        <span className="release-v">{r.version}</span>
                        {r.date ? (
                          <time className="release-date" dateTime={r.date}>
                            {new Date(`${r.date}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" })}
                          </time>
                        ) : null}
                      </span>
                      <ul className="release-titles">
                        {r.titles.map((t, i) => (
                          <li key={i}>{inline(t, `${r.version}-${i}`)}</li>
                        ))}
                      </ul>
                      <span className="release-go">Read the notes →</span>
                    </a>
                  </li>
                ))}
              </ol>
              <p className="muted small">
                Every release is on <a href="/changelog">the changelog</a>, and the code on <a href={REPO_URL}>GitHub</a>.
              </p>
            </div>
          </section>
        ) : null}

        <section id="ideas" className="section" aria-labelledby="ideas-title">
          <div className="wrap">
            <Head id="ideas" n="05" title="Ideas to launch">
              {ideas.length} agents to launch and run, each with a full spec and a starter you deploy to your GitHub in one
              click, and {modules.length} modules that add one thing to an agent you already run.
            </Head>
            <ul className="idea-rows">
              {ideas.map((idea) => (
                <li key={idea.slug}>
                  <a href={`/ideas/${idea.slug}`}>
                    <span className="idea-row-name">
                      <strong>{idea.title}</strong>
                      <span className="idea-link-meta">
                        {idea.difficulty} · {idea.minutesToDryRun} min to a dry run
                      </span>
                    </span>
                    <span className="muted">{idea.oneLiner}</span>
                    <span className="idea-row-go" aria-hidden="true">
                      →
                    </span>
                  </a>
                </li>
              ))}
            </ul>
            <p className="muted small">
              Modules: {modules.map((m, i) => (
                <span key={m.slug}>
                  {i ? ", " : ""}
                  <a href={`/modules/${m.slug}`}>{m.title}</a>
                </span>
              ))}
              . <a href="/ideas">All ideas and modules →</a>
            </p>
          </div>
        </section>

        <section id="tools" className="section section-alt" aria-labelledby="tools-title">
          <div className="wrap">
            <Head id="tools" n="06" title={`${catalog.tools.length} tools`}>
              {hostedCount === catalog.tools.length ? "All of them run" : `${hostedCount} run`} on the hosted server.{" "}
              {buildCount} build transactions you review and sign in your own wallet; the rest only read.{" "}
              {localOnly ? `${localOnly} more run only on your own computer, inside your policy. ` : ""}Listed straight from
              the server; parameters and examples are in the docs.
            </Head>
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

        <section id="safety" className="section" aria-labelledby="safety-title">
          <div className="wrap">
            <Head id="safety" n="07" title="Built to keep agents on the wire" />
            <ul className="points">
              <li>
                <h3>Checked before you sign</h3>
                <p className="muted">
                  Every transaction Highwire builds is checked against an allow-list, decoded into plain language and
                  simulated. The sign page checks it again in your browser, from its own bytes, and refuses anything else.
                </p>
              </li>
              <li>
                <h3>Your key stays yours</h3>
                <p className="muted">
                  The hosted server never holds a key or sends a transaction. The local signer reads yours only from a file on
                  your computer, and no tool can write its policy. Highwire never asks for a private key or seed phrase.
                </p>
              </li>
              <li>
                <h3>Limits only you set</h3>
                <p className="muted">
                  Caps per trade and per day, allowlists, slippage, a kill switch and a daily post limit. Each send is logged,
                  with what it spends, before it goes out.
                </p>
              </li>
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
                <h3>No sandwiches</h3>
                <p className="muted">
                  Agents can send trades and claims through Jito as one-transaction bundles: they can&apos;t be sandwiched,
                  and one that would fail costs nothing.
                </p>
              </li>
            </ul>
          </div>
        </section>

        <section className="section section-alt" id="support" aria-labelledby="support-title">
          <div className="wrap">
            <div className="section-head">
              <h2 id="support-title">Support Highwire</h2>
              <p>
                Highwire is open source. Trades it builds carry a 0.3% fee, shown in each transaction before you sign;
                launches, claims and everything else are free. If you&apos;d like to chip in too, donations go to the same
                wallet, and only this one. Entirely optional.
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
