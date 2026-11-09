//! The program's instructions (docs/wager-mode.md 7.2), Borsh-encoded. Accounts for each are listed in order.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

use crate::state::TIERS;

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct ConfigInit {
    pub authority: Pubkey,
    pub ticket_key: Pubkey,
    pub ticket_key_id: u16,
    pub fee_bps: u16,
    pub fee_account: Pubkey,
    pub tiers: [u64; TIERS],
    pub max_stake: u64,
    pub open_stake_cap: u64,
    pub reveal_seconds: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct ConfigUpdate {
    pub authority: Option<Pubkey>,
    pub ticket_key: Option<(Pubkey, u16)>,
    pub paused: Option<bool>,
    /// Applies to series opened afterwards only: each series keeps the fee it opened with.
    pub fee_bps: Option<u16>,
    pub fee_account: Option<Pubkey>,
    pub tiers: Option<[u64; TIERS]>,
    pub max_stake: Option<u64>,
    pub open_stake_cap: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum WagerInstruction {
    /// Once, by the program's upgrade authority. [payer & upgrade authority (s, w), config (w), program data, system program]
    InitConfig(ConfigInit),
    /// [authority (s), config (w)]
    UpdateConfig(ConfigUpdate),
    /// Player A stakes and opens the series from the matchmaker's ticket (an Ed25519 instruction just before this one).
    /// [player A (s, w), config (w), series (w), instructions sysvar, system program]
    Open { series_id: [u8; 32], player_b: Pubkey, stake: u64, accept_deadline: i64, expiry: i64, key_id: u16, fallback_hash: [u8; 32] },
    /// Player B stakes, with the same ticket; round 1 opens. [player B (s, w), config (w), series (w), instructions sysvar, system program]
    Accept { fallback_hash: [u8; 32] },
    /// B never accepted: A at any time, or anyone after the deadline. Refunds A. [caller (s), config (w), series (w), player A (w)]
    Cancel,
    /// [player (s), series (w)]
    Commit { round: u8, hash: [u8; 32] },
    /// [player (s), series (w)]
    Reveal { pull: u8, nonce: [u8; 32] },
    /// [player (s), series (w)]
    RevealFallback { kind: u8, pull: u8, salt: [u8; 32] },
    /// Anyone, after a deadline. [series (w)]
    Timeout,
    /// Anyone, once the series is over: pays the winner and the fee, or refunds a draw. [series (w), config (w), player A (w), player B (w), fee account (w)]
    Settle,
    /// [player (s), series (w)]
    Retire,
    /// Anyone, after 24 hours without a change: refunds both stakes in full. [series (w), config (w), player A (w), player B (w)]
    EmergencyRefund,
    /// The authority only: refunds both stakes in full (sanctions, a court order). [authority (s), config (w), series (w), player A (w), player B (w)]
    FreezeAndRefund,
}
