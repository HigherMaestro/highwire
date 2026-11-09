//! The program's accounts: one `Config`, and one `SeriesAccount` per wager, which also holds both stakes (lamports above
//! its rent). Layouts are Borsh. The series account starts with a fixed-size header, so the emergency refund can read
//! who staked what even if a later version changes what follows it.

use crate::rules::Rules;
use crate::series::{Series, SERIES_MAX_LEN};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

pub const CONFIG_SEED: &[u8] = b"config";
pub const SERIES_SEED: &[u8] = b"series";

/// Hard limits no config can exceed (docs/wager-mode.md 6.2, 6.4).
pub const FEE_BPS_HARD_MAX: u16 = 500;
pub const STAKE_HARD_MAX: u64 = 10_000_000_000; // 10 SOL a side
pub const TIERS: usize = 4;

/// A series with no change for this long can be refunded by anyone (docs/wager-mode.md 7.7).
pub const EMERGENCY_AFTER_SECONDS: i64 = 24 * 60 * 60;

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Config {
    pub version: u8,
    /// Pauses new series, sets tiers and the fee within the hard caps, rotates the ticket key, and freezes-and-refunds.
    pub authority: Pubkey,
    /// The matchmaker's Ed25519 key, and its id (recorded in every series it pairs).
    pub ticket_key: Pubkey,
    pub ticket_key_id: u16,
    pub paused: bool,
    pub fee_bps: u16,
    pub fee_account: Pubkey,
    /// Stake tiers in lamports a side; 0 is an unused slot.
    pub tiers: [u64; TIERS],
    pub max_stake: u64,
    /// The most lamports all open series may hold together, and how much they hold now.
    pub open_stake_cap: u64,
    pub open_stake: u64,
    pub reveal_seconds: u32,
    pub rules: Rules,
}

impl Config {
    pub const LEN: usize = 1 + 32 + 32 + 2 + 1 + 2 + 32 + 8 * TIERS + 8 + 8 + 8 + 4 + (1 + 1 + 1 + 1 + 1 + 4 + 4);
}

pub const STATUS_OPEN: u8 = 1; // A has staked; waiting for B
pub const STATUS_LIVE: u8 = 2; // both staked; playing

/// The fixed-size part of a series account.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct SeriesHeader {
    pub version: u8,
    pub status: u8,
    pub series_id: [u8; 32],
    pub player_a: Pubkey,
    pub player_b: Pubkey,
    /// Lamports each side stakes.
    pub stake: u64,
    /// The fee, snapshotted when the series opened (docs/wager-mode.md 6.4).
    pub fee_bps: u16,
    pub fee_account: Pubkey,
    pub ticket_key_id: u16,
    pub accept_deadline: i64,
    pub ticket_expiry: i64,
    /// The last time anything changed: the emergency refund's clock.
    pub last_change: i64,
    pub fallback_hash_a: [u8; 32],
}

impl SeriesHeader {
    pub const LEN: usize = 1 + 1 + 32 + 32 + 32 + 8 + 2 + 32 + 2 + 8 + 8 + 8 + 32;
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct SeriesAccount {
    pub header: SeriesHeader,
    /// None until B accepts.
    pub series: Option<Series>,
}

impl SeriesAccount {
    /// Allocated at the most it can ever need; read with `deserialize`, which ignores the unused tail.
    pub const LEN: usize = SeriesHeader::LEN + 1 + SERIES_MAX_LEN;
}
