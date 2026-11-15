import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { type Action, checkGame, decodeFilm, DICE_LENGTH, type FilmJob, filmTurn, FilmPlayer, LinkMatch } from "highwire-link";

// Films a whole battle, the house on both sides, as the referee would after each answer (docs/link-battles.md 13.3):
// each turn played, then played again with the screens on and checked against the first, encoded, and decoded again to
// check the film. Prints each film's size and time. With an out dir it writes the films there (never into the
// repository: they're the game's own screens). Needs the game:
//   HIGHWIRE_LINK_ROM=<the game> npm run film -w highwire-link -- <side 0 state> <side 1 state> [out dir]
// TRAINERS="HOUSE,LGTM" names the two sides in the games (trainers.ts), as a practice does.

const romPath = process.env.HIGHWIRE_LINK_ROM;
const [p0, p1, out] = process.argv.slice(2);
if (!romPath || !p0 || !p1) {
  console.error("HIGHWIRE_LINK_ROM=<the game> npm run film -w highwire-link -- <side 0 state> <side 1 state> [out dir]");
  process.exit(2);
}
const rom = new Uint8Array(readFileSync(romPath));
checkGame(rom);
const boot: [Uint8Array, Uint8Array] = [new Uint8Array(readFileSync(p0)), new Uint8Array(readFileSync(p1))];
if (out) mkdirSync(out, { recursive: true });

const trainers = process.env.TRAINERS ? (process.env.TRAINERS.split(",").slice(0, 2) as [string, string]) : undefined;
const started = await LinkMatch.start(rom, boot, trainers);
let match = started.match;
let packed: Uint8Array | null = started.packed;
const jobs: FilmJob[] = [{ turn: 0, before: null, decisions: [null, null], dice: [], events: "", ...(trainers ? { trainers } : {}) }];
let state = match.state;
let total = 0, bytes = 0, ms = 0, frames = 0, bad = 0;

async function film(job: FilmJob) {
  const t0 = performance.now();
  const f = await filmTurn(rom, boot, job);
  const took = performance.now() - t0;
  if (!f) {
    bad++;
    console.log(`turn ${job.turn}: the replay came out differently; no film`);
    return;
  }
  const d = await decodeFilm(f);
  const player = new FilmPlayer(d);
  while (player.next());
  if (player.frame !== d.frames - 1) throw new Error(`turn ${job.turn}: decoded ${player.frame + 1} of ${d.frames} frames`);
  total++, bytes += f.length, ms += took, frames += d.frames;
  console.log(`turn ${job.turn}: ${d.frames} frames, ${d.palette.length} colours, ${(f.length / 1024).toFixed(1)} KB, ${took.toFixed(0)} ms`);
  if (out) writeFileSync(join(out, `${job.turn}.film`), f);
}

await film(jobs[0]!);
while (packed) {
  const decisions: [Action | null, Action | null] = [match.asked(0) ? match.house(0) : null, match.asked(1) ? match.house(1) : null];
  const dice = new Uint8Array(randomBytes(DICE_LENGTH));
  const r = match.play(decisions, dice);
  if (r.turn) await film({ turn: r.turn.turn, before: packed, decisions, dice: [...dice], events: JSON.stringify(r.turn.events) });
  state = r.state;
  packed = r.packed;
  if (packed) match = await LinkMatch.open(rom, state, packed);
}
console.log(`\n${total} films (${bad} refused), ${frames} frames, ${(bytes / 1024).toFixed(0)} KB, ${(ms / 1000).toFixed(1)} s; ${JSON.stringify(state.outcome ?? state.void)}`);
