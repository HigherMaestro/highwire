"use client";

import { useState } from "react";

// Fees day by day as stacked columns, one colour per recipient, on one axis. Hovering, focusing or tapping a day shows
// its numbers in the readout above; it starts on the last full day, since today is still going.

export type ChartDay = { day: string; feesSol: number; volumeSol: number; byRecipient: Record<string, number> };
export type ChartSeries = { key: string; label: string; color: string };

const fmt = (n: number) => {
  const d = n >= 100 ? 0 : n >= 10 ? 1 : n >= 1 ? 2 : 3;
  return n.toLocaleString("en-US", { minimumFractionDigits: n > 0 ? Math.min(d, 1) : 0, maximumFractionDigits: d });
};

const axis = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 2 : n < 10 ? 1 : 0 });

const dateLabel = (day: string, long = false) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", ...(long ? { weekday: "short" } : {}) });

/** A round top for the axis: 1, 2 or 5 times a power of ten, at or above the busiest day. */
function niceMax(n: number): number {
  if (n <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= n) ?? 10) * p;
}

export function FeeChart({ days, series, solUsd, title }: { days: ChartDay[]; series: ChartSeries[]; solUsd: number | null; title: string }) {
  const today = days.length - 1;
  const [active, setActive] = useState(Math.max(0, today - 1));
  const top = niceMax(Math.max(...days.map((d) => d.feesSol)));
  const shown = series.filter((s) => days.some((d) => (d.byRecipient[s.key] ?? 0) > 0));
  const a = days[active]!;
  const usd = solUsd ? ` · $${(a.feesSol * solUsd).toLocaleString("en-US", { maximumFractionDigits: a.feesSol * solUsd >= 100 ? 0 : 2 })}` : "";
  return (
    <figure className="fee-panel fee-chart">
      <figcaption className="fee-chart-head">
        <span className="fee-panel-title">{title}</span>
        <span className="fee-legend">
          {shown.map((s) => (
            <span key={s.key}>
              <i style={{ background: s.color }} aria-hidden="true" />
              {s.label}
            </span>
          ))}
        </span>
      </figcaption>
      <div className="fee-chart-readout" aria-live="polite">
        <span className="fee-tile-label">
          {dateLabel(a.day, true)}
          {active === today ? " · today so far" : ""}
        </span>
        <span className="fee-chart-total">
          {fmt(a.feesSol)} <small>SOL in fees{usd}</small>
        </span>
        <span className="fee-chart-parts">
          {shown.map((s) => (
            <span key={s.key}>
              <i style={{ background: s.color }} aria-hidden="true" />
              {s.label} {fmt(a.byRecipient[s.key] ?? 0)}
            </span>
          ))}
          <span className="muted">from {fmt(a.volumeSol)} SOL traded</span>
        </span>
      </div>
      <div className="fee-chart-plot">
        <div className="fee-chart-grid" aria-hidden="true">
          {[1, 0.5, 0].map((f) => (
            <span key={f} style={{ bottom: `${f * 100}%` }}>
              <em>{axis(top * f)}</em>
            </span>
          ))}
        </div>
        <ol className="fee-chart-cols" aria-label={`${title}, SOL a day`}>
          {days.map((d, i) => (
            <li key={d.day}>
              <button
                type="button"
                aria-pressed={i === active}
                aria-label={`${dateLabel(d.day, true)}: ${fmt(d.feesSol)} SOL in fees${i === today ? " so far" : ""}`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onClick={() => setActive(i)}
                className={i === today ? "fee-col fee-col-today" : "fee-col"}
              >
                <span className="fee-col-stack" style={{ height: `${(d.feesSol / top) * 100}%` }}>
                  {shown.map((s) =>
                    (d.byRecipient[s.key] ?? 0) > 0 ? <span key={s.key} style={{ flexGrow: d.byRecipient[s.key], background: s.color }} /> : null,
                  )}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      {days.length <= 14 ? (
        <ol className="fee-chart-x fee-chart-x-each" aria-hidden="true">
          {days.map((d, i) => (
            <li key={d.day}>{i === today ? "Today" : dateLabel(d.day)}</li>
          ))}
        </ol>
      ) : (
        <div className="fee-chart-x" aria-hidden="true">
          <span>{dateLabel(days[0]!.day)}</span>
          <span>{dateLabel(days[Math.floor(today / 2)]!.day)}</span>
          <span>Today</span>
        </div>
      )}
    </figure>
  );
}
