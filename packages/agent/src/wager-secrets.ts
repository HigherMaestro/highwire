import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
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
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const fresh = !existsSync(this.path);
    const fd = openSync(this.path, "a+", 0o600);
    try {
      // A crash mid-write leaves a torn last line: start on a new one, or this secret would be lost with it.
      const size = fstatSync(fd).size;
      const last = Buffer.alloc(1);
      const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
      writeSync(fd, `${torn ? "\n" : ""}${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(this.path, 0o600);
    if (fresh) {
      // The file's own directory entry, so a new file survives a crash too.
      try {
        const dir = openSync(dirname(this.path), "r");
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      } catch {
        /* not every platform can sync a directory */
      }
    }
  }

  /** Every well-formed entry: anything else (a torn line, a stray value) is skipped, never thrown. */
  private all(): Secret[] {
    if (!existsSync(this.path)) return [];
    const hex = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
    const byte = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255;
    const out: Secret[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        continue;
      }
      if (!v || typeof v !== "object") continue;
      const e = v as Record<string, unknown>;
      if (!hex(e.series) || !hex(e.hash) || typeof e.time !== "string") continue;
      const fb = e.fallback as Record<string, unknown> | undefined;
      if (e.type === "move" && hex(e.nonce) && byte(e.match) && byte(e.round) && byte(e.pull) && (e.side === "a" || e.side === "b")) out.push(e as unknown as WagerMoveSecret);
      else if (e.type === "fallback" && hex(e.salt) && (e.player === "A" || e.player === "B") && fb && typeof fb === "object" && ["zero", "steady", "mirror"].includes(fb.kind as string) && byte(fb.pull)) {
        out.push(e as unknown as WagerFallbackSecret);
      }
    }
    return out;
  }

  /** The series this file holds secrets for, from entries newer than `sinceMs` ago: the daemon reads these by id too. */
  seriesIds(sinceMs = 14 * 24 * 60 * 60 * 1000): string[] {
    const since = Date.now() - sinceMs;
    return [...new Set(this.all().filter((e) => Date.parse(e.time) >= since).map((e) => e.series))];
  }

  /** A fresh salt for this player's fallback in this series, saved; returns the commitment to send at open or accept. */
  newFallback(series: string, player: Player, fallback: WagerFallback): WagerFallbackSecret {
    const salt = randomBytes(32).toString("hex");
    const hash = arena.fallbackCommitment(series, player, toArena(fallback), salt);
    const entry: WagerFallbackSecret = { type: "fallback", series, player, fallback, salt, hash, time: new Date().toISOString() };
    this.append(entry);
    if (!this.fallback(series, player, hash)) throw new Error(`the fallback's salt didn't read back from ${this.path}, so nothing was sent`);
    return entry;
  }

  /** A fresh nonce for this move, saved; returns the commitment to send. */
  newMove(series: string, match: number, round: number, side: Side, pull: number): WagerMoveSecret {
    const nonce = randomBytes(32).toString("hex");
    const hash = arena.moveCommitment(series, match, round, side, pull, nonce);
    const entry: WagerMoveSecret = { type: "move", series, match, round, side, pull, nonce, hash, time: new Date().toISOString() };
    this.append(entry);
    if (!this.move(series, hash)) throw new Error(`the move's nonce didn't read back from ${this.path}, so nothing was sent`);
    return entry;
  }

  /** Which player this wallet was in a series, from the fallback it committed there; null when the file doesn't say. */
  player(series: string): Player | null {
    const f = this.all().find((e): e is WagerFallbackSecret => e.type === "fallback" && e.series === series);
    return f ? f.player : null;
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
