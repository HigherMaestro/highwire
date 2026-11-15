import { get } from "@vercel/blob";
import { disagreements, DICE_LENGTH, LINK_STATE, Rig, playTestTurn, snapshot } from "highwire-link";

// Phase 0's timing on Vercel (docs/link-battles.md 14): load the game and a paired battle from the private Blob store,
// play test turns on fresh dice, and report how long each part took, cold and warm. Preview deployments only: it's a
// measurement, not a feature, and production answers 404. Nothing about the game itself is ever returned.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FILES = { game: "link/game.gbc", side0: "link/phase0/side0.state", side1: "link/phase0/side1.state" } as const;

type Files = { game: Uint8Array; states: [Uint8Array, Uint8Array]; ms: number };

// Kept for the function instance's life, as the referee will keep the game (docs/link-battles.md 8.2).
let cached: Promise<Files> | null = null;
let instanceTurns = 0;

async function read(pathname: string): Promise<Uint8Array> {
  const blob = await get(pathname, { access: "private" });
  if (!blob) throw new Error(`${pathname} isn't in the store.`);
  return new Uint8Array(await new Response(blob.stream).arrayBuffer());
}

async function load(): Promise<Files> {
  const t0 = performance.now();
  const [game, side0, side1] = await Promise.all([read(FILES.game), read(FILES.side0), read(FILES.side1)]);
  return { game, states: [side0, side1], ms: performance.now() - t0 };
}

export async function GET(request: Request) {
  if (process.env.VERCEL_ENV !== "preview" || !process.env.BLOB_READ_WRITE_TOKEN) return new Response("Not found", { status: 404 });
  const turns = Math.min(Math.max(Number(new URL(request.url).searchParams.get("turns") ?? 3) || 3, 1), 10);
  const cold = cached === null;
  cached ??= load();
  let files: Files;
  try {
    files = await cached;
  } catch (error) {
    cached = null;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
  const results = [];
  for (let i = 0; i < turns; i++) {
    const t0 = performance.now();
    const rig = await Rig.create(files.game);
    rig.loadState(0, files.states[0]);
    rig.loadState(1, files.states[1]);
    const setupMs = performance.now() - t0;
    if (snapshot(rig, 0).linkState !== LINK_STATE.BATTLING) return Response.json({ error: "The states aren't a link battle." }, { status: 500 });
    const turn = playTestTurn(rig, { dice: crypto.getRandomValues(new Uint8Array(DICE_LENGTH)) });
    const t1 = performance.now();
    const saved = [rig.saveState(0), rig.saveState(1)];
    instanceTurns++;
    results.push({
      setup_ms: Math.round(setupMs),
      turn_ms: Math.round(turn.ms),
      frames: turn.frames,
      pair_frames_per_second: Math.round((turn.frames / turn.ms) * 1000),
      save_ms: Math.round(performance.now() - t1),
      state_bytes: saved[0]!.length + saved[1]!.length,
      agree: disagreements(turn.end[0], turn.end[1]).length === 0,
      stuck: turn.stuck,
      hp: [turn.end[0].mine.hp, turn.end[0].theirs.hp],
    });
  }
  return Response.json({
    cold,
    blob_ms: cold ? Math.round(files.ms) : 0,
    instance_turns: instanceTurns,
    region: process.env.VERCEL_REGION ?? null,
    memory_mb: Math.round(process.memoryUsage().rss / 2 ** 20),
    turns: results,
  });
}
