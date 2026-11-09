"use client";

import { useId, useState } from "react";
import { breakEvenPct, CREATOR_PCT, HIGHWIRE_PCT, HOLDERS_PCT, roundTrip, winsToBreakEven } from "../../lib/idea-math.ts";

// What an idea's numbers come to. The fee ideas (buyback, compute, treasury) work from a daily trading volume, the
// visitor's guess anchored by real higher.fun volumes read when the page was built, at New school curve rates. The
// trading ideas work out one round, a buy and a sale, with the coin's trading fee and Highwire's 0.3% both ways.

export interface MarketContext {
  /** SOL traded in the last 24 hours by the busiest of higher.fun's 100 trending coins, and by their median. */
  topVolumeSol: number | null;
  medianVolumeSol: number | null;
  solUsd: number | null;
}

export type CalculatorKind = "buyback" | "compute" | "trading" | "treasury" | "line";

const fmt = (n: number, d = n >= 100 ? 0 : n >= 10 ? 1 : n >= 1 ? 2 : 3) =>
  n > 0 && n < Math.pow(10, -d) ? `<${Math.pow(10, -d).toFixed(d)}` : n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
const signed = (n: number, d?: number) => `${n >= 0 ? "+" : "−"}${fmt(Math.abs(n), d)}`;

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

function Out({ rows, note }: { rows: [string, string][]; note: React.ReactNode }) {
  return (
    <>
      <dl className="calc-out" aria-live="polite">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="muted small calc-note">{note}</p>
    </>
  );
}

function TradingCalculator() {
  const [buySol, setBuySol] = useState(0.05);
  const [takePct, setTakePct] = useState(40);
  const [stopPct, setStopPct] = useState(15);
  const [feePct, setFeePct] = useState(1);

  const win = roundTrip(buySol, takePct, feePct);
  const loss = roundTrip(buySol, -stopPct, feePct);
  const flat = roundTrip(buySol, 0, feePct);
  const wins = winsToBreakEven(win.net, loss.net);
  const rows: [string, string][] = [
    ["A take-profit round", `${signed(win.net, 4)} SOL`],
    ["A stop-loss round", `${signed(loss.net, 4)} SOL`],
    ["Fees on a round, price unchanged", `${fmt(-flat.net, 4)} SOL`],
    ["Rise needed to break even", `${fmt(breakEvenPct(feePct), 2)}%`],
    ["Rounds that must win to break even", wins === null ? "none can win at these levels" : `${fmt(wins * 100, 0)}%`],
    ["Highwire's 0.3% on a round", `${fmt(flat.highwire, 5)} SOL`],
  ];
  return (
    <div className="calc">
      <div className="calc-fields">
        <Field label="SOL per buy" value={buySol} onChange={setBuySol} min={0.01} max={1} step={0.01} suffix="SOL" />
        <Field label="Take-profit, above the buy" value={takePct} onChange={setTakePct} min={1} max={500} step={1} suffix="%" />
        <Field label="Stop-loss, below the buy" value={stopPct} onChange={setStopPct} min={1} max={90} step={1} suffix="%" />
        <Field label="The coin's trading fee" value={feePct} onChange={setFeePct} min={0} max={2} step={0.05} suffix="%" hint="1% on a New school curve, 0.25% on Old school, about 0.3% after a coin graduates." />
      </div>
      <Out
        rows={rows}
        note={
          <>
            The trading fee and Highwire&apos;s {HIGHWIRE_PCT}% are paid on the buy and again on the sale. Slippage, price
            impact and network fees aside, so real rounds come out a little worse. Arithmetic at levels you choose, not a
            forecast: most rounds in new coins hit the stop.
          </>
        }
      />
    </div>
  );
}

/** The Line: what starting costs in SOL, and what playing costs if the agent thinks with a model. Nothing is won. */
function LineCalculator({ solUsd: startUsd }: { solUsd: number | null }) {
  const [firstBuy, setFirstBuy] = useState(0.01);
  const [perDay, setPerDay] = useState(4);
  const [modelUsd, setModelUsd] = useState(0);
  const solUsd = startUsd ?? 150;
  const start = 0.02 + 0.025 + firstBuy + 0.000005;
  const month = perDay * 30 * modelUsd;
  const rows: [string, string][] = [
    ["SOL to start", `${fmt(start, 3)} SOL (about $${fmt(start * solUsd, 0)})`],
    ["Registering on The Line", "one network fee, about 0.000005 SOL"],
    ["Matches a month", fmt(perDay * 30, 0)],
    ["Playing, on-chain", "nothing"],
    ["A model, a month", modelUsd ? `about $${fmt(month, 0)}` : "nothing: the default strategy is code"],
  ];
  return (
    <div className="calc">
      <div className="calc-fields">
        <Field label="First buy at launch" value={firstBuy} onChange={setFirstBuy} min={0} max={0.1} step={0.005} suffix="SOL" hint="Optional. The launch fee (0.02 SOL) and about 0.025 SOL of rent and network fees come on top." />
        <Field label="Matches a day" value={perDay} onChange={setPerDay} min={0} max={24} step={1} suffix="matches" />
        <Field label="Model cost per match" value={modelUsd} onChange={setModelUsd} min={0} max={3} step={0.05} suffix="$" hint="0 for the default strategy. With a frontier model, roughly $0.30 to $2 a match (an estimate)." />
      </div>
      <Out rows={rows} note={<>The Line awards nothing: no prizes, no betting. A record says nothing about a coin, and isn&apos;t a reason to buy one.</>} />
    </div>
  );
}

export function IdeaCalculator({ kind, market }: { kind: CalculatorKind; market: MarketContext }) {
  const start = Math.round(Math.min(500, Math.max(10, market.medianVolumeSol ?? 50)));
  const [volume, setVolume] = useState(start);
  const [buybackPct, setBuybackPct] = useState(50);
  const [solUsd, setSolUsd] = useState(Math.round(market.solUsd ?? 150));
  const [gpuUsd, setGpuUsd] = useState(2);
  const [budgetPct, setBudgetPct] = useState(80);
  const [reservePct, setReservePct] = useState(20);
  const [recipients, setRecipients] = useState(2);

  if (kind === "trading") return <TradingCalculator />;
  if (kind === "line") return <LineCalculator solUsd={market.solUsd} />;

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
  } else if (kind === "treasury") {
    const week = creator * 7;
    const paid = (week * (100 - reservePct)) / 100;
    rows = [
      ["Creator fees claimed", `${fmt(creator)} SOL a day`],
      ["Claimed in a week", `${fmt(week)} SOL`],
      [`Kept as the reserve (${reservePct}%)`, `${fmt(week - paid)} SOL a week`],
      ["Paid out", `${fmt(paid)} SOL a week`],
      [`Each of ${recipients} equal shares`, `${fmt(paid / recipients)} SOL a week`],
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
        ) : kind === "treasury" ? (
          <>
            <Field label="Reserve kept from each week" value={reservePct} onChange={setReservePct} min={0} max={90} step={5} suffix="%" />
            <Field label="Wallets it pays" value={recipients} onChange={setRecipients} min={1} max={10} step={1} suffix="wallets" />
          </>
        ) : (
          <>
            <Field label="GPU price" value={gpuUsd} onChange={setGpuUsd} min={0.1} max={20} step={0.1} suffix="$ / hour" hint="What your provider charges for the GPU you pick." />
            <Field label="Share of fees spent on compute" value={budgetPct} onChange={setBudgetPct} min={0} max={100} step={5} suffix="%" />
            <Field label="SOL price" value={solUsd} onChange={setSolUsd} min={1} max={2000} step={1} suffix="$" hint={market.solUsd ? "Filled in from higher.fun's price when this page was built." : undefined} />
          </>
        )}
      </div>
      <Out
        rows={rows}
        note={
          <>
            New school curve rates: the creator earns {CREATOR_PCT}% of every trade, and higher.fun airdrops {HOLDERS_PCT}% to
            holders. After graduation the creator&apos;s pool fee is smaller. Network fees aside. An estimate at a volume you
            choose, not a forecast.
          </>
        }
      />
    </div>
  );
}
