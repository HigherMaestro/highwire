import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { arena } from "highwire-core";

// The secrets behind a wager's commitments (docs/wager-mode.md 7.2.5, 7.3): each move's nonce and each fallback's salt.
// Written, and flushed to disk, before the commitment they open is sent, so the reveal daemon can reveal after any crash:
// a lost nonce forfeits the match. The file never leaves this machine and is readable only by its owner.

type Player = "A" | "B";
type Side = "a" | "b";
export type WagerFallback = { kind: "zero" | "steady" | "mirror"; pull: number };

export interface WagerMoveSecret {
  type: "move";
  series: string;
  match: number;
  round: number;
  side: Side;
  pull: number;
  nonce: string;
  hash: string;
  time: string;
}

export interface WagerFallbackSecret {
  type: "fallback";
  series: string;
  player: Player;
  fallback: WagerFallback;
  salt: string;
  hash: string;
  time: string;
}

type Secret = WagerMoveSecret | WagerFallbackSecret;

const toArena = (f: WagerFallback): arena.Fallback => (f.kind === "steady" ? { kind: "steady", pull: f.pull } : { kind: f.kind });

export class WagerSecrets {
  constructor(readonly path: string) {}

  private append(entry: Secret) {
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(this.path, 0o600);
  }

  private all(): Secret[] {
    if (!existsSync(this.path)) return [];
    const out: Secret[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Secret);
      } catch {
        /* a torn last line from a crash: skip it */
      }
    }
    return out;
  }

  /** A fresh salt for this player's fallback in this series, saved; returns the commitment to send at open or accept. */
  newFallback(series: string, player: Player, fallback: WagerFallback): WagerFallbackSecret {
    const salt = randomBytes(32).toString("hex");
    const hash = arena.fallbackCommitment(series, player, toArena(fallback), salt);
    const entry: WagerFallbackSecret = { type: "fallback", series, player, fallback, salt, hash, time: new Date().toISOString() };
    this.append(entry);
    return entry;
  }

  /** A fresh nonce for this move, saved; returns the commitment to send. */
  newMove(series: string, match: number, round: number, side: Side, pull: number): WagerMoveSecret {
    const nonce = randomBytes(32).toString("hex");
    const hash = arena.moveCommitment(series, match, round, side, pull, nonce);
    const entry: WagerMoveSecret = { type: "move", series, match, round, side, pull, nonce, hash, time: new Date().toISOString() };
    this.append(entry);
    return entry;
  }

  /** The move behind a commitment on-chain, checked against it. */
  move(series: string, hash: string): WagerMoveSecret | undefined {
    return this.all().find(
      (e): e is WagerMoveSecret => e.type === "move" && e.series === series && e.hash === hash && arena.moveCommitment(e.series, e.match, e.round, e.side, e.pull, e.nonce) === hash,
    );
  }

  /** This player's fallback behind the commitment on-chain, checked against it. */
  fallback(series: string, player: Player, hash: string): WagerFallbackSecret | undefined {
    return this.all().find(
      (e): e is WagerFallbackSecret => e.type === "fallback" && e.series === series && e.player === player && e.hash === hash && arena.fallbackCommitment(series, player, toArena(e.fallback), e.salt) === hash,
    );
  }
}
