"use client";

import { useId, useState } from "react";
import type { FlowScenario, Scenario } from "./FeeFlow.tsx";

// What a coin's trading pays its creator, and everyone else, at a daily volume the visitor picks: the same per-trade
// rates as the fee-flow diagram, read on-chain. Anchored by the real 24-hour volumes of the coins that traded.

const fmt = (n: number) => {
  const d = n >= 100 ? 0 : n >= 10 ? 1 : n >= 1 ? 2 : n >= 0.01 ? 3 : 4;
  return n > 0 && n < 0.0001 ? "<0.0001" : n.toLocaleString("en-US", { maximumFractionDigits: d });
};

const PHASES = { curve: "On the curve", pool: "After graduation" } as const;
const MODES = { rewards: "New school", classic: "Old school" } as const;

export function EarningsCalculator({ scenarios, volumes, solUsd }: { scenarios: Record<Scenario, FlowScenario>; volumes: number[]; solUsd: number | null }) {
  const id = useId();
  const median = volumes.length ? volumes[Math.floor(volumes.length / 2)]! : 50;
  const [volume, setVolume] = useState(Math.round(Math.min(1000, Math.max(5, median))));
  const [mode, setMode] = useState<keyof typeof MODES>("rewards");
  const [phase, setPhase] = useState<keyof typeof PHASES>("curve");
  const s = scenarios[`${phase}-${mode}`];
  const at = (key: string) => (volume * (s.flows.find((f) => f.key === key)?.ratePct ?? 0)) / 100;
  const creator = at("creator");
  const holders = at("holders");
  const all = (volume * s.totalPct) / 100;
  const dollars = (n: number) => (solUsd ? ` ($${(n * solUsd).toLocaleString("en-US", { maximumFractionDigits: n * solUsd >= 100 ? 0 : 2 })})` : "");
  const busier = volumes.filter((v) => v >= volume).length;
  const rows: [string, string][] = [
    ["To the creator", `${fmt(creator)} SOL a day${dollars(creator)}`],
    ["Over 30 days", `${fmt(creator * 30)} SOL${dollars(creator * 30)}`],
    ["To holders, as airdrops", holders > 0 ? `${fmt(holders)} SOL a day` : "none in this mode"],
    [`All fees, ${s.totalPct}% of each trade`, `${fmt(all)} SOL a day`],
  ];
  return (
    <div className="calc">
      <div className="calc-fields">
        <div className="flow-controls">
          <div className="flow-toggle" role="group" aria-label="Fee mode">
            {(Object.keys(MODES) as (keyof typeof MODES)[]).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
                {MODES[m]}
              </button>
            ))}
          </div>
          <div className="flow-toggle" role="group" aria-label="Where the coin trades">
            {(Object.keys(PHASES) as (keyof typeof PHASES)[]).map((p) => (
              <button key={p} type="button" aria-pressed={phase === p} onClick={() => setPhase(p)}>
                {PHASES[p]}
              </button>
            ))}
          </div>
        </div>
        <div className="calc-field">
          <label htmlFor={id}>Daily trading volume in the coin</label>
          <div className="calc-input">
            <input id={id} type="number" inputMode="decimal" min={0} max={10000} step={5} value={volume} onChange={(e) => setVolume(Math.min(10000, Math.max(0, Number(e.target.value) || 0)))} />
            <span>SOL</span>
          </div>
          <input type="range" min={0} max={1000} step={5} value={Math.min(volume, 1000)} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Daily trading volume in the coin" />
          <p className="muted small">
            {volumes.length
              ? `${volumes.length} coins traded in the last 24 hours; ${busier} of them did ${fmt(volume)} SOL or more. The median did ${fmt(median)} SOL.`
              : "Most coins trade far less than the busiest few."}
          </p>
        </div>
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
        The on-chain rates, as in the diagram above.{" "}
        {mode === "classic" && phase === "curve"
          ? "An Old school creator earns nothing until the coin graduates."
          : phase === "pool" && mode === "rewards"
            ? "After graduation, part of the creator's share is paid by higher.fun, off-chain."
            : "The creator claims it whenever they like."}{" "}
        Arithmetic at a volume you choose, not a forecast.
      </p>
    </div>
  );
}
