import { REPO_URL, SITE_URL, X_HANDLE, X_URL } from "../lib/site.ts";
import { Lockup } from "./Mark.tsx";
import { MobileMenu, type NavLink } from "./MobileMenu.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

const LINKS: NavLink[] = [
  { href: "/#connect", label: "Connect" },
  { href: "/docs", label: "Docs" },
  { href: "/ideas", label: "Ideas" },
  { href: "/fees", label: "Fees" },
  { href: REPO_URL, label: "GitHub" },
  { href: X_URL, label: "X", ariaLabel: `Highwire on X (${X_HANDLE})` },
];

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="wrap header-row">
        <a href="/" className="home-link" aria-label="Highwire home">
          <Lockup id="hdr" />
        </a>
        <div className="header-right">
          <nav aria-label="Main" className="nav-wide">
            <ul className="nav">
              {LINKS.map((l) => (
                <li key={l.href}>
                  <a href={l.href} aria-label={l.ariaLabel}>
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <ThemeToggle />
          <MobileMenu links={LINKS} />
        </div>
      </div>
    </header>
  );
}

/** Impostor coins and sites are a given on a launchpad; say plainly what's official. */
export function OfficialNotice() {
  return (
    <aside className="notice" aria-label="Official links">
      <strong>There is no Highwire token.</strong> Any coin using the Highwire name is not ours. Official links:{" "}
      <a href={SITE_URL}>highwire.fun</a>, <a href={X_URL}>{X_HANDLE}</a> and{" "}
      <a href={REPO_URL}>github.com/HigherMaestro/highwire</a>.
    </aside>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="wrap footer-stack">
        <OfficialNotice />
        <nav aria-label="Footer">
          <ul className="footer-links">
            <li>
              <a href="/docs">Docs</a>
            </li>
            <li>
              <a href="/docs#signing">Signing</a>
            </li>
            <li>
              <a href="/ideas">Launch ideas</a>
            </li>
            <li>
              <a href="/fees">Ecosystem fees</a>
            </li>
            <li>
              <a href="/#support">Support</a>
            </li>
            <li>
              <a href="/changelog">Changelog</a>
            </li>
            <li>
              <a href="/terms">Terms</a>
            </li>
            <li>
              <a href="/privacy">Privacy</a>
            </li>
          </ul>
        </nav>
        <div className="footer-row">
          <Lockup id="ftr" />
          <p className="muted small">
            MIT licensed. <a href={REPO_URL}>Source on GitHub</a>. Follow <a href={X_URL}>{X_HANDLE}</a> on X. Not
            affiliated with higher.fun. Nothing here is financial advice.
          </p>
        </div>
      </div>
    </footer>
  );
}
