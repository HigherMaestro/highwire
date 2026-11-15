import { type Action, Battle } from "./battle.ts";
import { FilmEncoder } from "./film.ts";
import { Rig } from "./rig.ts";
import { unpack } from "./state.ts";

// Filming (docs/link-battles.md 13.3, phase 4): a turn played again from the battle as it stood before it, with the same
// decisions and dice and both screens drawn, after the referee has answered. Drawing changes nothing the games compute,
// so the replay is the same turn; it's checked, and a film whose turn came out differently is never kept.

/** One turn to film: what the referee played, from where. `before` null is the battle's opening, from the bootstrap. */
export interface FilmJob {
  turn: number;
  before: Uint8Array | null;
  decisions: [Action | null, Action | null];
  dice: number[];
  /** The turn's events as the referee recorded them (JSON), to check the replay against. */
  events: string;
}

/**
 * Films one turn: both screens, every frame from the decision point to the next (or the end). Null when the replay
 * didn't come out as the turn did, which drawing never causes; a film that disagreed would show something that
 * didn't happen.
 */
export async function filmTurn(rom: Uint8Array, bootstrap: [Uint8Array, Uint8Array], job: FilmJob): Promise<Uint8Array | null> {
  const rig = await Rig.create(rom);
  let battle: Battle;
  if (job.before) {
    battle = unpack(rig, job.before).battle;
  } else {
    rig.loadState(0, bootstrap[0]);
    rig.loadState(1, bootstrap[1]);
    battle = new Battle(rig);
  }
  rig.setRendering(true);
  const film = new FilmEncoder(job.turn);
  const run = rig.run.bind(rig);
  // Every finished frame, both screens (a run that stops mid-frame finishes it on the next call). A frame at a time, so
  // a longer run misses none.
  rig.run = (frames = 1) => {
    let stop = null;
    for (let i = 0; i < frames && !stop; i++) {
      stop = run(1);
      if (!rig.midFrame) film.add([rig.screen(0), rig.screen(1)]);
    }
    return stop;
  };
  if (job.before) {
    const { record } = battle.play(job.decisions, Uint8Array.from(job.dice));
    if (JSON.stringify(record.events) !== job.events) return null;
  } else {
    battle.runToDecision();
  }
  return film.finish();
}
