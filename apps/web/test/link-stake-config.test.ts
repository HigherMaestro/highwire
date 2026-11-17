import { test } from "node:test";
import assert from "node:assert/strict";
import { linkStakeConfig, settingOrOff } from "../lib/line/stake-config.ts";

// The switch for link battles' practice-stake desk (docs/link-wager.md 4.2): what each combination of settings does.
// The rule under test: a setting that's missing or wrong turns the desk off, and nothing else with it.

const PROGRAM = "11111111111111111111111111111112";
const TICKET = "07".repeat(32);
const RESULT = "09".repeat(32);
const on = (over: Record<string, string | undefined> = {}, programId: string | null = PROGRAM, rated = true) =>
  linkStakeConfig({ LINK_STAKE_TICKET_KEY: TICKET, LINK_STAKE_RESULT_KEY: RESULT, LINK_STAKE_RPC_URL: "https://devnet.example.com", ...over }, programId, rated);

/** Runs `f` with console.error captured: what was logged. */
function logged(f: () => void): string {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    f();
  } finally {
    console.error = real;
  }
  return lines.join("\n");
}

test("the desk is on only with a listed program, rated link battles and both keys", () => {
  const c = on()!;
  assert.deepEqual([c.programId, c.ticketKeyId, c.resultKeyId, c.tiers, c.minQueue, c.perPairPerWeek], [PROGRAM, 1, 1, [100_000_000n, 250_000_000n], 2, 2]);
  assert.equal(on({}, null), undefined, "no program listed for devnet");
  assert.equal(on({}, PROGRAM, false), undefined, "rated link battles are off");
  // Neither key set: off, and nothing to say (it simply isn't switched on).
  assert.equal(logged(() => assert.equal(on({ LINK_STAKE_TICKET_KEY: undefined, LINK_STAKE_RESULT_KEY: undefined }), undefined)), "");
  // One key, or a key that isn't one: off, with a line that says which kind of mistake and never the value.
  const half = logged(() => assert.equal(on({ LINK_STAKE_RESULT_KEY: undefined }), undefined));
  assert.match(half, /one of the two keys isn't set/);
  const bad = logged(() => assert.equal(on({ LINK_STAKE_TICKET_KEY: "not-hex-at-all" }), undefined));
  assert.match(bad, /isn't 64 hex characters/);
  assert.ok(!bad.includes("not-hex-at-all") && !half.includes(TICKET));
  // A key pasted with its trailing newline, or spaces around a value, is the key.
  assert.ok(on({ LINK_STAKE_TICKET_KEY: `${TICKET}\n`, LINK_STAKE_RESULT_KEY: `  ${RESULT}  ` }));
  assert.deepEqual(on({ LINK_STAKE_TIERS: " 0.01 , 0.1 ", LINK_STAKE_MIN_QUEUE: "4", LINK_STAKE_PER_PAIR_WEEK: "50", LINK_STAKE_TICKET_KEY_ID: "3", LINK_STAKE_RESULT_KEY_ID: "4" })!.tiers, [10_000_000n, 100_000_000n]);
});

test("a setting that can't be read turns the desk off, and only the desk", () => {
  // Each of these throws while it's read: caught, the desk is off, and the caller carries on with everything else.
  for (const over of [{ LINK_STAKE_TIERS: "0.1,0.25 SOL" }, { LINK_STAKE_TIERS: "0.1;0.25" }, { LINK_STAKE_TIERS: "-0.1" }, { LINK_STAKE_RPC_URL: "devnet.example.com/abc" }, { LINK_STAKE_RPC_URL: '"https://devnet.example.com"' }]) {
    assert.throws(() => on(over));
    let said = "";
    said = logged(() => assert.equal(settingOrOff("link battles' stakes", () => on(over)), undefined));
    assert.match(said, /link battles' stakes are off/);
    // Nothing of the setting's own text in the log: one of them could as easily be a secret.
    for (const v of Object.values(over)) assert.ok(!said.includes(v), said);
    assert.ok(!said.includes(TICKET) && !said.includes(RESULT));
  }
  // What reads fine passes straight through.
  assert.equal(settingOrOff("anything", () => 7), 7);
  assert.equal(settingOrOff("anything", () => undefined), undefined);
});
