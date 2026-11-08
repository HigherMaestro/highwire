import type { CSSProperties, ReactNode } from "react";
import type { Recipient } from "highwire-core";
import { AmbientWire } from "../hero/AmbientWire.tsx";
import { RECIPIENTS, updatedAt } from "../../lib/fees.ts";

// The pieces the fee pages share: the wire header with one large figure, numbered section heads, and figures in cards.

export const COLOR = Object.fromEntries(RECIPIENTS.map((r) => [r.key, r.color])) as Record<Recipient, string>;

export type Fact = { label: string; value: string };

/** The wire header: an eyebrow, a title, then the page's one large figure, a row of facts and when it was read. */
export function FeeHero({
  id,
  eyebrow,
  title,
  sub,
  figure,
  figureSub,
  facts,
  readAt,
  children,
}: {
  id: string;
  eyebrow: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  figure?: string;
  figureSub?: ReactNode;
  facts?: Fact[];
  readAt?: string;
  children?: ReactNode;
}) {
  return (
    <section className="page-hero fees-hero" aria-labelledby={id}>
      <AmbientWire />
      <div className="wrap page-hero-copy">
        <p className="eyebrow">{eyebrow}</p>
        <h1 id={id}>{title}</h1>
        {sub ? <p className="mono-wrap fee-hero-id">{sub}</p> : null}
        {figure ? (
          <div className="fee-hero-figure">
            <span className="fee-hero-n">
              {figure}
              <small> SOL</small>
            </span>
            {figureSub ? <span className="fee-hero-sub">{figureSub}</span> : null}
          </div>
        ) : null}
        {facts?.length ? (
          <dl className="fee-hero-facts">
            {facts.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {children}
        {readAt ? (
          <p className="fee-fresh">
            <span className="fee-fresh-dot" aria-hidden="true" />
            Read {updatedAt(readAt)} · refreshed every 10 minutes
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** A section's heading, numbered like the ideas pages, with a line under it. */
export function Head({ id, n, title, children }: { id: string; n: string; title: string; children?: ReactNode }) {
  return (
    <div className="section-head">
      <h2 id={`${id}-title`} className="sec-h">
        <span className="sec-n">{n}</span>
        {title}
      </h2>
      {children ? <p className="muted">{children}</p> : null}
    </div>
  );
}

/** A figure in a card: a small label, the number, and a line under it, with a hairline of a recipient's colour. */
export function Tile({ label, value, unit, sub, accent }: { label: string; value: string; unit?: string; sub?: ReactNode; accent?: string }) {
  return (
    <div className="fee-tile" style={accent ? ({ "--accent": accent } as CSSProperties) : undefined}>
      <span className="fee-tile-label">{label}</span>
      <span className="fee-tile-n">
        {value}
        {unit ? <small> {unit}</small> : null}
      </span>
      {sub ? <span className="fee-tile-sub">{sub}</span> : null}
    </div>
  );
}

/** Links out, as a row of cards. */
export function LinkCards({ links }: { links: { href: string; label: string; sub: string }[] }) {
  return (
    <ul className="fee-linkcards">
      {links.map((l) => (
        <li key={l.href}>
          <a href={l.href}>
            <strong>{l.label} →</strong>
            <span className="muted small">{l.sub}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
