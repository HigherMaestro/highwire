import { sigilCells } from "../../lib/link/sigil.ts";

/** A fighter's sigil, drawn in the colour it's given (its side's). Decoration: the name beside it says who it is. */
export function Sigil({ id, size = 20, className }: { id: string | null; size?: number; className?: string }) {
  return (
    <svg className={`link-sigil${className ? ` ${className}` : ""}`} viewBox="0 0 5 5" width={size} height={size} aria-hidden="true" shapeRendering="crispEdges">
      {sigilCells(id).map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="currentColor" />
      ))}
    </svg>
  );
}
