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

export function linkCard(o: { label: string; names: [string, string]; pips: [Pip[], Pip[]] | null; bars: [number, number] | null; status: string; live: boolean; node?: string; moment?: { text: string; tone: "ko" | "gold" | "plain"; sub?: string }; /** A line under the wire in place of the teams: a finished battle in numbers that name no winner. */ line?: string }) {
  const cap = o.moment ? (o.moment.sub ? 52 : 60) : 84;
  // The cable runs under the names; lower on a turn's card, under its headline, names and bars.
  const y = o.moment ? (o.moment.sub ? 452 : 430) : 330;
  const wire = `M0 ${y} C 300 ${y} 420 ${y + 30} 600 ${y + 30} C 780 ${y + 30} 900 ${y} 1200 ${y}`;
  // A name stays on one line in its half of the card: smaller the longer it is.
  const size = (n: string) => Math.min(cap, n.length > 18 ? 40 : n.length > 14 ? 48 : n.length > 11 ? 58 : n.length > 8 ? 70 : 84);
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
  const bar = (pct: number, align: "flex-start" | "flex-end", color: string) => (
    <div style={{ display: "flex", justifyContent: align, marginTop: 18 }}>
      <div style={{ width: 360, height: 24, borderRadius: 12, background: "#23272E", display: "flex", justifyContent: align }}>
        <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: 24, borderRadius: 12, background: pct <= 20 ? RED : color }} />
      </div>
    </div>
  );
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        backgroundColor: INK,
        backgroundImage: "radial-gradient(circle at 0% 55%, rgba(246,169,196,0.20), rgba(14,17,22,0) 55%), radial-gradient(circle at 100% 55%, rgba(147,226,251,0.20), rgba(14,17,22,0) 55%)",
        padding: "56px 72px",
      }}
    >
      <svg width="1200" height="630" viewBox="0 0 1200 630" style={{ position: "absolute", left: 0, top: 0 }}>
        <defs>
          <linearGradient id="wire" x1="0" x2="1">
            <stop offset="0" stopColor={GOLD} />
            <stop offset=".35" stopColor={A} />
            <stop offset=".7" stopColor={B} />
            <stop offset="1" stopColor="#A6EFCB" />
          </linearGradient>
        </defs>
        <path d={wire} fill="none" stroke="url(#wire)" strokeWidth="18" strokeOpacity="0.12" />
        <path d={wire} fill="none" stroke="url(#wire)" strokeWidth="10" strokeOpacity="0.25" />
        <path d={wire} fill="none" stroke="url(#wire)" strokeWidth="5" />
        <circle cx="600" cy={y + 30} r="30" fill={INK} stroke="#FFFFFF" strokeWidth="3" />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 18 }}>
          <div style={{ fontFamily: "Grotesk", fontWeight: 700, fontSize: 40, color: PAPER, letterSpacing: -1.6 }}>highwire</div>
          <div style={{ fontFamily: "Mono", fontSize: 18, letterSpacing: 2, color: MUTED }}>AI AGENTS · REAL GAME BOYS</div>
        </div>
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
      <div style={{ position: "absolute", left: 570, top: y, width: 60, height: 60, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Grotesk", fontWeight: 700, fontSize: o.node && o.node.length > 2 ? 18 : 24, color: PAPER }}>{o.node ?? "v"}</div>
      <div style={{ fontFamily: "Mono", fontSize: 20, letterSpacing: 2, color: MUTED, marginTop: 18 }}>{o.label}</div>
      {o.moment ? (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontFamily: "Grotesk", fontWeight: 700, fontSize: o.moment.sub ? 60 : 72, letterSpacing: -2.5, lineHeight: 1, marginTop: 10, color: o.moment.tone === "ko" ? RED : o.moment.tone === "gold" ? GOLD : PAPER }}>{o.moment.text}</div>
          {o.moment.sub ? <div style={{ fontFamily: "Grotesk", fontWeight: 500, fontSize: 28, color: PAPER, marginTop: 8 }}>{o.moment.sub}</div> : null}
        </div>
      ) : null}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: o.moment ? 18 : 30 }}>
        <div style={{ display: "flex", flexDirection: "column", width: 500 }}>
          <div style={{ fontFamily: "Grotesk", fontWeight: 700, fontSize: size(o.names[0]), color: A, letterSpacing: -2, lineHeight: 1.02 }}>{o.names[0]}</div>
          {o.bars ? bar(o.bars[0], "flex-start", A) : null}
        </div>
        <div style={{ display: "flex", flexDirection: "column", width: 500, alignItems: "flex-end" }}>
          <div style={{ fontFamily: "Grotesk", fontWeight: 700, fontSize: size(o.names[1]), color: B, letterSpacing: -2, lineHeight: 1.02, textAlign: "right" }}>{o.names[1]}</div>
          {o.bars ? bar(o.bars[1], "flex-end", B) : null}
        </div>
      </div>
      {o.line ? (
        <div style={{ display: "flex", marginTop: "auto", fontFamily: "Grotesk", fontWeight: 700, fontSize: 44, letterSpacing: -1.4, color: PAPER }}>{o.line}</div>
      ) : (
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: "auto" }}>
          {pipRow(o.pips?.[0] ?? null, A, "flex-start")}
          {pipRow(o.pips?.[1] ?? null, B, "flex-end")}
        </div>
      )}
    </div>
  );
}
