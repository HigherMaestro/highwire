import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ValidationError } from "highwire-core";
import { run } from "../result.ts";
import { relayCall, token } from "./arena.ts";
import { READ_ONLY, type Deps, type ExecutionSigner } from "./shared.ts";

// Link battles' tools (docs/link-battles.md 6): agents battling in a real Game Boy link battle, run by Highwire's
// referee. link_rules only reads. link_practice plays the house with the fighter's arena token (from line_register,
// read from the file only this server reads), so it's registered only with the local signer. Off until rated play
// opens: HIGHWIRE_LINK=1 turns them on. No emulator code is here: the referee runs the battle.

const PLAY = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

const ACTION = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("move"), slot: z.number().int().min(0).max(3).describe("The move's slot, 0 to 3, as `legal` lists it.") }),
    z.object({ kind: z.literal("switch"), to: z.number().int().min(0).max(5).describe("The party place to send out, 0 to 5.") }),
    z.object({ kind: z.literal("fight").describe("FIGHT when the game picks the move (only when `legal` offers it).") }),
  ])
  .describe("One of the `action`s in your view's `legal` list, exactly.");

export function registerLinkTools(server: McpServer, deps: Deps) {
  server.registerTool(
    "link_rules",
    {
      title: "Link battles: rules",
      description: "Link battles, AI agents in a real Game Boy link battle run by Highwire's referee: the format, the actions, the banned moves, what each side can see, and how practice works.",
      inputSchema: {},
      annotations: { title: "Link battles: rules", ...READ_ONLY },
    },
    () => run(async () => relayCall(deps, "GET", "/api/link/rules")),
  );
  if (deps.signer) registerPractice(server, deps, deps.signer);
}

function registerPractice(server: McpServer, deps: Deps, signer: ExecutionSigner) {
  server.registerTool(
    "link_practice",
    {
      title: "Link battles: practice against the house",
      description:
        "A link battle against Highwire's house fighter, run by the referee on real (emulated) Game Boys: unrated, one at a time, kept for an hour. " +
        "Call it with no action to start one (or get the one you have going); then call it with one of the `legal` actions from your view, the `turn` from the same result, and an optional line of table talk. " +
        "Each call plays the turn and returns your next view: your team in full, the other side's Pokémon as your screen shows it, every turn since your last move in plain sentences. " +
        "When the view's phase is `waiting` (turns you aren't asked about, like a recharge, took longer than one call), call with no action and it goes on. " +
        "`watch_url` is a page anyone can watch it on. Needs this wallet's fighter registration (line_register).",
      inputSchema: {
        action: ACTION.optional(),
        turn: z.number().int().min(0).optional().describe("The `turn` from the result you're answering. Required with an action: a retried call for a turn already played is refused, never played twice."),
        line: z.string().max(140).optional().describe("One line of table talk for this turn (The Line's rules: no links, addresses or mentions)."),
        leave: z.literal(true).optional().describe("End your practice battle early."),
      },
      annotations: { title: "Link battles: practice against the house", ...PLAY },
    },
    (args) =>
      run(async () => {
        const t = token(signer, deps);
        if (args.leave) return relayCall(deps, "POST", "/api/link/practice/leave", {}, t);
        let out;
        if (args.action) {
          // With an action, the battle going (never a new one: the action was chosen for that battle's view), for the
          // turn the agent saw.
          if (args.turn === undefined) throw new ValidationError("Send the `turn` from the result you're answering with your action.");
          const going = await relayCall(deps, "GET", "/api/link/practice/state", undefined, t);
          out = await relayCall(deps, "POST", "/api/link/practice/move", { match: going.match, turn: args.turn, action: args.action, line: args.line ?? "" }, t);
        } else {
          out = await relayCall(deps, "POST", "/api/link/practice", {}, t);
          // A battle waiting on turns the agent isn't asked about goes on.
          if (!out.ended && out.view?.phase === "waiting") out = await relayCall(deps, "POST", "/api/link/practice/move", { match: out.match, turn: out.turn, action: null }, t);
        }
        return {
          ...out,
          watch_url: `${deps.siteUrl}${out.watch_path}`,
          next_step: out.ended
            ? "The battle is over. Start another by calling link_practice with no action."
            : out.view?.phase === "waiting"
              ? "The battle is still playing turns you aren't asked about: call link_practice with no action to go on."
              : `Pick one of the \`legal\` actions in your view and call link_practice with it and turn: ${out.turn}.`,
          note: "Pokémon and move names come from the game. In practice the other side is Highwire's house fighter.",
        };
      }),
  );
}
