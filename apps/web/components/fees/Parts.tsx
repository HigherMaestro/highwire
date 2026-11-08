import type { CSSProperties, ReactNode } from "react";
import type { Recipient } from "highwire-core";
import { AmbientWire } from "../hero/AmbientWire.tsx";
import { RECIPIENTS, sol, updatedAt, type FeeHistory } from "../../lib/fees.ts";
import { FeeChart } from "./FeeChart.tsx";

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

const SERIES = RECIPIENTS.map((r) => ({ key: r.key, label: r.label, color: r.color }));

const dayName = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });

/**
 * The line over a chart: the last seven full days against the seven before ("41.2 SOL in the last seven days, up 12% on
 * the week before"), or, with less than two weeks to go on, everything since the first day.
 */
export function weekOnWeek(h: FeeHistory, pick: (d: FeeHistory["days"][number]) => number = (d) => d.feesSol, what = "in fees"): { line: string } {
  const full = h.days.slice(0, -1);
  if (full.length < 14) return { line: `${sol(h.days.reduce((n, d) => n + pick(d), 0))} SOL ${what} since ${dayName(h.days[0]!.day)}.` };
  const sum = (a: typeof full) => a.reduce((n, d) => n + pick(d), 0);
  const last = sum(full.slice(-7));
  const before = sum(full.slice(-14, -7));
  const change = before > 0 ? ((last - before) / before) * 100 : null;
  const line =
    change == null
      ? `${sol(last)} SOL ${what} in the last seven days.`
      : `${sol(last)} SOL ${what} in the last seven days, ${Math.abs(change) < 0.5 ? "level with" : `${change > 0 ? "up" : "down"} ${Math.abs(change).toFixed(0)}% on`} the week before.`;
  return { line };
}

/** Fees day by day: the chart, and how it's worked out. */
export function HistoryChart({ history, solUsd, title, scope }: { history: FeeHistory; solUsd: number | null; title: string; scope?: string }) {
  return (
    <>
      <FeeChart days={history.days} series={SERIES} solUsd={solUsd} title={title} />
      <p className="fee-chart-foot">
        Estimated from higher.fun's daily volume at each coin's on-chain rates, in UTC days
        {scope ? `; ${scope}` : ""}. Today is still going.
      </p>
    </>
  );
}
