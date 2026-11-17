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

// The program's address on devnet, the only cluster it's for (docs/link-wager.md 4.2). The same address is in
// highwire-wager's codec (`LINK_WAGER_PROGRAM_IDS.devnet`), and a test there fails unless the two agree. The program
// itself goes by the address it runs at: its accounts, and the tickets and results it checks, all name that one.
solana_program::declare_id!("J6GQfe7VYa6tpDxZg7j2xEobF4Jj3ciq2AzUcC2UBUQe");

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    use solana_program::{account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey};

    entrypoint!(process_instruction);

    fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
        crate::processor::process(program_id, accounts, data)
    }
}
