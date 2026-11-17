//! The program's accounts: one `Config`, and one `Battle` per staked battle, which also holds both stakes (lamports
//! above its rent). Layouts are Borsh, fixed-size.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

pub const CONFIG_SEED: &[u8] = b"config";
pub const BATTLE_SEED: &[u8] = b"battle";

/// Hard limits no config can exceed.
pub const STAKE_HARD_MAX: u64 = 10_000_000_000; // 10 SOL a side
/// Every tier is at least this (0.01 SOL), so every payout to a player is above the rent-exempt minimum of an empty
/// wallet, and a player who empties their wallet can't make a payout fail.
pub const STAKE_HARD_MIN: u64 = 10_000_000;
pub const TIERS: usize = 4;

/// How long after both have staked, with no result, anyone may refund both (docs/link-wager.md 2): never so short that a
/// battle still being played could be refunded out from under its winner, never so long that stakes sit on a referee
/// that's gone. The floor is well above the longest battle the referee allows: up to five minutes to start, two
/// eight-minute clocks, and a few seconds of emulation for each of at most 200 turns (packages/relay/src/link/arena.ts,
/// stakes.ts), with room for the referee's clocks pausing during an outage while the chain's doesn't.
pub const REFUND_AFTER_MIN: u32 = 60 * 60;
pub const REFUND_AFTER_MAX: u32 = 7 * 24 * 60 * 60;

/// The longest a ticket may still have to run when its battle opens. A battle's account never closes before its
/// ticket has expired (so a ticket opens one battle, ever), which makes this the longest a stake can be held on a
/// battle nobody joined.
pub const TICKET_LIFETIME_MAX: i64 = 15 * 60;

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Config {
    pub version: u8,
    /// Pauses new battles, sets tiers and caps within the hard limits, rotates the two keys, and freezes-and-refunds.
    pub authority: Pubkey,
    /// The desk's Ed25519 key, which signs pairings, and its id (recorded in every battle it pairs).
    pub ticket_key: Pubkey,
    pub ticket_key_id: u16,
    /// The referee's Ed25519 key, which signs results and nothing else, and its id.
    pub result_key: Pubkey,
    pub result_key_id: u16,
    pub paused: bool,
    /// Stake tiers in lamports a side; 0 is an unused slot.
    pub tiers: [u64; TIERS],
    pub max_stake: u64,
    /// The most lamports all open battles may hold together, and how much they hold now.
    pub open_stake_cap: u64,
    pub open_stake: u64,
    pub refund_after_seconds: u32,
}

impl Config {
    pub const LEN: usize = 1 + 32 + 32 + 2 + 32 + 2 + 1 + 8 * TIERS + 8 + 8 + 8 + 4;
}

pub const STATUS_OPEN: u8 = 1; // A has staked; waiting for B
pub const STATUS_LIVE: u8 = 2; // both staked; the battle is played off-chain

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Battle {
    pub version: u8,
    pub status: u8,
    pub battle_id: [u8; 32],
    pub player_a: Pubkey,
    pub player_b: Pubkey,
    /// Lamports each side stakes.
    pub stake: u64,
    pub ticket_key_id: u16,
    pub accept_deadline: i64,
    pub ticket_expiry: i64,
    /// When A staked, and when B did (0 until then).
    pub opened_at: i64,
    pub live_at: i64,
    /// From when anyone may refund both if no result has come: fixed when B stakes (0 until then), so a later change
    /// to the config's window never moves it under a battle being played.
    pub refund_at: i64,
}

impl Battle {
    pub const LEN: usize = 1 + 1 + 32 + 32 + 32 + 8 + 2 + 8 + 8 + 8 + 8 + 8;
}

/// A result's outcome, in terms of the two wallets (the referee maps the game's sides to them).
pub const OUTCOME_A: u8 = 0;
pub const OUTCOME_B: u8 = 1;
pub const OUTCOME_DRAW: u8 = 2;
pub const OUTCOME_VOID: u8 = 3;
