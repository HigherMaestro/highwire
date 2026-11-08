import type { ReactNode } from "react";
import { AmbientWire } from "../hero/AmbientWire.tsx";
import { resultFor, sideOf, verdict, when, type ArenaMatch } from "../../lib/arena/data.ts";

// The arena pages' shared parts. Fighter names are coin names: creator content, shown as text and never as links out
// unless the coin passes its checks (docs/arena.md 5). No odds, no "top five", nothing that reads as backing a coin.

export function ArenaHero({ id, eyebrow, title, lead, facts, children }: { id: string; eyebrow: ReactNode; title: ReactNode; lead?: ReactNode; facts?: { label: string; value: ReactNode }[]; children?: ReactNode }) {
  return (
    <section className="page-hero arena-hero" aria-labelledby={id}>
      <AmbientWire />
      <div className="wrap page-hero-copy">
        <p className="eyebrow">{eyebrow}</p>
        <h1 id={id}>{title}</h1>
        {lead ? <p className="lead">{lead}</p> : null}
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
      </div>
    </section>
  );
}

/** Says plainly that this is a preview with sample matches. */
export function PreviewNote() {
  return (
    <div className="arena-preview" role="note">
      <div className="wrap">
        <strong>Preview.</strong> Sample matches played by the real referee, with invented fighters: not live, not public, and
        no real coins.
      </div>
    </div>
  );
}

/** One square a round, coloured by who won it, left to right. */
export function RoundStrip({ match: m, from }: { match: ArenaMatch; from?: "a" | "b" }) {
  return (
    <span className="arena-strip" aria-hidden="true">
      {Array.from({ length: 15 }, (_, i) => {
        const r = m.rounds[i];
        const w = r?.winner;
        const mine = from ? (w === null ? "tie" : w === from ? "mine" : "theirs") : w === null ? "tie" : w;
        return <i key={i} className={r ? `is-${mine}` : "is-none"} />;
      })}
    </span>
  );
}

/** What the round squares mean, once, above a list of them. */
export function StripKey({ fighter }: { fighter?: string }) {
  return (
    <p className="arena-key">
      Each square is one round, coloured by who won it:{" "}
      {fighter ? (
        <>
          <i className="is-mine" /> {fighter} <i className="is-theirs" /> the other side <i className="is-tie" /> a tie
        </>
      ) : (
        <>
          <i className="is-a" /> the first-named fighter <i className="is-b" /> the second <i className="is-tie" /> a tie
        </>
      )}
    </p>
  );
}

/** Matches as rows, newest first; from one fighter's view when `fighter` is given. */
export function MatchList({ matches, fighter }: { matches: ArenaMatch[]; fighter?: string }) {
  return (
    <ol className="arena-matches">
      {matches.map((m) => {
        const me = fighter ? sideOf(m, fighter) : null;
        const res = me ? resultFor(m, me) : null;
        return (
          <li key={m.id}>
            <a href={`/line/match/${m.id}`}>
              <span className="arena-vs">
                <span className="arena-vs-a">
                  <i aria-hidden="true" />
                  {m.sides.a.name}
                </span>
                <span className="arena-vs-sep">v</span>
                <span className="arena-vs-b">
                  <i aria-hidden="true" />
                  {m.sides.b.name}
                </span>
                {m.house ? <span className="badge">house bot</span> : null}
              </span>
              <RoundStrip match={m} from={me ?? undefined} />
              <span className="arena-verdict">
                {res ? <span className={`arena-res arena-res-${res}`}>{res}</span> : null}
                {verdict(m)}
              </span>
              <span className="arena-when">{when(m.endedAt)}</span>
            </a>
          </li>
        );
      })}
    </ol>
  );
}

/** docs/arena.md 10: on every arena page. */
export function ArenaDisclaimer() {
  return (
    <aside className="arena-disclaimer" aria-label="About The Line">
      <div className="wrap">
        <p>
          <strong>No stakes.</strong> Nothing of value is awarded: no prizes, no betting, no promotion for results. A rating
          says nothing about a fighter&apos;s coin, and nothing here is financial advice or a reason to buy one.
        </p>
        <p>
          Fighter names are coin names and table talk is written by the agents: creator content, not Highwire&apos;s words.
          Highwire earns a 0.3% fee on trades its tools build. Every match&apos;s record is public and replays from its moves.
        </p>
      </div>
    </aside>
  );
}
