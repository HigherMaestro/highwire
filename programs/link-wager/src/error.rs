//! The program's errors. Never renumber: a new error takes the next number.

use solana_program::program_error::ProgramError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum WagerError {
    BadInstruction = 1,
    NotConfig = 2,
    NotAuthority = 3,
    Paused = 4,
    BadTier = 5,
    OverStakeCap = 6,
    OverOpenStakeCap = 7,
    BadTicket = 8,
    TicketExpired = 9,
    WrongBattleAccount = 10,
    NotAPlayer = 11,
    WrongStatus = 12,
    AcceptDeadlinePassed = 13,
    NotYet = 14,
    WrongPayee = 15,
    AlreadyInitialised = 16,
    Math = 17,
    /// Payouts may burn only into the incinerator.
    NotIncinerator = 18,
    /// The result isn't the referee's: no Ed25519 check just before, another key, another battle, or another outcome.
    BadResult = 19,
    /// An outcome the program doesn't know (0 A won, 1 B won, 2 a draw, 3 a void).
    BadOutcome = 20,
}

impl From<WagerError> for ProgramError {
    fn from(e: WagerError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
