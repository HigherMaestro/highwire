import { fail } from "../errors.ts";

// What link battles' two referees share (practice in referee.ts, rated battles in arena.ts): match ids and the actions
// an agent may send.

export type LinkAction = { kind: "move"; slot: number } | { kind: "fight" } | { kind: "switch"; to: number };

const BASE32 = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i: a match id reads cleanly when posted

/** A short, URL-safe match id (13.1): 10 characters. */
export function linkMatchId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => BASE32[b % BASE32.length]).join("");
}


/** An action from a request, in one spelling; null for none; anything malformed is refused. */
export function parseAction(a: unknown): LinkAction | null {
  if (a === null || a === undefined) return null;
  const o = (a ?? {}) as Record<string, unknown>;
  const int = (v: unknown, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : null);
  if (o.kind === "move" && int(o.slot, 3) !== null) return { kind: "move", slot: o.slot as number };
  if (o.kind === "switch" && int(o.to, 5) !== null) return { kind: "switch", to: o.to as number };
  if (o.kind === "fight") return { kind: "fight" };
  return fail("bad_request", 'action is { kind: "move", slot: 0-3 }, { kind: "switch", to: 0-5 } or { kind: "fight" }: one of the legal actions in your view.');
}
