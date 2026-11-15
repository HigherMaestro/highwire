import type { LobbyCard } from "../../lib/link/watch.ts";
import { monogram, scoreOf, teamsAt } from "../../lib/link/story.ts";

// Link battles as a list of cards (the lobby, a fighter's page): both names in their sides' colours, each team as pips,
// the score in Pokémon left, how far it's got or how it ended, and when. Names are coin names, shown as text; the house
// is known by its flag, never its name.

const ago = (at: number) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

export function LinkCard({ c }: { c: LobbyCard }) {
  // The agent first against the house, whichever side it played; otherwise side 0 first, as on the battle's page.
  const l = c.sides[0]!.kind === "house" ? 1 : 0, r = (1 - l) as 0 | 1;
  const name = (s: 0 | 1) => (c.sides[s]!.kind === "house" ? "the house" : c.sides[s]!.name);
  const teams = c.spectator ? teamsAt(c.spectator, null) : null;
  const score = teams ? scoreOf(teams) : null;
  const kind = c.house ? "v the house" : c.rated ? "rated" : "unrated";
  const ended = c.ended;
  const result = ended ? (ended.reason === "void" ? "no result" : ended.winner === null ? "a draw" : `${ended.winner === l ? name(l) : name(r)} won`) : null;
  return (
    <li className="link-card">
      <a href={`/link/match/${c.match}`} className="link-card-a" aria-label={`${name(l)} v ${name(r)}, ${c.live ? `live, turn ${c.turn + 1}` : `${c.turn} turns, ${result}`}`}>
        <span className="link-card-names">
          <span className="link-card-l">{name(l)}</span>
          <span className="link-card-x">v</span>
          <span className="link-card-r">{name(r)}</span>
        </span>
        <span className="link-card-facts">
          {c.live ? (
            <>
              <span className="arena-dot-live" aria-hidden="true" /> Live · turn {c.turn + 1}
            </>
          ) : (
            <>
              {c.turn} turns · {result}
            </>
          )}
          <span>· {kind}</span>
          <span>· {ago(c.started_at)}</span>
        </span>
        <span className="link-card-score" aria-hidden="true">
          {score ? (
            <b>
              {score[l]} – {score[r]}
            </b>
          ) : null}
          {teams ? (
            <span className="link-card-pips">
              {[...teams[l], ...teams[r]].map((p, i) => (
                <span key={i} className={`link-pip link-pip-mini${p.species ? "" : " link-pip-unseen"}${p.fainted ? " link-pip-fainted" : ""}${i < teams[l].length ? " link-pip-l" : " link-pip-r"}`}>
                  {monogram(p.species)}
                </span>
              ))}
            </span>
          ) : null}
          {c.live ? <span className="link-card-watch">Watch</span> : null}
        </span>
      </a>
    </li>
  );
}

export function LinkCards({ cards }: { cards: LobbyCard[] }) {
  return <ul className="link-cards">{cards.map((c) => <LinkCard key={c.match} c={c} />)}</ul>;
}
