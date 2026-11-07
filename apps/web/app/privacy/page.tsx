import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "../../components/Chrome.tsx";
import { REPO_URL, pageMetadata } from "../../lib/site.ts";

export const metadata: Metadata = {
  ...pageMetadata({
    title: "Privacy",
    description: "What Highwire's site, hosted endpoint and sign page record. Draft, pending legal review.",
    path: "/privacy",
  }),
};

// A plain-language starting draft, based on a standard website privacy notice
// template. Not reviewed by a lawyer yet. Keep it true to the code: the hosted
// endpoint (packages/mcp/src/http.ts) and the sign page (components/sign).

export default function PrivacyPage() {
  return (
    <>
      <SiteHeader />
      <main className="prose-page">
        <div className="wrap">
          <article className="prose">
            <p className="draft-flag">Draft, pending legal review</p>
            <h1>Privacy notice</h1>
            <p className="muted">Last updated 5 November 2026. This is a starting draft and may change before it is final.</p>

            <p>
              Highwire is built to know as little about you as possible. There are no accounts, no sign-in, no cookies and no
              advertising. This notice covers highwire.fun, the hosted MCP endpoint at highwire.fun/mcp and the
              sign page at highwire.fun/sign.
            </p>

            <h2>The sign page keeps nothing</h2>
            <ul>
              <li>
                The transaction travels in the part of the sign link after <code>#</code>. Browsers never send that part to a
                server, so Highwire never receives it.
              </li>
              <li>
                The page decodes and checks the transaction in your browser. To simulate and send it, your browser talks
                directly to a Solana RPC provider, which sees the transaction and your wallet address as any Solana app&apos;s
                RPC does. The page&apos;s security policy blocks it from contacting any other server, Highwire&apos;s included.
              </li>
              <li>Your wallet signs. The page never sees or asks for a private key or seed phrase.</li>
              <li>The page stores nothing, apart from your light or dark theme choice in your browser, if you pick one.</li>
              <li>The page has no analytics. It isn&apos;t counted in the site&apos;s page views below.</li>
            </ul>

            <h2>The hosted endpoint logs counts, not bodies</h2>
            <ul>
              <li>
                We don&apos;t record the content of requests or responses: not your prompts, tool arguments, wallet addresses or
                results.
              </li>
              <li>
                To rate-limit, the endpoint counts requests per IP address in memory for one minute, then forgets them.
              </li>
              <li>When a request fails unexpectedly, the error message is logged so we can fix it.</li>
              <li>
                To answer a tool call, the endpoint passes what it needs (for example a coin&apos;s mint or a wallet address) to
                higher.fun&apos;s API and to a Solana RPC provider.
              </li>
            </ul>

            <h2>Our host</h2>
            <p>
              The site runs on Vercel, which keeps standard request logs (such as time, path, status, IP address and browser)
              for a limited period to run and protect the service.
            </p>
            <p>
              The site&apos;s other pages use Vercel Web Analytics to count page views. It sets no cookies and doesn&apos;t
              identify you across sites or days: it records the page (without anything after <code>?</code> or{" "}
              <code>#</code>), the referring site, and your country, browser, operating system and device type, and doesn&apos;t
              keep your IP address. We don&apos;t add any other analytics or third-party scripts.
            </p>

            <h2>Your AI client</h2>
            <p>
              Whatever you type into an AI client, and what it sends to Highwire, is handled by that client&apos;s provider
              under their own privacy policy.
            </p>

            <h2>Running it yourself</h2>
            <p>
              The local server (<code>highwire-mcp</code>) runs on your computer and sends nothing to Highwire. It talks only to
              higher.fun&apos;s API and the Solana RPC you configure.
            </p>

            <h2>Children</h2>
            <p>Highwire isn&apos;t meant for anyone under 18.</p>

            <h2>Changes and contact</h2>
            <p>
              We&apos;ll update this notice when what we collect changes; the date at the top says when. Questions go to{" "}
              <a href={`${REPO_URL}/issues`}>GitHub issues</a>. See also the <a href="/terms">terms</a>.
            </p>
          </article>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
