import { REPO_URL, SITE_URL, X_HANDLE, X_URL } from "../lib/site.ts";
import { Lockup } from "./Mark.tsx";
import { MobileMenu, type NavLink } from "./MobileMenu.tsx";
import { NavLinks } from "./NavLinks.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

// The header keeps to what people come for: four places, two icons, the theme, and one action. Everything else is in
// the footer.
const PAGES = [
  { href: "/line", label: "The Line" },
  { href: "/docs", label: "Docs" },
  { href: "/ideas", label: "Ideas", match: ["/ideas", "/modules"] },
  { href: "/fees", label: "Fees" },
];

/** The phone menu: the same places, the action, and the two profiles written out. */
const MENU: NavLink[] = [
  { href: "/#connect", label: "Connect your agent" },
  ...PAGES,
  { href: REPO_URL, label: "GitHub" },
  { href: X_URL, label: `X (${X_HANDLE})` },
];

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.68.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path
        fill="currentColor"
        d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.66l-5.21-6.82-5.97 6.82H1.67l7.73-8.84L1.25 2.25h6.83l4.71 6.23 5.45-6.23Zm-1.16 17.52h1.83L7.08 4.13H5.12l11.96 15.64Z"
      />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="wrap header-row">
        <a href="/" className="home-link" aria-label="Highwire home">
          <Lockup id="hdr" />
        </a>
        <nav aria-label="Main" className="nav-wide">
          <NavLinks links={PAGES} />
        </nav>
        <div className="header-right">
          <a className="icon-link nav-wide" href={REPO_URL} aria-label="Highwire on GitHub" title="GitHub">
            <GitHubIcon />
          </a>
          <a className="icon-link nav-wide" href={X_URL} aria-label={`Highwire on X (${X_HANDLE})`} title={`X (${X_HANDLE})`}>
            <XIcon />
          </a>
          <ThemeToggle />
          <a className="button header-cta nav-wide" href="/#connect">
            Connect
          </a>
          <MobileMenu links={MENU} />
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
              <a href="/line">The Line</a>
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
