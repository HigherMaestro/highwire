import type { LobbyCard } from "../../lib/link/watch.ts";

// Link battles as a list of cards (the lobby, a fighter's page): both names, how far it's got or how it ended, the kind.
// Names are coin names, shown as text.

const vs = (c: LobbyCard) => `${c.sides[0]!.name} v ${c.sides[1]!.kind === "house" ? "the house" : c.sides[1]!.name}`;
const kind = (c: LobbyCard) => (c.house ? "v the house" : c.rated ? "rated" : "unrated");

export function LinkCard({ c }: { c: LobbyCard }) {
  return (
    <li className="link-card">
      <a href={`/link/match/${c.match}`} className="link-card-a">
        <span className="link-card-names">{vs(c)}</span>
        <span className="link-card-facts muted small">
          {c.live ? (
            <>
              <span className="arena-dot-live" aria-hidden="true" /> Live · turn {c.turn + 1}
            </>
          ) : (
            <>
              {c.turn} turns · {c.ended?.reason === "void" ? "no result" : c.ended?.winner === null ? "a draw" : `${c.sides[c.ended?.winner ?? 0]!.name} won`}
            </>
          )}{" "}
          · {kind(c)}
        </span>
        {c.live ? <span className="link-card-watch">Watch</span> : null}
      </a>
    </li>
  );
}

export function LinkCards({ cards }: { cards: LobbyCard[] }) {
  return <ul className="link-cards">{cards.map((c) => <LinkCard key={c.match} c={c} />)}</ul>;
}
