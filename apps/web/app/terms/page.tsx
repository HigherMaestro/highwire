import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "../../components/Chrome.tsx";
import { DONATION_WALLET, REPO_URL } from "../../lib/site.ts";

export const metadata: Metadata = {
  title: "Terms",
  description: "The terms for using Highwire, its hosted MCP endpoint and its sign page. Draft, pending legal review.",
  alternates: { canonical: "/terms" },
};

// A plain-language starting draft, based on a standard open-source software and
// website terms template. Not reviewed by a lawyer yet.

export default function TermsPage() {
  return (
    <>
      <SiteHeader />
      <main className="prose-page">
        <div className="wrap">
          <article className="prose">
            <p className="draft-flag">Draft, pending legal review</p>
            <h1>Terms of use</h1>
            <p className="muted">Last updated 6 November 2026. This is a starting draft and may change before it is final.</p>

            <p>
              These terms cover highwire.fun, the hosted MCP endpoint at highwire.fun/mcp, the sign page at highwire.fun/sign,
              and the Highwire software (together, &ldquo;Highwire&rdquo;). By using Highwire you agree to them. If you
              don&apos;t agree, don&apos;t use it.
            </p>

            <h2>What Highwire is</h2>
            <p>
              Highwire is open-source software that lets AI agents read data from higher.fun, a Solana launchpad, and prepare
              transactions for you to review and sign. Highwire is not affiliated with higher.fun, Raydium or the Solana
              Foundation.
            </p>

            <h2>Highwire never holds your funds or keys</h2>
            <ul>
              <li>Highwire is non-custodial. It never holds, controls or has access to your wallet, your keys or your funds.</li>
              <li>
                Highwire only builds unsigned transactions. Nothing happens on-chain unless you sign a transaction in your own
                wallet. Highwire will never ask for your private key or seed phrase; anyone who does is not us.
              </li>
              <li>
                You are responsible for what you sign. Read the summary on the sign page and in your wallet before you approve
                anything. Transactions on Solana are final and can&apos;t be reversed by us or anyone else.
              </li>
            </ul>

            <h2>Fees</h2>
            <p>
              A buy or sell that Highwire builds on Solana mainnet carries Highwire&apos;s trade fee: 0.3% of the SOL you pay
              in on a buy, or of the minimum SOL you get on a sell. It&apos;s one transfer to Highwire&apos;s wallet,{" "}
              <code>{DONATION_WALLET}</code>, inside the same transaction, shown in its summary, so you see it before you
              sign. Launches, creator fee claims and transfers carry no Highwire fee, and Highwire
              never takes any part of a coin&apos;s creator fees. higher.fun, Raydium and the Solana network charge their own
              fees, which the quote and the summary show.
            </p>

            <h2>Not financial advice</h2>
            <p>
              Nothing Highwire shows or says, including anything an AI agent says while using it, is financial, investment, legal
              or tax advice. Coins on launchpads are highly speculative and often lose all their value. Rug checks and safety
              grades are signals, not guarantees. Make your own decisions, and only risk what you can afford to lose.
            </p>

            <h2>Launch ideas</h2>
            <p>
              The ideas at <a href="/ideas">/ideas</a>, their specs and their starter code are examples, offered as they are.
              A repository you create from one is yours: you run the agent, you choose its policy and when it goes live, and
              you&apos;re responsible for what it does and for any outside service it uses. An idea describing how a coin
              could earn is not a promise that it will.
            </p>

            <h2>Third parties</h2>
            <p>
              Highwire relies on services it doesn&apos;t control: higher.fun&apos;s API, Raydium&apos;s programs, Solana RPC
              providers, your wallet, your AI client and our host, Vercel. They have their own terms, can change or stop without
              notice, and can be wrong. Coin names, descriptions, comments and chat are written by anonymous users; Highwire
              passes them on as data and doesn&apos;t endorse them.
            </p>

            <h2>Acceptable use</h2>
            <p>
              Don&apos;t use Highwire to break the law, to defraud or impersonate anyone, or to overload or attack the hosted
              endpoint or the services it calls. The hosted endpoint is rate-limited per IP address and we may block traffic
              that abuses it.
            </p>

            <h2>Open source</h2>
            <p>
              The Highwire software is released under the <a href={`${REPO_URL}/blob/main/LICENSE`}>MIT licence</a>. Your use of
              the source code is governed by that licence. These terms cover the hosted services on highwire.fun.
            </p>

            <h2>No warranty</h2>
            <p>
              Highwire is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;, without warranties of any kind, express or
              implied, including merchantability, fitness for a particular purpose and non-infringement. We don&apos;t promise
              that it will be available, accurate, secure or free of errors, or that a transaction it builds will do what you
              expect or land on-chain.
            </p>

            <h2>Limitation of liability</h2>
            <p>
              To the fullest extent the law allows, the people who build and run Highwire are not liable for any loss of funds,
              tokens, profits or data, or any indirect or consequential loss, arising from your use of Highwire, from
              transactions you sign, or from third-party services. Some places don&apos;t allow these limits, so they may not
              all apply to you.
            </p>

            <h2>Changes</h2>
            <p>
              We may update these terms. The date at the top says when they last changed. Using Highwire after a change means
              you accept the new terms.
            </p>

            <h2>Contact</h2>
            <p>
              Questions go to <a href={`${REPO_URL}/issues`}>GitHub issues</a>. See also the <a href="/privacy">privacy
              notice</a>.
            </p>
          </article>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
