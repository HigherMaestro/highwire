//! The program's instructions (docs/link-wager.md 3, 4), Borsh-encoded. Accounts for each are listed in order.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

use crate::state::TIERS;

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct ConfigInit {
    pub authority: Pubkey,
    pub ticket_key: Pubkey,
    pub ticket_key_id: u16,
    pub result_key: Pubkey,
    pub result_key_id: u16,
    pub tiers: [u64; TIERS],
    pub max_stake: u64,
    pub open_stake_cap: u64,
    pub refund_after_seconds: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct ConfigUpdate {
    pub authority: Option<Pubkey>,
    pub ticket_key: Option<(Pubkey, u16)>,
    pub result_key: Option<(Pubkey, u16)>,
    pub paused: Option<bool>,
    pub tiers: Option<[u64; TIERS]>,
    pub max_stake: Option<u64>,
    pub open_stake_cap: Option<u64>,
    pub refund_after_seconds: Option<u32>,
}

/// Every instruction that pays out takes the incinerator last: a payee the runtime won't credit (a wallet turned into a
/// program, say) has its share burned there rather than blocking the payout for the other player.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum LinkWagerInstruction {
    /// Once, by the program's upgrade authority. [payer & upgrade authority (s, w), config (w), program data, system program]
    InitConfig(ConfigInit),
    /// [authority (s), config (w)]
    UpdateConfig(ConfigUpdate),
    /// Player A stakes and opens the battle from the desk's ticket (an Ed25519 instruction just before this one).
    /// [player A (s, w), config (w), battle (w), instructions sysvar, system program]
    Open { battle_id: [u8; 32], player_b: Pubkey, stake: u64, accept_deadline: i64, expiry: i64, key_id: u16 },
    /// Player B stakes, with the same ticket; the battle can start. [player B (s, w), config (w), battle (w), instructions sysvar, system program]
    Accept,
    /// B never accepted: A at any time, or anyone after the deadline. Refunds A. [caller (s), config (w), battle (w), player A (w), incinerator (w)]
    Cancel,
    /// Anyone, with the referee's signed result (an Ed25519 instruction just before this one): pays the winner both
    /// stakes, or refunds both on a draw or a void. [battle (w), config (w), player A (w), player B (w), instructions sysvar, incinerator (w)]
    Settle { outcome: u8, key_id: u16 },
    /// Anyone, once both have staked and no result has come for the config's `refund_after_seconds`: refunds both in
    /// full. [battle (w), config (w), player A (w), player B (w), incinerator (w)]
    Refund,
    /// The authority only: refunds both stakes in full. [authority (s), config (w), battle (w), player A (w), player B (w), incinerator (w)]
    FreezeAndRefund,
}
