//! The matchmaker's ticket (docs/wager-mode.md 7.4, 8): the referee pairs two eligible fighters and signs a short message
//! with its Ed25519 key; `open` and `accept` must carry it, as an Ed25519 program instruction placed immediately before
//! them in the same transaction. Verified by instruction introspection, checking the program id, the signature count,
//! every offset and every instruction index (the class of bug behind Wormhole), the key and the exact message.

use solana_program::{account_info::AccountInfo, ed25519_program, program_error::ProgramError, pubkey::Pubkey, sysvar::instructions};

use crate::error::WagerError;

pub const TICKET_DOMAIN: &[u8; 22] = b"highwire-line-ticket-1";

/// The ticket names the program it's for, so a ticket signed for one deployment (devnet, say) is refused by another
/// that shares the key.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ticket {
    pub series_id: [u8; 32],
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
        put(&self.series_id);
        put(self.player_a.as_ref());
        put(self.player_b.as_ref());
        put(&self.stake.to_le_bytes());
        put(&self.accept_deadline.to_le_bytes());
        put(&self.expiry.to_le_bytes());
        put(&self.key_id.to_le_bytes());
        m
    }
}

const SIG_LEN: usize = 64;
const KEY_LEN: usize = 32;
const OFFSETS_START: usize = 2;
const OFFSETS_LEN: usize = 14;
const THIS_INSTRUCTION: u16 = u16::MAX;

fn u16_at(d: &[u8], i: usize) -> Result<u16, ProgramError> {
    d.get(i..i + 2).map(|b| u16::from_le_bytes([b[0], b[1]])).ok_or_else(|| WagerError::BadTicket.into())
}

/// Checks that the instruction just before this one is an Ed25519 check, by `key`, of exactly `ticket`'s message.
pub fn verify(program_id: &Pubkey, instructions_sysvar: &AccountInfo, key: &Pubkey, ticket: &Ticket) -> Result<(), ProgramError> {
    if *instructions_sysvar.key != instructions::ID {
        return Err(WagerError::BadTicket.into());
    }
    let current = instructions::load_current_index_checked(instructions_sysvar)?;
    if current == 0 {
        return Err(WagerError::BadTicket.into());
    }
    let ix = instructions::load_instruction_at_checked((current - 1) as usize, instructions_sysvar)?;
    if ix.program_id != ed25519_program::ID {
        return Err(WagerError::BadTicket.into());
    }
    let d = &ix.data;
    // Exactly one signature, every offset pointing into this same instruction.
    if d.first() != Some(&1) {
        return Err(WagerError::BadTicket.into());
    }
    let o = OFFSETS_START;
    let sig_off = u16_at(d, o)? as usize;
    let sig_ix = u16_at(d, o + 2)?;
    let key_off = u16_at(d, o + 4)? as usize;
    let key_ix = u16_at(d, o + 6)?;
    let msg_off = u16_at(d, o + 8)? as usize;
    let msg_len = u16_at(d, o + 10)? as usize;
    let msg_ix = u16_at(d, o + 12)?;
    if sig_ix != THIS_INSTRUCTION || key_ix != THIS_INSTRUCTION || msg_ix != THIS_INSTRUCTION {
        return Err(WagerError::BadTicket.into());
    }
    if sig_off < OFFSETS_START + OFFSETS_LEN || d.get(sig_off..sig_off + SIG_LEN).is_none() {
        return Err(WagerError::BadTicket.into());
    }
    let signer = d.get(key_off..key_off + KEY_LEN).ok_or(WagerError::BadTicket)?;
    if signer != key.as_ref() {
        return Err(WagerError::BadTicket.into());
    }
    let msg = d.get(msg_off..msg_off + msg_len).ok_or(WagerError::BadTicket)?;
    if msg != ticket.message(program_id) {
        return Err(WagerError::BadTicket.into());
    }
    Ok(())
}
