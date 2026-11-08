import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "../components/Chrome.tsx";
import { AmbientWire } from "../components/hero/AmbientWire.tsx";

export const metadata: Metadata = { title: "Not found", robots: { index: false } };

// Off the wire: a page that isn't here, with the ways back on.
export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="page-hero not-found" aria-labelledby="nf-title">
          <AmbientWire />
          <div className="wrap page-hero-copy">
            <p className="eyebrow">404 · off the wire</p>
            <h1 id="nf-title">There&apos;s nothing at this address</h1>
            <p className="lead">
              The link may be old, or mistyped. A coin or wallet&apos;s fees live at <code>/fees/&lt;address&gt;</code> and{" "}
              <code>/fees/creator/&lt;wallet&gt;</code>.
            </p>
            <div className="fee-hero-ctas">
              <a className="button" href="/">
                Home
              </a>
              <a className="button button-quiet" href="/docs">
                Docs
              </a>
              <a className="button button-quiet" href="/fees">
                Ecosystem fees
              </a>
              <a className="button button-quiet" href="/ideas">
                Launch ideas
              </a>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
