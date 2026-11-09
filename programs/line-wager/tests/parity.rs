//! Parity with the TypeScript twin (packages/core/src/arena/series.ts): replays every event of the fixtures that
//! `npm run wager-fixtures -w highwire-core` writes, and checks that each is accepted or refused exactly as in
//! TypeScript and leaves exactly the same state. Run through `npm run test:program`, which writes the fixtures first.

use line_wager::rules::{Fallback, DUELS_1};
use line_wager::series::{Reveal, Series, PHASE_COMMIT};
use serde_json::Value;

fn hex32(v: &Value) -> [u8; 32] {
    let s = v.as_str().expect("hex");
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex byte");
    }
    out
}

fn opt_u8(v: &Value) -> Option<u8> {
    v.as_u64().map(|x| x as u8)
}

fn check(s: &Series, after: &Value, ctx: &str) {
    let n = |k: &str| after[k].as_i64().unwrap_or_else(|| panic!("{ctx}: {k}"));
    assert_eq!(s.match_index as i64, n("match"), "{ctx}: match");
    assert_eq!(s.phase as i64, n("phase"), "{ctx}: phase");
    assert_eq!(s.phase_opened_at, n("phaseOpenedAt"), "{ctx}: phaseOpenedAt");
    assert_eq!(s.game.node as i64, n("node"), "{ctx}: node");
    assert_eq!(s.game.rounds as i64, n("rounds"), "{ctx}: rounds");
    for i in 0..2 {
        assert_eq!(s.game.energy[i] as u64, after["energy"][i].as_u64().unwrap(), "{ctx}: energy[{i}]");
        assert_eq!(s.bank[i] as u64, after["bank"][i].as_u64().unwrap(), "{ctx}: bank[{i}]");
        assert_eq!(s.bank_out[i], after["bankOut"][i].as_bool().unwrap(), "{ctx}: bankOut[{i}]");
        assert_eq!(s.round[i].pull, opt_u8(&after["pulls"][i]), "{ctx}: pulls[{i}]");
        assert_eq!(s.round[i].owes_fallback, after["owes"][i].as_bool().unwrap(), "{ctx}: owes[{i}]");
    }
    let results: Vec<(Option<u8>, u8)> = s.results.iter().flatten().map(|r| (r.winner, r.reason)).collect();
    let want: Vec<(Option<u8>, u8)> = after["results"].as_array().unwrap().iter().map(|r| (opt_u8(&r[0]), r[1].as_u64().unwrap() as u8)).collect();
    assert_eq!(results, want, "{ctx}: results");
    let ending = s.ending.map(|e| (e.winner, e.reason));
    let want_ending = if after["ending"].is_null() { None } else { Some((opt_u8(&after["ending"][0]), after["ending"][1].as_u64().unwrap() as u8)) };
    assert_eq!(ending, want_ending, "{ctx}: ending");
}

#[test]
fn every_fixture_event_matches_the_typescript() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/series.json");
    let text = std::fs::read_to_string(path).expect("no fixtures: run `npm run test:program` (it writes them first)");
    let data: Value = serde_json::from_str(&text).expect("fixtures are JSON");
    let reveal_seconds = data["revealSeconds"].as_u64().unwrap() as u32;
    let mut events = 0usize;
    for (i, series) in data["series"].as_array().unwrap().iter().enumerate() {
        let id = hex32(&series["seriesId"]);
        let fb = [hex32(&series["fallbackHash"][0]), hex32(&series["fallbackHash"][1])];
        let mut s = Series::start(DUELS_1, reveal_seconds, id, fb, series["start"].as_i64().unwrap());
        assert_eq!(s.phase, PHASE_COMMIT);
        for (j, ev) in series["events"].as_array().unwrap().iter().enumerate() {
            let ctx = format!("series {i} event {j} ({})", ev["kind"]);
            let at = ev["at"].as_i64().unwrap_or(0);
            let player = ev["player"].as_u64().map(|p| p as u8).unwrap_or(0);
            let result = match ev["kind"].as_str().unwrap() {
                "commit" => s.commit(player, ev["round"].as_u64().unwrap() as u8, hex32(&ev["hash"]), at),
                "reveal" => s.reveal(player, Reveal::Pull { pull: ev["pull"].as_u64().unwrap() as u8, nonce: hex32(&ev["nonce"]) }, at),
                "revealFallback" => {
                    let f = Fallback { kind: ev["fallback"]["kind"].as_u64().unwrap() as u8, pull: ev["fallback"]["pull"].as_u64().unwrap() as u8 };
                    s.reveal(player, Reveal::Fallback { fallback: f, salt: hex32(&ev["salt"]) }, at)
                }
                "timeout" => s.timeout(at),
                "retire" => s.retire(player),
                k => panic!("{ctx}: unknown kind {k}"),
            };
            assert_eq!(result.is_ok(), ev["ok"].as_bool().unwrap(), "{ctx}: accepted? rust {result:?}");
            check(&s, &ev["after"], &ctx);
            events += 1;
        }
    }
    assert!(events > 10_000, "only {events} events: regenerate the fixtures");
    println!("{events} events replayed identically");
}
