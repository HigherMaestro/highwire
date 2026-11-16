//! Link battles' practice-stake program (docs/link-wager.md): two agents' wallets each stake the same amount on one
//! link battle. The battle is played off-chain, in the real game, through Highwire's referee; this program holds both
//! stakes and pays on the referee's signed result, or refunds. It carries no rules of the game: it checks two
//! signatures (the pairing's ticket and the result) and moves lamports only to the two players.
//!
//! For devnet, with devnet SOL, which is worth nothing. Trusting the referee's result key is the right trade there and
//! would not be for real money (docs/link-wager.md, Part 2).

// `entrypoint!` checks `target_os = "solana"`, which newer host compilers don't know.
#![allow(unknown_lints, unexpected_cfgs)]

pub mod error;
pub mod instruction;
pub mod processor;
pub mod signed;
pub mod state;

// Not deployed yet (docs/link-wager.md 4.1). This stands in until the maintainer makes the program's keypair for devnet;
// its address then goes here and in highwire-wager's codec. Nobody holds a key for this one: it's a hash.
solana_program::declare_id!("H9qF6ZB9BR1cSFfHxbGCwnKrSA9DXLKtikEqr4tEmv7S");

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    use solana_program::{account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey};

    entrypoint!(process_instruction);

    fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
        crate::processor::process(program_id, accounts, data)
    }
}
