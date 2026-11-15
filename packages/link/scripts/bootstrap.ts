import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADDR, Battle, checkGame, gameData, LEVEL, LINK_STATE, party, Rig, type Side, snapshot, stat, TEAM, writeTeam } from "highwire-link";

// Makes the format's bootstrap (docs/link-battles.md 7.4): from a paired state of both games in the Colosseum between
// battles, writes the format's team into both parties (format.ts), has both players press A at the table, and lets the
// game itself exchange the parties over the cable, send out the leads and open the first menu. Saves both games there,
// and checks every Pokémon on both sides is the format's, at full HP, as both games see it. The output is the game's
// state, so it never goes in a repository: upload it to the private Blob store under link/<format>/side0.state, side1.state.
//   HIGHWIRE_LINK_ROM=<the game> npm run bootstrap -w highwire-link -- <side 0 state> <side 1 state> <out dir>

const romPath = process.env.HIGHWIRE_LINK_ROM!;
const [p0, p1, out] = process.argv.slice(2);
if (!romPath || !p0 || !p1 || !out) {
  console.error("HIGHWIRE_LINK_ROM=<the game> npm run bootstrap -w highwire-link -- <side 0 state> <side 1 state> <out dir>");
  process.exit(2);
}
const rom = new Uint8Array(readFileSync(romPath));
checkGame(rom);
const data = gameData(rom);
const rig = await Rig.create(rom);
rig.loadState(0, new Uint8Array(readFileSync(p0)));
rig.loadState(1, new Uint8Array(readFileSync(p1)));
const sides = [0, 1] as Side[];
for (const side of sides) {
  const r = (a: number) => rig.read(side, a);
  console.log(`side ${side}: link state ${r(ADDR.linkState)}, map ${r(ADDR.curMap)}, facing ${r(ADDR.playerFacing)}, in battle ${r(ADDR.isInBattle)}`);
  if (r(ADDR.linkState) !== LINK_STATE.IN_CABLE_CLUB || r(ADDR.isInBattle) !== 0) throw new Error("Both games must be in the Cable Club, out of battle.");
}
for (const side of sides) writeTeam(rig, side, data);
rig.run(2);
// Both players press A at the table: the game sets LINK_STATE_START_BATTLE and starts the exchange itself.
for (const side of sides) rig.press(side, "A");
const started = rig.runUntil(() => sides.every((s) => rig.read(s, ADDR.isInBattle) !== 0 && rig.read(s, ADDR.linkState) === LINK_STATE.BATTLING), 3000);
if (started === null) throw new Error(`The battle didn't start: link states ${sides.map((s) => rig.read(s, ADDR.linkState))}, in battle ${sides.map((s) => rig.read(s, ADDR.isInBattle))}.`);
console.log(`the battle started after ${started} frames`);
const battle = new Battle(rig);
if (battle.runToDecision()) throw new Error("It ended before its first decision.");
console.log(`first decision at frame ${rig.frameCount}: phases ${battle.phase(0)}, ${battle.phase(1)}`);

// Check: both parties are the format's, full HP, and each game's enemy party is the other's.
for (const side of sides) {
  const mine = party(rig, side);
  if (mine.length !== TEAM.length) throw new Error(`side ${side} has ${mine.length} Pokémon`);
  mine.forEach((m, i) => {
    const t = TEAM[i]!;
    const base = data.baseStats!(t.species)!;
    const ok = m.species === t.species && m.level === LEVEL && m.hp === m.maxHp && m.maxHp === stat(base.hp, LEVEL, true) && m.moves.join() === t.moves.join() && m.status === 0;
    if (!ok) throw new Error(`side ${side}'s ${t.name} isn't the format's: ${JSON.stringify(m)}`);
  });
  const s = snapshot(rig, side);
  const enemyCount = rig.read(side, ADDR.enemyPartyCount);
  if (enemyCount !== TEAM.length || s.theirs.species !== TEAM[0]!.species || s.theirs.hp !== s.theirs.maxHp) throw new Error(`side ${side}'s view of the other team is wrong`);
  console.log(`side ${side}: ${mine.map((m) => `${data.species(m.species)} L${m.level} ${m.hp}/${m.maxHp} [${m.moves.map((id) => data.move(id)?.name).join(", ")}]`).join(" · ")}`);
}
mkdirSync(out, { recursive: true });
for (const side of sides) writeFileSync(join(out, `side${side}.state`), rig.saveState(side));
console.log(`saved ${out}/side0.state and side1.state`);
