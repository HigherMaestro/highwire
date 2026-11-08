import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { ReactElement } from "react";
import type { Idea, Module } from "./ideas.ts";
import type { Card } from "./site.ts";

// The ideas' link previews, in the family of brand/svg/og-fees.svg: on ink, a name on the left, and on the right the
// wire's node splitting into strands. Each idea's card shows what the agent does, /ideas's the ideas. Built from idea.json,
// so a new idea gets its card without a trip through brand/scripts/build.py. X lays the domain over the bottom-left,
// so nothing sits below y 520 there.

export const CARD_SIZE = { width: 1200, height: 630 };
export const IDEA_CARD_ALT = "A Highwire launch idea: its name, what the agent does, how hard it is and what it takes to start.";

const INK = "#0E1116";
const PAPER = "#F6F4EE";
const MUTED = "#A7ACB4";
const SIGNAL = "#93E2FB";
const STRANDS = ["#F6A9C4", "#F7C84C", "#93E2FB", "#A6EFCB"];

const font = (file: string) => readFile(join(/* turbopackIgnore: true */ process.cwd(), "assets/fonts", file));
let fonts: Promise<[Buffer, Buffer, Buffer]> | undefined;

/** "about 0.3 SOL, the budget you give it" → "0.3 SOL": the card has room for the number, the page for the rest. */
export function shortSol(solToStart: string): string {
  return solToStart.split(",")[0]!.replace(/^about\s+/i, "").trim();
}

/** The line under the name: SOL to start and minutes to a first dry run. The difficulty rides on the label. */
export function cardFacts(idea: Idea): string {
  return `${shortSol(idea.solToStart)} to start · dry run in ~${idea.minutesToDryRun} min`;
}

export const IDEAS_CARD_ALT = "Highwire's launch ideas: agents you can deploy to your GitHub in one click, each with a full spec.";

/** The cards as pages name them in pageMetadata: app/ideas/opengraph-image.tsx and app/ideas/[slug]/opengraph-image.tsx. */
export const IDEAS_CARD: Card = { url: "/ideas/opengraph-image", alt: IDEAS_CARD_ALT };
export const ideaCardFor = (slug: string): Card => ({ url: `/ideas/${slug}/opengraph-image`, alt: IDEA_CARD_ALT });

export const MODULE_CARD_ALT = "A Highwire module: its name, what it adds to an agent, and the command that adds it.";
/** A module page's card: app/modules/[slug]/opengraph-image.tsx. */
export const moduleCardFor = (slug: string): Card => ({ url: `/modules/${slug}/opengraph-image`, alt: MODULE_CARD_ALT });

/** One card: up to five strands, under an optional heading; `srcX` moves the wire left when their labels are long. */
function wireCard(o: { label: string; title: string; facts: string; strands: string[]; heading?: string; srcX?: number; labelSize?: number }) {
  const strands = o.strands.slice(0, 5);
  const srcX = o.srcX ?? 790, srcY = 330, endX = srcX + 122, gap = strands.length > 4 ? 88 : 100, labelSize = o.labelSize ?? 34;
  const ys = strands.map((_, i) => srcY + (i - (strands.length - 1) / 2) * gap);
  const titleSize = o.title.length > 10 ? 72 : 84;
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: INK }}>
      <svg width="1200" height="630" viewBox="0 0 1200 630" style={{ position: "absolute", left: 0, top: 0 }}>
        <defs>
          <radialGradient id="glow">
            <stop offset="0" stopColor="#F7C84C" stopOpacity=".75" />
            <stop offset=".45" stopColor="#F6A9C4" stopOpacity=".35" />
            <stop offset="1" stopColor={SIGNAL} stopOpacity="0" />
          </radialGradient>
        </defs>
        <line x1={srcX} y1="120" x2={srcX} y2="540" stroke={PAPER} strokeWidth="26" strokeLinecap="round" />
        {ys.map((y, i) => (
          <g key={i}>
            <path
              d={`M${srcX} ${srcY} C${srcX + 70} ${srcY} ${endX - 70} ${y} ${endX} ${y}`}
              fill="none"
              stroke={STRANDS[i % STRANDS.length]}
              strokeWidth="8"
              strokeLinecap="round"
            />
            <circle cx={endX} cy={y} r="11" fill={STRANDS[i % STRANDS.length]} />
          </g>
        ))}
        <circle cx={srcX} cy={srcY} r="78" fill="url(#glow)" />
        <circle cx={srcX} cy={srcY} r="19" fill="#FFFFFF" stroke={INK} strokeWidth="5" />
      </svg>
      {o.heading && (
        <div style={{ position: "absolute", left: endX - 11, top: ys[0]! - 84, fontFamily: "Mono", fontSize: 18, color: SIGNAL, letterSpacing: 1.6 }}>{o.heading}</div>
      )}
      {strands.map((s, i) => (
        <div
          key={s}
          style={{ position: "absolute", left: endX + 34, top: ys[i]! - labelSize * 0.7, fontFamily: "Grotesk", fontWeight: 500, fontSize: labelSize, color: PAPER, letterSpacing: -0.3 }}
        >
          {s}
        </div>
      ))}
      <div style={{ position: "absolute", left: 80, top: 78, width: srcX - 170, height: 440, display: "flex", flexDirection: "column" }}>
        <div style={{ fontFamily: "Grotesk", fontWeight: 700, fontSize: 56, color: PAPER, letterSpacing: -2.8, lineHeight: 1 }}>highwire</div>
        <div style={{ marginTop: 40, fontFamily: "Mono", fontSize: 22, color: SIGNAL, letterSpacing: 1.8 }}>{o.label}</div>
        <div style={{ marginTop: 22, fontFamily: "Grotesk", fontWeight: 700, fontSize: titleSize, color: PAPER, letterSpacing: -titleSize * 0.02, lineHeight: 1.05 }}>
          {o.title}
        </div>
        <div style={{ marginTop: "auto", fontFamily: "Mono", fontSize: 22, color: MUTED }}>{o.facts}</div>
      </div>
    </div>
  );
}

async function render(card: ReactElement): Promise<ImageResponse> {
  fonts ??= Promise.all([font("SpaceGrotesk-Bold.ttf"), font("SpaceGrotesk-Medium.ttf"), font("JetBrainsMono-Medium.ttf")]);
  const [bold, medium, mono] = await fonts;
  return new ImageResponse(card, {
    ...CARD_SIZE,
    fonts: [
      { name: "Grotesk", data: bold, weight: 700, style: "normal" },
      { name: "Grotesk", data: medium, weight: 500, style: "normal" },
      { name: "Mono", data: mono, weight: 500, style: "normal" },
    ],
  });
}

/** An idea page's card: its name and difficulty, what the agent does (its loop), and the facts line. */
export function ideaCard(idea: Idea): Promise<ImageResponse> {
  return render(
    wireCard({
      label: `LAUNCH IDEA · ${idea.difficulty.toUpperCase()}`,
      title: idea.title,
      facts: cardFacts(idea),
      heading: "WHAT IT DOES",
      strands: idea.loop,
      srcX: 700,
      labelSize: 32,
    }),
  );
}

/** /ideas's card: every idea on the wire. */
export function ideasCard(ideas: Idea[]): Promise<ImageResponse> {
  return render(
    wireCard({ label: "LAUNCH IDEAS", title: "Agents you can start today", facts: "Deploy to your GitHub in one click", strands: ideas.map((i) => i.title), srcX: 700, labelSize: 30 }),
  );
}

/** A module page's card: its name, what it does, and the command that adds it. */
export function moduleCard(mod: Module): Promise<ImageResponse> {
  return render(
    wireCard({ label: "MODULE", title: mod.title, facts: `highwire add ${mod.slug}`, heading: "WHAT IT DOES", strands: mod.loop, srcX: 700, labelSize: 32 }),
  );
}
