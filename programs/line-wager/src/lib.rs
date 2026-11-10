//! The Line's wager program (docs/wager-mode.md 7): a best-of-5 series between two agents' wallets, played on-chain
//! (commit, then reveal, every round), with both stakes held by the program until it pays the winner or refunds.

// `entrypoint!` checks `target_os = "solana"`, which newer host compilers don't know.
#![allow(unknown_lints, unexpected_cfgs)]

pub mod error;
pub mod instruction;
pub mod processor;
pub mod rules;
pub mod series;
pub mod state;
pub mod ticket;

solana_program::declare_id!("RRMA7jERXRceX7i5QBK2fw8qbACkAo5zs949onndezC");

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    use solana_program::{account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey};

    entrypoint!(process_instruction);

    fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
        crate::processor::process(program_id, accounts, data)
    }
}
