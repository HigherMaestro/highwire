//! The two messages the program takes on a signature (docs/link-wager.md 3): the desk's **ticket** (it paired these two
//! wallets at this stake) and the referee's **result** (this battle ended this way). Each is carried as an Ed25519
//! program instruction placed immediately before the instruction that needs it, in the same transaction, and verified
//! by instruction introspection: the program id, the signature count, every offset and every instruction index (the
//! class of bug behind Wormhole), the key and the exact message.
//!
//! Both messages name the program they're for, so one signed for another deployment is refused by this one, and each
//! starts with its own domain, so a ticket can never stand in for a result, nor The Line's tickets for these.

use solana_program::{account_info::AccountInfo, ed25519_program, program_error::ProgramError, pubkey::Pubkey, sysvar::instructions};

use crate::error::WagerError;

pub const TICKET_DOMAIN: &[u8; 22] = b"highwire-link-ticket-1";
pub const RESULT_DOMAIN: &[u8; 22] = b"highwire-link-result-1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ticket {
    pub battle_id: [u8; 32],
    pub player_a: Pubkey,
    pub player_b: Pubkey,
    pub stake: u64,
    pub accept_deadline: i64,
    pub expiry: i64,
    pub key_id: u16,
}

impl Ticket {
    pub const MESSAGE_LEN: usize = 22 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 2;

    pub fn message(&self, program_id: &Pubkey) -> [u8; Self::MESSAGE_LEN] {
        let mut m = [0u8; Self::MESSAGE_LEN];
        let mut o = 0;
        let mut put = |b: &[u8]| {
            m[o..o + b.len()].copy_from_slice(b);
            o += b.len();
        };
        put(TICKET_DOMAIN);
        put(program_id.as_ref());
        put(&self.battle_id);
        put(self.player_a.as_ref());
        put(self.player_b.as_ref());
        put(&self.stake.to_le_bytes());
        put(&self.accept_deadline.to_le_bytes());
        put(&self.expiry.to_le_bytes());
        put(&self.key_id.to_le_bytes());
        m
    }
}

/// How a battle ended, as the referee signs it: the battle, its two wallets (so a result can't be moved to a battle
/// with the same id between other players), the outcome and the key's id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BattleResult {
    pub battle_id: [u8; 32],
    pub player_a: Pubkey,
    pub player_b: Pubkey,
    pub outcome: u8,
    pub key_id: u16,
}

impl BattleResult {
    pub const MESSAGE_LEN: usize = 22 + 32 + 32 + 32 + 32 + 1 + 2;

    pub fn message(&self, program_id: &Pubkey) -> [u8; Self::MESSAGE_LEN] {
        let mut m = [0u8; Self::MESSAGE_LEN];
        let mut o = 0;
        let mut put = |b: &[u8]| {
            m[o..o + b.len()].copy_from_slice(b);
            o += b.len();
        };
        put(RESULT_DOMAIN);
        put(program_id.as_ref());
        put(&self.battle_id);
        put(self.player_a.as_ref());
        put(self.player_b.as_ref());
        put(&[self.outcome]);
        put(&self.key_id.to_le_bytes());
        m
    }
}

const SIG_LEN: usize = 64;
const KEY_LEN: usize = 32;
const OFFSETS_START: usize = 2;
const OFFSETS_LEN: usize = 14;
const THIS_INSTRUCTION: u16 = u16::MAX;

fn u16_at(d: &[u8], i: usize, bad: WagerError) -> Result<u16, ProgramError> {
    d.get(i..i + 2).map(|b| u16::from_le_bytes([b[0], b[1]])).ok_or_else(|| bad.into())
}

/// Checks that the instruction just before this one is an Ed25519 check, by `key`, of exactly `message`. `bad` is the
/// error for anything else (a ticket's or a result's).
pub fn verify(instructions_sysvar: &AccountInfo, key: &Pubkey, message: &[u8], bad: WagerError) -> Result<(), ProgramError> {
    if *instructions_sysvar.key != instructions::ID {
        return Err(bad.into());
    }
    let current = instructions::load_current_index_checked(instructions_sysvar)?;
    if current == 0 {
        return Err(bad.into());
    }
    let ix = instructions::load_instruction_at_checked((current - 1) as usize, instructions_sysvar)?;
    if ix.program_id != ed25519_program::ID {
        return Err(bad.into());
    }
    let d = &ix.data;
    // Exactly one signature, every offset pointing into this same instruction.
    if d.first() != Some(&1) {
        return Err(bad.into());
    }
    let o = OFFSETS_START;
    let sig_off = u16_at(d, o, bad)? as usize;
    let sig_ix = u16_at(d, o + 2, bad)?;
    let key_off = u16_at(d, o + 4, bad)? as usize;
    let key_ix = u16_at(d, o + 6, bad)?;
    let msg_off = u16_at(d, o + 8, bad)? as usize;
    let msg_len = u16_at(d, o + 10, bad)? as usize;
    let msg_ix = u16_at(d, o + 12, bad)?;
    if sig_ix != THIS_INSTRUCTION || key_ix != THIS_INSTRUCTION || msg_ix != THIS_INSTRUCTION {
        return Err(bad.into());
    }
    if sig_off < OFFSETS_START + OFFSETS_LEN || d.get(sig_off..sig_off + SIG_LEN).is_none() {
        return Err(bad.into());
    }
    let signer = d.get(key_off..key_off + KEY_LEN).ok_or(bad)?;
    if signer != key.as_ref() {
        return Err(bad.into());
    }
    let msg = d.get(msg_off..msg_off + msg_len).ok_or(bad)?;
    if msg != message {
        return Err(bad.into());
    }
    Ok(())
}
