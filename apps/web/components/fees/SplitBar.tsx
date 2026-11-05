import type { Recipient } from "highwire-core";
import { RECIPIENTS, pctOf, sol } from "../../lib/fees.ts";

/** One bar split by who got the fees, with a legend that carries the numbers. */
export function SplitBar({ by, total, label, notes = false }: { by: Record<Recipient, number>; total: number; label: string; notes?: boolean }) {
  const parts = RECIPIENTS.filter((r) => by[r.key] > 0);
  return (
    <figure className="split">
      <div className="split-bar" role="img" aria-label={`${label}: ${parts.map((r) => `${r.label} ${pctOf(by[r.key], total)}`).join(", ")}`}>
        {parts.map((r) => (
          <span key={r.key} style={{ width: `${(by[r.key] / total) * 100}%`, background: r.color }} />
        ))}
      </div>
      <ul className="split-legend">
        {RECIPIENTS.map((r) => (
          <li key={r.key}>
            <span className="split-swatch" style={{ background: r.color }} aria-hidden="true" />
            <span className="split-name">{r.label}</span>
            <span className="split-value">
              {sol(by[r.key])} SOL <span className="muted">· {pctOf(by[r.key], total)}</span>
            </span>
            {notes ? <span className="split-note muted">{r.note}.</span> : null}
          </li>
        ))}
      </ul>
    </figure>
  );
}
