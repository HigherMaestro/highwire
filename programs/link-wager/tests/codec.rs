//! The program's byte formats against packages/wager/test/fixtures/link-codec.json, which highwire-wager's codec wrote
//! and its own tests check too: the ticket's and the result's messages, every instruction's data, and both accounts'
//! layouts, for the same fixed inputs. If the TypeScript and the Rust ever encode a thing differently, one of the two
//! test suites fails.

use borsh::BorshDeserialize;
use link_wager::instruction::{ConfigInit, ConfigUpdate, LinkWagerInstruction};
use link_wager::processor::battle_address;
use link_wager::signed::{BattleResult, Ticket};
use link_wager::state::{Battle, Config, CONFIG_SEED, STATUS_LIVE};
use serde_json::Value;
use solana_program::pubkey::Pubkey;
use std::str::FromStr;

fn fixture() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/wager/test/fixtures/link-codec.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("the fixture is in the repository")).unwrap()
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn k(n: u8) -> Pubkey {
    Pubkey::new_from_array([n; 32])
}

fn at<'a>(v: &'a Value, path: &[&str]) -> &'a str {
    path.iter().fold(v, |v, p| &v[*p]).as_str().unwrap()
}

const SOL: u64 = 1_000_000_000;

fn ticket() -> Ticket {
    Ticket { battle_id: [0xab; 32], player_a: k(1), player_b: k(2), stake: SOL / 10, accept_deadline: 1_800_000_300, expiry: 1_800_000_600, key_id: 7 }
}

fn init() -> ConfigInit {
    ConfigInit {
        authority: k(3),
        ticket_key: k(4),
        ticket_key_id: 7,
        result_key: k(5),
        result_key_id: 9,
        tiers: [SOL / 10, SOL / 4, 0, 0],
        max_stake: SOL / 4,
        open_stake_cap: 10 * SOL,
        refund_after_seconds: 21_600,
    }
}

#[test]
fn the_addresses_are_derived_the_same_way() {
    let f = fixture();
    let program = Pubkey::from_str(at(&f, &["program"])).unwrap();
    assert_eq!(program, k(0x50));
    assert_eq!(Pubkey::find_program_address(&[CONFIG_SEED], &program).0.to_string(), at(&f, &["configAddress"]));
    assert_eq!(battle_address(&program, &[0xab; 32]).0.to_string(), at(&f, &["battleAddress"]));
}

#[test]
fn the_ticket_and_the_result_are_signed_over_the_same_bytes() {
    let f = fixture();
    let program = k(0x50);
    assert_eq!(ticket().message(&program).to_vec(), hex(at(&f, &["ticket", "message"])));
    let result = BattleResult { battle_id: [0xab; 32], player_a: k(1), player_b: k(2), outcome: 1, key_id: 9 };
    assert_eq!(result.message(&program).to_vec(), hex(at(&f, &["result", "message"])));
}

#[test]
fn every_instruction_encodes_the_same() {
    let f = fixture();
    let t = ticket();
    let all = ConfigUpdate {
        authority: Some(k(6)),
        ticket_key: Some((k(4), 8)),
        result_key: Some((k(5), 10)),
        paused: Some(true),
        tiers: Some([SOL / 10, 0, 0, 0]),
        max_stake: Some(SOL / 10),
        open_stake_cap: Some(SOL),
        refund_after_seconds: Some(3_600),
    };
    let cases: Vec<(&str, LinkWagerInstruction)> = vec![
        ("initConfig", LinkWagerInstruction::InitConfig(init())),
        ("updateConfigAll", LinkWagerInstruction::UpdateConfig(all)),
        ("updateConfigNone", LinkWagerInstruction::UpdateConfig(ConfigUpdate::default())),
        ("open", LinkWagerInstruction::Open { battle_id: t.battle_id, player_b: t.player_b, stake: t.stake, accept_deadline: t.accept_deadline, expiry: t.expiry, key_id: t.key_id }),
        ("accept", LinkWagerInstruction::Accept),
        ("cancel", LinkWagerInstruction::Cancel),
        ("settle", LinkWagerInstruction::Settle { outcome: 1, key_id: 9 }),
        ("refund", LinkWagerInstruction::Refund),
        ("freezeAndRefund", LinkWagerInstruction::FreezeAndRefund),
    ];
    for (name, ix) in cases {
        let bytes = hex(at(&f, &["instructions", name]));
        assert_eq!(borsh::to_vec(&ix).unwrap(), bytes, "{name} encodes differently");
        assert_eq!(LinkWagerInstruction::try_from_slice(&bytes).unwrap(), ix, "{name} decodes differently");
    }
}

#[test]
fn both_accounts_are_laid_out_the_same() {
    let f = fixture();
    let i = init();
    let config = Config {
        version: 1,
        authority: i.authority,
        ticket_key: i.ticket_key,
        ticket_key_id: i.ticket_key_id,
        result_key: i.result_key,
        result_key_id: i.result_key_id,
        paused: true,
        tiers: i.tiers,
        max_stake: i.max_stake,
        open_stake_cap: i.open_stake_cap,
        open_stake: SOL / 5,
        refund_after_seconds: i.refund_after_seconds,
    };
    let bytes = borsh::to_vec(&config).unwrap();
    assert_eq!(bytes.len(), Config::LEN);
    assert_eq!(bytes, hex(at(&f, &["accounts", "config"])));
    let t = ticket();
    let battle = Battle {
        version: 1,
        status: STATUS_LIVE,
        battle_id: t.battle_id,
        player_a: t.player_a,
        player_b: t.player_b,
        stake: t.stake,
        ticket_key_id: t.key_id,
        accept_deadline: t.accept_deadline,
        ticket_expiry: t.expiry,
        opened_at: 1_800_000_010,
        live_at: 1_800_000_020,
        refund_at: 1_800_003_620,
    };
    let bytes = borsh::to_vec(&battle).unwrap();
    assert_eq!(bytes.len(), Battle::LEN);
    assert_eq!(bytes, hex(at(&f, &["accounts", "battle"])));
}
