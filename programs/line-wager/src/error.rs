//! The program's errors. `SeriesError`s map to their own codes so a refusal says which rule refused it.

use crate::series::SeriesError;
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
    WrongSeriesAccount = 10,
    NotAPlayer = 11,
    WrongStatus = 12,
    AcceptDeadlinePassed = 13,
    NotYet = 14,
    NotOver = 15,
    WrongPayee = 16,
    BadFee = 17,
    AlreadyInitialised = 18,
    Math = 19,
    /// The series is over: it settles, it isn't refunded.
    Decided = 20,
    /// Payouts may burn only into the incinerator.
    NotIncinerator = 21,
    // SeriesError codes: 100 +
    Series = 100,
}

impl From<WagerError> for ProgramError {
    fn from(e: WagerError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

/// 100 plus the number below. Never renumber: a new error takes the next number (WrongMatch came after Internal).
pub fn series(e: SeriesError) -> ProgramError {
    let n = match e {
        SeriesError::Over => 0,
        SeriesError::WrongPhase => 1,
        SeriesError::WrongRound => 2,
        SeriesError::AlreadyCommitted => 3,
        SeriesError::TooLate => 4,
        SeriesError::NothingDue => 5,
        SeriesError::StillOpen => 6,
        SeriesError::AlreadyRevealed => 7,
        SeriesError::OwesFallback => 8,
        SeriesError::NoFallbackOwed => 9,
        SeriesError::WrongFallback => 10,
        SeriesError::BadReveal => 11,
        SeriesError::IllegalPull => 12,
        SeriesError::BadPlayer => 13,
        SeriesError::ClockBackward => 14,
        SeriesError::Internal => 15,
        SeriesError::WrongMatch => 16,
    };
    ProgramError::Custom(WagerError::Series as u32 + n)
}
