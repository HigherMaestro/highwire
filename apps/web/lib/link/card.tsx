import type { Pip } from "./story.ts";
import { monogram } from "./story.ts";

// A link battle's link preview (docs/link-battles.md 13.4), drawn by next/og: on ink, both fighters' names in their
// sides' colours either side of the wire, each team as pips, and how far it's got. Never the result: a finished
// battle's card shows its pips neutral and asks you to watch from the start; a turn's card shows that turn's moment and
// HP bars, nothing after. X lays the domain over the bottom-left, so nothing important sits below y 520 there.

const INK = "#0E1116";
const PAPER = "#F6F4EE";
const MUTED = "#A7ACB4";
const A = "#F6A9C4";
const B = "#93E2FB";
const GOLD = "#F7C84C";
const RED = "#FF6B6B";

export function linkCard(o: { label: string; names: [string, string]; pips: [Pip[], Pip[]] | null; bars: [number, number] | null; status: string; live: boolean }) {
  const size = (n: string) => (n.length > 16 ? 46 : n.length > 11 ? 56 : 68);
  const pipRow = (pips: Pip[] | null, color: string, align: "flex-start" | "flex-end") => (
    <div style={{ display: "flex", gap: 10, justifyContent: align, marginTop: 22 }}>
      {(pips ?? Array.from({ length: 3 }, () => null)).map((p, i) => (
        <div
          key={i}
          style={{
            width: 54,
            height: 54,
            borderRadius: 14,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "Mono",
            fontSize: 20,
            color: p?.fainted ? MUTED : PAPER,
            border: `2px ${p?.species ? "solid" : "dashed"} ${p?.species ? color : "#3A3F47"}`,
            opacity: p?.fainted ? 0.4 : 1,
            background: "#1A1D23",
          }}
        >
          {p ? monogram(p.species) : "?"}
        </div>
      ))}
    </div>
  );
  const bar = (pct: number, align: "flex-start" | "flex-end") => (
    <div style={{ display: "flex", justifyContent: align, marginTop: 18 }}>
      <div style={{ width: 340, height: 16, borderRadius: 8, background: "#2A2F37", display: "flex", justifyContent: align }}>
        <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: 16, borderRadius: 8, background: pct > 50 ? "#8BE0B5" : pct > 20 ? GOLD : RED }} />
      </div>
    </div>
  );
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", position: "relative", background: INK, padding: "64px 72px" }}>
      <svg width="1200" height="630" viewBox="0 0 1200 630" style={{ position: "absolute", left: 0, top: 0 }}>
        <defs>
          <linearGradient id="wire" x1="0" x2="1">
            <stop offset="0" stopColor={GOLD} />
            <stop offset=".35" stopColor={A} />
            <stop offset=".7" stopColor={B} />
            <stop offset="1" stopColor="#A6EFCB" />
          </linearGradient>
        </defs>
        <path d="M0 330 C 300 330 420 360 600 360 C 780 360 900 330 1200 330" fill="none" stroke="url(#wire)" strokeWidth="6" />
        <circle cx="600" cy="360" r="14" fill="#FFFFFF" />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontFamily: "Grotesk", fontWeight: 700, fontSize: 40, color: PAPER, letterSpacing: -1.6 }}>highwire</div>
        <div
          style={{
            fontFamily: "Mono",
            fontSize: 20,
            letterSpacing: 2,
            color: o.live ? RED : MUTED,
            border: `2px solid ${o.live ? RED : "#3A3F47"}`,
            borderRadius: 999,
            padding: "6px 16px",
          }}
        >
          {o.status}
        </div>
      </div>
      <div style={{ fontFamily: "Mono", fontSize: 20, letterSpacing: 2, color: MUTED, marginTop: 18 }}>{o.label}</div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 34 }}>
        <div style={{ display: "flex", flexDirection: "column", width: 500 }}>
          <div style={{ fontFamily: "Grotesk", fontWeight: 700, fontSize: size(o.names[0]), color: A, letterSpacing: -2, lineHeight: 1.02 }}>{o.names[0]}</div>
          {o.bars ? bar(o.bars[0], "flex-start") : null}
        </div>
        <div style={{ display: "flex", flexDirection: "column", width: 500, alignItems: "flex-end" }}>
          <div style={{ fontFamily: "Grotesk", fontWeight: 700, fontSize: size(o.names[1]), color: B, letterSpacing: -2, lineHeight: 1.02, textAlign: "right" }}>{o.names[1]}</div>
          {o.bars ? bar(o.bars[1], "flex-end") : null}
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "auto" }}>
        {pipRow(o.pips?.[0] ?? null, A, "flex-start")}
        {pipRow(o.pips?.[1] ?? null, B, "flex-end")}
      </div>
    </div>
  );
}
