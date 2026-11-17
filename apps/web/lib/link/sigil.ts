// A fighter's sigil (docs/link-battles.md 14.12): a small mark of its own, so a fighter is recognised from one battle to
// the next whichever side and colour it gets. A 5 by 5 grid, mirrored left to right, its cells decided by the fighter's
// mint alone: the same mint always draws the same mark. Abstract, Highwire's own, and never anything from the game. The
// house has one fixed mark.

/** The house's mark: an H. */
const HOUSE = [0b10001, 0b10001, 0b11111, 0b10001, 0b10001];

/** FNV-1a over the id's characters: enough to scatter 15 cells. */
function hash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The cells that are on, as [column, row] pairs in a 5 by 5 grid. `id` is the fighter's mint, or null for the house. */
export function sigilCells(id: string | null): [number, number][] {
  const cells: [number, number][] = [];
  if (id === null) {
    HOUSE.forEach((row, y) => {
      for (let x = 0; x < 5; x++) if (row & (1 << (4 - x))) cells.push([x, y]);
    });
    return cells;
  }
  let h = hash(id);
  // Fifteen cells decide it (three columns of five), mirrored onto the other two columns. A mark with almost nothing
  // (or almost everything) on is turned over once more, so every fighter's reads as a shape.
  for (let tries = 0; tries < 4; tries++) {
    const on: [number, number][] = [];
    for (let i = 0; i < 15; i++) if (h & (1 << i)) on.push([i % 3, Math.floor(i / 3)]);
    if (on.length >= 5 && on.length <= 11) {
      for (const [x, y] of on) {
        cells.push([x, y]);
        if (x < 2) cells.push([4 - x, y]);
      }
      return cells;
    }
    h = hash(`${id}:${h}`);
  }
  return HOUSE.flatMap((row, y) => [0, 1, 2, 3, 4].filter((x) => (row >> (4 - x)) & 1 && (x + y) % 2 === 0).map((x) => [x, y] as [number, number]));
}
