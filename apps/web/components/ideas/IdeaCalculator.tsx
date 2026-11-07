"use client";

import { useId, useState } from "react";

// What an idea's numbers come to at a given trading volume. Rates are higher.fun's New school curve rates and
// Highwire's trade fee; volume is the visitor's guess, anchored by real higher.fun volumes read when the page was built.

export interface MarketContext {
  /** SOL traded in the last 24 hours by the busiest of higher.fun's 100 trending coins, and by their median. */
  topVolumeSol: number | null;
  medianVolumeSol: number | null;
  solUsd: number | null;
}

const CREATOR_PCT = 0.25;
const HOLDERS_PCT = 0.25;
const HIGHWIRE_PCT = 0.3;

const fmt = (n: number, d = n >= 100 ? 0 : n >= 10 ? 1 : n >= 1 ? 2 : 3) =>
  n > 0 && n < Math.pow(10, -d) ? `<${Math.pow(10, -d).toFixed(d)}` : n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });

function Field({ label, value, onChange, min, max, step, suffix, hint }: { label: string; value: number; onChange: (n: number) => void; min: number; max: number; step: number; suffix: string; hint?: string }) {
  const id = useId();
  return (
    <div className="calc-field">
      <label htmlFor={id}>{label}</label>
      <div className="calc-input">
        <input id={id} type="number" inputMode="decimal" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || 0)))} />
        <span>{suffix}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      {hint ? <p className="muted small">{hint}</p> : null}
    </div>
  );
}

export function IdeaCalculator({ kind, market }: { kind: "buyback" | "compute"; market: MarketContext }) {
  const start = Math.round(Math.min(500, Math.max(10, market.medianVolumeSol ?? 50)));
  const [volume, setVolume] = useState(start);
  const [buybackPct, setBuybackPct] = useState(50);
  const [solUsd, setSolUsd] = useState(Math.round(market.solUsd ?? 150));
  const [gpuUsd, setGpuUsd] = useState(2);
  const [budgetPct, setBudgetPct] = useState(80);

  const creator = (volume * CREATOR_PCT) / 100;
  const holders = (volume * HOLDERS_PCT) / 100;
  const anchor =
    market.topVolumeSol != null && market.medianVolumeSol != null
      ? `For scale, in the last 24 hours the busiest of higher.fun's trending coins traded ${fmt(market.topVolumeSol)} SOL, and the median one ${fmt(market.medianVolumeSol)} SOL.`
      : "Most coins trade far less than the busiest few.";

  let rows: [string, string][];
  if (kind === "buyback") {
    const bought = (creator * buybackPct) / 100;
    const fee = (bought * HIGHWIRE_PCT) / 100;
    rows = [
      ["Creator fees claimed", `${fmt(creator)} SOL a day`],
      ["Spent buying back", `${fmt(bought)} SOL a day`],
      ["Kept in the wallet", `${fmt(creator - bought)} SOL a day`],
      ["Highwire's 0.3% on buybacks", `${fmt(fee, 4)} SOL a day`],
      ["Over 30 days, bought back", `${fmt(bought * 30)} SOL`],
      ["Holders also get, from higher.fun", `${fmt(holders)} SOL a day in airdrops`],
    ];
  } else {
    const budgetUsd = (creator * solUsd * budgetPct) / 100;
    const hours = gpuUsd > 0 ? budgetUsd / gpuUsd : 0;
    rows = [
      ["Creator fees claimed", `${fmt(creator)} SOL a day ($${fmt(creator * solUsd)})`],
      [`Compute budget (${budgetPct}%)`, `$${fmt(budgetUsd)} a day`],
      ["GPU time it pays for", `${fmt(hours)} hours a day`],
      ["Over 30 days", `${fmt(hours * 30)} GPU hours`],
      ["Holders also get, from higher.fun", `${fmt(holders)} SOL a day in airdrops`],
    ];
  }

  return (
    <div className="calc">
      <div className="calc-fields">
        <Field label="Daily trading volume in the coin" value={volume} onChange={setVolume} min={0} max={5000} step={5} suffix="SOL" hint={anchor} />
        {kind === "buyback" ? (
          <Field label="Share of each claim spent buying back" value={buybackPct} onChange={setBuybackPct} min={0} max={100} step={5} suffix="%" />
        ) : (
          <>
            <Field label="GPU price" value={gpuUsd} onChange={setGpuUsd} min={0.1} max={20} step={0.1} suffix="$ / hour" hint="What your provider charges for the GPU you pick." />
            <Field label="Share of fees spent on compute" value={budgetPct} onChange={setBudgetPct} min={0} max={100} step={5} suffix="%" />
            <Field label="SOL price" value={solUsd} onChange={setSolUsd} min={1} max={2000} step={1} suffix="$" hint={market.solUsd ? "Filled in from higher.fun's price when this page was built." : undefined} />
          </>
        )}
      </div>
      <dl className="calc-out" aria-live="polite">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="muted small calc-note">
        New school curve rates: the creator earns {CREATOR_PCT}% of every trade, and higher.fun airdrops {HOLDERS_PCT}% to
        holders. After graduation the creator&apos;s pool fee is smaller. Network fees aside. An estimate at a volume you
        choose, not a forecast.
      </p>
    </div>
  );
}
