"use client";

import { useMemo, useState } from "react";

export interface FeeRow {
  mint: string;
  ticker: string | null;
  name: string | null;
  mode: string;
  status: string;
  volumeSol: number;
  feesSol: number;
  creatorSol: number;
  higherSol: number;
  createdAt: string | null;
}

const SORTS = {
  fees: { label: "Most fees", key: (r: FeeRow) => r.feesSol },
  volume: { label: "Most volume", key: (r: FeeRow) => r.volumeSol },
  creator: { label: "Most to creator", key: (r: FeeRow) => r.creatorSol },
  newest: { label: "Newest", key: (r: FeeRow) => (r.createdAt ? Date.parse(r.createdAt) : 0) },
} as const;

const PAGE = 50;

function fmt(n: number) {
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : abs >= 0.01 ? 3 : abs > 0 ? 4 : 0;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Every coin's fees: search by ticker, name or mint, and sort. Names are creator-written text, shown as text only. */
export function FeeTable({ rows }: { rows: FeeRow[] }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<keyof typeof SORTS>("fees");
  const [shown, setShown] = useState(PAGE);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^\$/, "");
    const hits = needle
      ? rows.filter((r) => r.mint.toLowerCase() === needle || (r.ticker ?? "").toLowerCase().includes(needle) || (r.name ?? "").toLowerCase().includes(needle))
      : rows;
    const key = SORTS[sort].key;
    return [...hits].sort((a, b) => key(b) - key(a));
  }, [rows, q, sort]);

  return (
    <div className="fee-table">
      <div className="fee-controls">
        <label className="fee-search">
          <span className="sr-only">Search coins</span>
          <input type="search" placeholder="Search by ticker, name or mint" value={q} onChange={(e) => (setQ(e.target.value), setShown(PAGE))} />
        </label>
        <label className="fee-sort">
          <span className="muted small">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as keyof typeof SORTS)}>
            {Object.entries(SORTS).map(([k, s]) => (
              <option key={k} value={k}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">
          {list.length.toLocaleString("en-US")} {list.length === 1 ? "coin" : "coins"}
        </span>
      </div>
      <div className="table-wrap">
        <table className="params fees">
          <thead>
            <tr>
              <th scope="col">Coin</th>
              <th scope="col">Mode</th>
              <th scope="col" className="num">
                Volume (SOL)
              </th>
              <th scope="col" className="num">
                Fees (SOL)
              </th>
              <th scope="col" className="num">
                To creator
              </th>
              <th scope="col" className="num">
                To higher.fun
              </th>
            </tr>
          </thead>
          <tbody>
            {list.slice(0, shown).map((r) => (
              <tr key={r.mint}>
                <td data-label="Coin">
                  <a href={`/fees/${r.mint}`} className="fee-coin">
                    <strong>{r.ticker ? `$${r.ticker}` : `${r.mint.slice(0, 4)}…${r.mint.slice(-4)}`}</strong>
                    {r.name ? <span className="muted"> {r.name}</span> : null}
                  </a>
                  {r.status === "graduated" ? <span className="badge fee-grad">graduated</span> : null}
                </td>
                <td data-label="Mode">{r.mode}</td>
                <td data-label="Volume (SOL)" className="num">
                  {fmt(r.volumeSol)}
                </td>
                <td data-label="Fees (SOL)" className="num">
                  <strong>{fmt(r.feesSol)}</strong>
                </td>
                <td data-label="To creator" className="num">
                  {fmt(r.creatorSol)}
                </td>
                <td data-label="To higher.fun" className="num">
                  {fmt(r.higherSol)}
                </td>
              </tr>
            ))}
            {list.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No higher.fun coin matches “{q}”.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {list.length > shown ? (
        <button type="button" className="button button-quiet button-small fee-more" onClick={() => setShown((n) => n + PAGE * 4)}>
          Show more ({(list.length - shown).toLocaleString("en-US")} left)
        </button>
      ) : null}
    </div>
  );
}
