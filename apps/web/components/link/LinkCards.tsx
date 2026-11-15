import type { LobbyCard } from "../../lib/link/watch.ts";
import { leadSeries, momentum, monogram, scoreOf, teamsAt, type Pip } from "../../lib/link/story.ts";

// Link battles as tickets (the lobby, a fighter's page): both names in their sides' colours, each with its team as pips,
// the score in Pokémon left, a small tug of war of who was ahead, how far it's got or how it ended, and when. A live one
// carries the wire along its top. Names are coin names, shown as text; the house is known by its flag, never its name.

const ago = (at: number) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

function MiniPips({ pips, tone }: { pips: Pip[]; tone: "a" | "b" }) {
  return (
    <span className={`link-pips link-pips-${tone} link-pips-mini`}>
      {pips.map((p, i) => (
        <span key={i} className={`link-pip${p.species ? "" : " link-pip-unseen"}${p.fainted ? " link-pip-fainted" : ""}${p.active ? " link-pip-active" : ""}`}>
          <span className="link-pip-m">{monogram(p.species)}</span>
        </span>
      ))}
    </span>
  );
}

/** Who was ahead, turn by turn, in 96 by 28 pixels: the left side above the line, the right below. */
function MiniTug({ lead }: { lead: { turn: number; lead: number }[] }) {
  if (lead.length < 2) return null;
  const W = 96, H = 28, mid = H / 2;
  const n = lead.at(-1)!.turn || 1;
  const span = Math.max(25, ...lead.map((p) => Math.abs(p.lead)));
  const y = (v: number) => mid - (v / span) * (mid - 2);
  let d = `M0,${mid} L0,${y(lead[0]!.lead).toFixed(1)}`;
  for (const p of lead.slice(1)) d += ` H${((p.turn / n) * W).toFixed(1)} V${y(p.lead).toFixed(1)}`;
  d += ` H${W} V${mid} Z`;
  return (
    <svg className="link-ticket-tug" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <clipPath id="tt">
        <rect width={W} height={mid} />
      </clipPath>
      <clipPath id="tb">
        <rect y={mid} width={W} height={mid} />
      </clipPath>
      <path d={d} clipPath="url(#tt)" className="link-tug-area-a" />
      <path d={d} clipPath="url(#tb)" className="link-tug-area-b" />
      <line x1="0" x2={W} y1={mid} y2={mid} className="link-tug-mid" />
    </svg>
  );
}

export function LinkCard({ c }: { c: LobbyCard }) {
  // The agent first against the house, whichever side it played; otherwise side 0 first, as on the battle's page.
  const l = c.sides[0]!.kind === "house" ? 1 : 0, r = (1 - l) as 0 | 1;
  const name = (s: 0 | 1) => (c.sides[s]!.kind === "house" ? "The house" : c.sides[s]!.name);
  const teams = c.spectator ? teamsAt(c.spectator, null) : null;
  const score = teams ? scoreOf(teams) : null;
  const kind = c.house ? "v the house" : c.rated ? "rated" : "unrated";
  const ended = c.ended;
  const result = ended ? (ended.reason === "void" ? "No result" : ended.winner === null ? "A draw" : `${ended.winner === l ? name(l) : name(r)} won`) : null;
  const lead = c.spectator ? leadSeries(momentum(c.spectator), l) : [];
  return (
    <li className={`link-ticket${c.live ? " link-ticket-live" : ""}`}>
      <a href={`/link/match/${c.match}`} className="link-ticket-a" aria-label={`${name(l)} v ${name(r)}, ${c.live ? `live, turn ${c.turn + 1}` : `${c.turn} turns, ${result}`}`}>
        <span className="link-ticket-sides">
          <span className="link-ticket-side link-ticket-l">
            <span className="link-ticket-name">{name(l)}</span>
            {teams ? <MiniPips pips={teams[l]} tone="a" /> : null}
          </span>
          <span className="link-ticket-side link-ticket-r">
            <span className="link-ticket-name">{name(r)}</span>
            {teams ? <MiniPips pips={teams[r]} tone="b" /> : null}
          </span>
        </span>
        <span className="link-ticket-score" aria-hidden="true">
          {c.live ? <span className="link-sb-pill link-sb-live">Live</span> : null}
          {score ? (
            <b>
              {score[l]}
              <span>–</span>
              {score[r]}
            </b>
          ) : null}
          <MiniTug lead={lead} />
        </span>
        <span className="link-ticket-foot">
          {c.live ? <>Turn {c.turn + 1}</> : <>{result} · {c.turn} turns</>} · {kind} · {ago(c.started_at)}
        </span>
      </a>
    </li>
  );
}

export function LinkCards({ cards }: { cards: LobbyCard[] }) {
  return <ul className="link-tickets">{cards.map((c) => <LinkCard key={c.match} c={c} />)}</ul>;
}
