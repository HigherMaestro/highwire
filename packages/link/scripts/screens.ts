import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Action, ADDR, Battle, checkGame, DICE_LENGTH, type Legal, Rig, type Side, snapshot } from "highwire-link";

// Records a battle's two screens as video (docs/link-battles.md 13, phase 4's groundwork; for now, footage for a film):
// plays a battle from a paired state with the screens rendered and battle animations on, every decision a random legal
// move (a switch only when forced), and pipes each frame of both Game Boys to ffmpeg, lossless at the native 160 x 144
// (scale it up without smoothing where it's shown).
// Writes side0.mp4, side1.mp4 and moments.json (each turn's first frame, its events, and every faint, by frame). The
// footage is the game's own screen, so it never goes in a repository. Needs the game and ffmpeg:
//   HIGHWIRE_LINK_ROM=<the game> npm run screens -w highwire-link -- <side 0 state> <side 1 state> <out dir> [turns] [seed]

const romPath = process.env.HIGHWIRE_LINK_ROM;
if (!romPath || !existsSync(romPath)) {
  console.error("Set HIGHWIRE_LINK_ROM to the game's file.");
  process.exit(2);
}
const [path0, path1, out, turnsArg = "8", seedArg = "1"] = process.argv.slice(2);
if (!path0 || !path1 || !out) {
  console.error("usage: screens <side 0 state> <side 1 state> <out dir> [turns] [seed]");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const rom = new Uint8Array(readFileSync(romPath));
checkGame(rom);

const W = 160, H = 144;
function encoder(file: string): ChildProcessWithoutNullStreams {
  return spawn("ffmpeg", [
    "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", "60", "-i", "-",
    "-c:v", "libx264rgb", "-preset", "slow", "-crf", "0", "-g", "30", file,
  ]);
}

let s = Number(seedArg) >>> 0 || 1;
const pick = (n: number) => {
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  return (s >>> 0) % n;
};
const choose = (legal: Legal): Action =>
  legal.kind === "forced"
    ? { kind: "switch", to: legal.switches[pick(legal.switches.length)]! }
    : legal.fight
      ? { kind: "fight" }
      : { kind: "move", slot: legal.moves[pick(legal.moves.length)]! };

const rig = await Rig.create(rom);
rig.loadState(0, new Uint8Array(readFileSync(path0)));
rig.loadState(1, new Uint8Array(readFileSync(path1)));
// Fast text, battle animations on (wOptions bit 7 off): presentation only, the battle's dice are untouched.
for (const side of [0, 1] as const) rig.write(side, ADDR.options, 0x01);
rig.setRendering(true);

const encoders = [encoder(join(out, "side0.mp4")), encoder(join(out, "side1.mp4"))] as const;
let written = 0;
const run = rig.run.bind(rig);
// Every finished frame, both screens go to their encoders.
rig.run = (frames = 1) => {
  const stop = run(frames);
  if (!rig.midFrame) {
    for (const side of [0, 1] as const) encoders[side].stdin.write(rig.screen(side));
    written++;
  }
  return stop;
};

const moments: unknown[] = [];
const game = new Battle(rig);
let outcome = game.runToDecision();
const hp = () => [snapshot(rig, 0).mine.hp, snapshot(rig, 1).mine.hp];
for (let turn = 1; turn <= Number(turnsArg) && !outcome; turn++) {
  const start = written;
  const decisions = ([0, 1] as const).map((side: Side) => {
    const legal = game.legal(side);
    return legal ? choose(legal) : null;
  }) as [Action | null, Action | null];
  const dice = Uint8Array.from({ length: DICE_LENGTH }, () => pick(256));
  const before = hp();
  const result = game.play(decisions, dice);
  outcome = result.outcome;
  const after = hp();
  moments.push({ turn, start, end: written, decisions, events: result.record.events, hp: { before, after }, fainted: after.map((h, i) => h === 0 && before[i]! > 0) });
  console.log(`turn ${turn}: frames ${start}-${written}, ${result.record.events.filter((e) => e.kind === "resolved").map((e) => JSON.stringify(e)).join(" ")}`);
}
for (const e of encoders) e.stdin.end();
await Promise.all(encoders.map((e) => new Promise((resolve) => e.on("close", resolve))));
writeFileSync(join(out, "moments.json"), JSON.stringify({ fps: 60, width: W, height: H, frames: written, outcome, moments }, null, 2));
console.log(`${written} frames to ${out}`);
