//! Parity with the TypeScript twin (packages/core/src/arena/series.ts): replays every event of the fixtures that
//! `npm run wager-fixtures -w highwire-core` writes (one series a line), and checks that each is accepted, or refused
//! with the same kind of error, exactly as in TypeScript, and leaves exactly the same state. Run through
//! `npm run test:program`, which writes the fixtures first.

use line_wager::rules::{Fallback, DUELS_1};
use line_wager::series::{Reveal, Series, SeriesError, PHASE_COMMIT, SERIES_MAX_LEN};
use serde_json::Value;
use std::io::{BufRead, BufReader};

fn hex32(v: &Value) -> [u8; 32] {
    let s = v.as_str().expect("hex");
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex byte");
    }
    out
}

fn to_hex(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn opt_u8(v: &Value) -> Option<u8> {
    v.as_u64().map(|x| x as u8)
}

fn kind(e: &SeriesError) -> &'static str {
    match e {
        SeriesError::Over => "Over",
        SeriesError::WrongPhase => "WrongPhase",
        SeriesError::WrongRound => "WrongRound",
        SeriesError::AlreadyCommitted => "AlreadyCommitted",
        SeriesError::TooLate => "TooLate",
        SeriesError::NothingDue => "NothingDue",
        SeriesError::StillOpen => "StillOpen",
        SeriesError::AlreadyRevealed => "AlreadyRevealed",
        SeriesError::OwesFallback => "OwesFallback",
        SeriesError::NoFallbackOwed => "NoFallbackOwed",
        SeriesError::WrongFallback => "WrongFallback",
        SeriesError::BadReveal => "BadReveal",
        SeriesError::IllegalPull => "IllegalPull",
        SeriesError::BadPlayer => "BadPlayer",
        SeriesError::ClockBackward => "ClockBackward",
        SeriesError::Internal => "Internal",
    }
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
        assert_eq!(s.game.spent[i] as u64, after["spent"][i].as_u64().unwrap(), "{ctx}: spent[{i}]");
        assert_eq!(s.game.last_pull[i] as u64, after["lastPull"][i].as_u64().unwrap(), "{ctx}: lastPull[{i}]");
        assert_eq!(s.bank[i] as u64, after["bank"][i].as_u64().unwrap(), "{ctx}: bank[{i}]");
        assert_eq!(s.bank_out[i], after["bankOut"][i].as_bool().unwrap(), "{ctx}: bankOut[{i}]");
        assert_eq!(s.round[i].pull, opt_u8(&after["pulls"][i]), "{ctx}: pulls[{i}]");
        assert_eq!(s.round[i].owes_fallback, after["owes"][i].as_bool().unwrap(), "{ctx}: owes[{i}]");
        assert_eq!(s.round[i].hash.map(|h| to_hex(&h)), after["hashes"][i].as_str().map(String::from), "{ctx}: hashes[{i}]");
        assert_eq!(s.fallback[i].is_some(), after["fallbackKnown"][i].as_bool().unwrap(), "{ctx}: fallbackKnown[{i}]");
    }
    let results: Vec<(Option<u8>, u8)> = s.results.iter().flatten().map(|r| (r.winner, r.reason)).collect();
    let want: Vec<(Option<u8>, u8)> = after["results"].as_array().unwrap().iter().map(|r| (opt_u8(&r[0]), r[1].as_u64().unwrap() as u8)).collect();
    assert_eq!(results, want, "{ctx}: results");
    let ending = s.ending.map(|e| (e.winner, e.reason));
    let want_ending = if after["ending"].is_null() { None } else { Some((opt_u8(&after["ending"][0]), after["ending"][1].as_u64().unwrap() as u8)) };
    assert_eq!(ending, want_ending, "{ctx}: ending");
    // The account is allocated at SERIES_MAX_LEN: no state may ever need more.
    assert!(borsh::to_vec(s).unwrap().len() <= SERIES_MAX_LEN, "{ctx}: over SERIES_MAX_LEN");
}

#[test]
fn every_fixture_event_matches_the_typescript() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/series.ndjson");
    let file = std::fs::File::open(path).expect("no fixtures: run `npm run test:program` (it writes them first)");
    let mut lines = BufReader::new(file).lines();
    let header: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
    let reveal_seconds = header["revealSeconds"].as_u64().unwrap() as u32;
    let (mut events, mut count) = (0usize, 0usize);
    for (i, line) in lines.enumerate() {
        let series: Value = serde_json::from_str(&line.unwrap()).expect("a series is JSON");
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
            match (&result, ev["ok"].as_bool().unwrap()) {
                (Ok(()), true) => {}
                (Err(e), false) => assert_eq!(kind(e), ev["error"].as_str().unwrap(), "{ctx}: error kind"),
                _ => panic!("{ctx}: rust {result:?}, typescript ok={} error={}", ev["ok"], ev["error"]),
            }
            check(&s, &ev["after"], &ctx);
            events += 1;
        }
        count += 1;
    }
    assert!(count >= 2000 && events > 100_000, "only {count} series, {events} events: regenerate the fixtures");
    println!("{count} series, {events} events replayed identically");
}

#[test]
fn a_bad_player_is_an_error_never_a_panic() {
    let mut s = Series::start(DUELS_1, 120, [1; 32], [[2; 32], [3; 32]], 100);
    assert_eq!(s.commit(2, 1, [0; 32], 101), Err(SeriesError::BadPlayer));
    assert_eq!(s.reveal(7, Reveal::Pull { pull: 1, nonce: [0; 32] }, 101), Err(SeriesError::BadPlayer));
    assert_eq!(s.retire(9), Err(SeriesError::BadPlayer));
    assert!(s.ending.is_none());
}

#[test]
fn the_clock_never_goes_backward() {
    let mut s = Series::start(DUELS_1, 120, [1; 32], [[2; 32], [3; 32]], 100);
    assert_eq!(s.commit(0, 1, [0; 32], 99), Err(SeriesError::ClockBackward));
    assert_eq!(s.timeout(50), Err(SeriesError::ClockBackward));
}

/// The same vectors as packages/core/test/series.test.ts: both hashes, byte for byte, in both languages.
#[test]
fn known_answer_hashes() {
    use line_wager::rules::{FALLBACK_MIRROR, FALLBACK_STEADY};
    use line_wager::series::{fallback_commitment, move_commitment, PLAYER_A, PLAYER_B};
    let (id, n, salt) = ([0x11; 32], [0x22; 32], [0x33; 32]);
    assert_eq!(to_hex(&move_commitment(&id, 2, 7, 1, 13, &n)), "3ae827910d2eb6b35de306cbb9ecf454e510377ce33bbbe5eb06f087925d9d82");
    assert_eq!(to_hex(&fallback_commitment(&id, PLAYER_B, &Fallback { kind: FALLBACK_STEADY, pull: 9 }, &salt)), "cade30188add781fbf53fd6b29380ca9b0d865cb7aedd2365c67278ec46b8da0");
    assert_eq!(to_hex(&fallback_commitment(&id, PLAYER_A, &Fallback { kind: FALLBACK_MIRROR, pull: 0 }, &salt)), "3d1d8e85f8cf343b2b1e6fb25d0d9d463b78f824c91aee691e797668fac4be8a");
}
