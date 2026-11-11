//! Known-answer bytes shared with highwire-core (packages/core/test/fixtures/wager-codec.json): a config, a series
//! account mid-game, and every instruction Highwire builds, as the program encodes them. highwire-core's tests decode and
//! encode the same file. `LINE_WAGER_WRITE_CODEC=1 cargo test --test codec` rewrites it after a deliberate layout change.

use line_wager::instruction::{ConfigInit, WagerInstruction};
use line_wager::rules::{Fallback, DUELS_1, FALLBACK_STEADY};
use line_wager::series::{fallback_commitment, move_commitment, Reveal, Series, PLAYER_A, PLAYER_B};
use line_wager::state::{Config, SeriesAccount, SeriesHeader, STATUS_LIVE};
use serde_json::{json, Value};
use solana_program::pubkey::Pubkey;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn vectors() -> Value {
    let key = |n: u8| Pubkey::new_from_array([n; 32]);
    let id = [0x11; 32];
    let config = Config {
        version: 1,
        authority: key(1),
        ticket_key: key(2),
        ticket_key_id: 3,
        paused: false,
        fee_bps: 250,
        fee_account: key(4),
        tiers: [10_000_000, 100_000_000, 0, 0],
        max_stake: 1_000_000_000,
        open_stake_cap: 5_000_000_000,
        open_stake: 200_000_000,
        reveal_seconds: 120,
        rules: DUELS_1,
    };
    // A series mid-game: B missed round 1's commit, revealed its fallback (steady 9), A revealed: round 2 is open.
    let fb_b = Fallback { kind: FALLBACK_STEADY, pull: 9 };
    let salt = [0x33; 32];
    let mut s = Series::start(DUELS_1, 120, id, [[0x44; 32], fallback_commitment(&id, PLAYER_B, &fb_b, &salt)], 1_000);
    let nonce = [0x22; 32];
    s.commit(PLAYER_A, 0, 1, move_commitment(&id, 0, 1, 0, 4, &nonce), 1_010).unwrap();
    s.timeout(1_120).unwrap();
    s.reveal(PLAYER_B, Reveal::Fallback { fallback: fb_b, salt }, 1_130).unwrap();
    s.reveal(PLAYER_A, Reveal::Pull { pull: 4, nonce }, 1_140).unwrap();
    let account = SeriesAccount {
        header: SeriesHeader {
            version: 1,
            status: STATUS_LIVE,
            series_id: id,
            player_a: key(5),
            player_b: key(6),
            stake: 100_000_000,
            fee_bps: 250,
            fee_account: key(4),
            ticket_key_id: 3,
            accept_deadline: 1_300,
            ticket_expiry: 1_600,
            last_change: 1_140,
            fallback_hash_a: [0x44; 32],
        },
        series: Some(s),
    };
    let ix = |i: &WagerInstruction| hex(&borsh::to_vec(i).unwrap());
    json!({
        "config": hex(&borsh::to_vec(&config).unwrap()),
        "seriesAccount": hex(&borsh::to_vec(&account).unwrap()),
        "instructions": {
            "open": ix(&WagerInstruction::Open { series_id: id, player_b: key(6), stake: 100_000_000, accept_deadline: 1_300, expiry: 1_600, key_id: 3, fallback_hash: [0x44; 32] }),
            "accept": ix(&WagerInstruction::Accept { fallback_hash: [0x55; 32] }),
            "cancel": ix(&WagerInstruction::Cancel),
            "commit": ix(&WagerInstruction::Commit { match_index: 2, round: 7, hash: [0x66; 32] }),
            "reveal": ix(&WagerInstruction::Reveal { pull: 13, nonce: [0x22; 32] }),
            "revealFallback": ix(&WagerInstruction::RevealFallback { kind: FALLBACK_STEADY, pull: 9, salt: [0x33; 32] }),
            "timeout": ix(&WagerInstruction::Timeout),
            "settle": ix(&WagerInstruction::Settle),
            "retire": ix(&WagerInstruction::Retire),
            "emergencyRefund": ix(&WagerInstruction::EmergencyRefund),
            "initConfig": ix(&WagerInstruction::InitConfig(ConfigInit {
                authority: key(1),
                ticket_key: key(2),
                ticket_key_id: 3,
                fee_bps: 250,
                fee_account: key(4),
                tiers: [10_000_000, 100_000_000, 0, 0],
                max_stake: 100_000_000,
                open_stake_cap: 5_000_000_000,
                reveal_seconds: 120,
            })),
        }
    })
}

#[test]
fn the_shared_codec_file_is_what_the_program_encodes() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/core/test/fixtures/wager-codec.json");
    let want = vectors();
    if std::env::var("LINE_WAGER_WRITE_CODEC").is_ok() {
        std::fs::write(path, serde_json::to_string_pretty(&want).unwrap() + "\n").unwrap();
    }
    let have: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("the shared codec file")).unwrap();
    assert_eq!(have, want, "the program's encodings changed: update the TypeScript codec, then rewrite the file");
}
