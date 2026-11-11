//! A wager series: the program's state machine, ported from packages/core/src/arena/series.ts (which is the twin the
//! pages replay and the parity fixtures come from). Five matches, two phases a round (commit, then reveal), committed
//! fallbacks, a missed reveal forfeiting the match, and a bank-out lasting the rest of the series (docs/wager-mode.md
//! 7.2). Times are whole seconds, never before the phase they act in. Nothing here panics on any input: a player value
//! is checked, never used to index unchecked, and every error is a `SeriesError`.

use crate::rules::{charge_clock, Fallback, Match, Rules, SIDE_A, SIDE_B};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::hash::hashv;

pub const MATCHES: u8 = 5;
pub const PLAYER_A: u8 = 0;
pub const PLAYER_B: u8 = 1;

pub const PHASE_COMMIT: u8 = 0;
pub const PHASE_REVEAL: u8 = 1;

/// Why a match ended, beyond the rules' own reasons (rules.rs numbers 1 to 4). Never renumber.
pub const MISSED_REVEAL: u8 = 5;
pub const VOID: u8 = 6;

/// Why a series ended. Never renumber.
pub const DECIDED: u8 = 1;
pub const SERIES_DRAW: u8 = 2;
pub const RETIRED: u8 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct MatchResult {
    /// The winning player, or none.
    pub winner: Option<u8>,
    pub reason: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct SeriesEnding {
    pub winner: Option<u8>,
    pub reason: u8,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct SideRound {
    pub hash: Option<[u8; 32]>,
    pub owes_fallback: bool,
    pub pull: Option<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Series {
    pub rules: Rules,
    pub reveal_seconds: u32,
    pub series_id: [u8; 32],
    /// Each player's fallback commitment, and the fallback once revealed (public for the rest of the series).
    pub fallback_hash: [[u8; 32]; 2],
    pub fallback: [Option<Fallback>; 2],
    pub match_index: u8,
    pub game: Match,
    pub bank: [u32; 2],
    pub bank_out: [bool; 2],
    pub phase: u8,
    pub phase_opened_at: i64,
    /// Indexed by side (a, b) in the current match.
    pub round: [SideRound; 2],
    pub results: [Option<MatchResult>; 5],
    pub ending: Option<SeriesEnding>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SeriesError {
    Over,
    WrongPhase,
    /// The commit names a match other than the one in play.
    WrongMatch,
    WrongRound,
    AlreadyCommitted,
    TooLate,
    NothingDue,
    StillOpen,
    AlreadyRevealed,
    OwesFallback,
    NoFallbackOwed,
    WrongFallback,
    BadReveal,
    IllegalPull,
    BadPlayer,
    ClockBackward,
    /// An invariant broke (unreachable by construction); the instruction fails rather than guessing.
    Internal,
}

/// The most bytes a `Series` takes in Borsh (every Option filled); accounts are allocated at this size and read with
/// `BorshDeserialize::deserialize`, which ignores the unused tail (`try_from_slice` would refuse it).
pub const SERIES_MAX_LEN: usize = 249;

fn check_player(player: u8) -> Result<usize, SeriesError> {
    if player > PLAYER_B {
        return Err(SeriesError::BadPlayer);
    }
    Ok(player as usize)
}

/// Player A takes side a in matches 0, 2 and 4, side b in 1 and 3.
pub fn side_of(player: u8, match_index: u8) -> u8 {
    if (player == PLAYER_A) == (match_index % 2 == 0) {
        SIDE_A
    } else {
        SIDE_B
    }
}

pub fn player_of(side: u8, match_index: u8) -> u8 {
    if side_of(PLAYER_A, match_index) == side {
        PLAYER_A
    } else {
        PLAYER_B
    }
}

/// SHA-256 of the series id, the match, the round, the side, the pull and a 32-byte nonce.
pub fn move_commitment(series_id: &[u8; 32], match_index: u8, round: u8, side: u8, pull: u8, nonce: &[u8; 32]) -> [u8; 32] {
    hashv(&[series_id, &[match_index, round, side, pull], nonce]).to_bytes()
}

/// SHA-256 of "fb", the series id, the player, the fallback's kind and pull, and a 32-byte salt.
pub fn fallback_commitment(series_id: &[u8; 32], player: u8, f: &Fallback, salt: &[u8; 32]) -> [u8; 32] {
    hashv(&[b"fb", series_id, &[player, f.kind, f.pull], salt]).to_bytes()
}

pub enum Reveal {
    Pull { pull: u8, nonce: [u8; 32] },
    Fallback { fallback: Fallback, salt: [u8; 32] },
}

fn committed_or_owed(r: &SideRound) -> bool {
    r.hash.is_some() || r.owes_fallback
}

impl Series {
    /// A series once both stakes are in: round 1 of match 1 opens at `at`.
    pub fn start(rules: Rules, reveal_seconds: u32, series_id: [u8; 32], fallback_hash: [[u8; 32]; 2], at: i64) -> Self {
        let mut s = Series {
            rules,
            reveal_seconds,
            series_id,
            fallback_hash,
            fallback: [None, None],
            match_index: 0,
            game: Match::start(&rules),
            bank: [rules.bank_seconds, rules.bank_seconds],
            bank_out: [false, false],
            phase: PHASE_COMMIT,
            phase_opened_at: at,
            round: [SideRound::default(); 2],
            results: [None; 5],
            ending: None,
        };
        // Both banks are full at the start, so this can't void a match or fail.
        let _ = s.open_commit(at);
        s
    }

    fn open_commit(&mut self, at: i64) -> Result<(), SeriesError> {
        self.phase = PHASE_COMMIT;
        self.phase_opened_at = at;
        self.round = [SideRound::default(); 2];
        for side in [SIDE_A, SIDE_B] {
            if self.bank_out[player_of(side, self.match_index) as usize] {
                self.round[side as usize].owes_fallback = true;
            }
        }
        // Both banks out: neither side is there, so the match is void, as in free play.
        if self.round[0].owes_fallback && self.round[1].owes_fallback {
            return self.end_match(MatchResult { winner: None, reason: VOID }, at);
        }
        Ok(())
    }

    pub fn commit_deadline(&self, side: u8) -> i64 {
        let p = player_of(side, self.match_index) as usize;
        self.phase_opened_at + self.rules.round_seconds.min(self.bank[p]) as i64
    }

    pub fn reveal_deadline(&self) -> i64 {
        self.phase_opened_at + self.reveal_seconds as i64
    }

    fn maybe_reveal(&mut self, at: i64) -> Result<(), SeriesError> {
        if !(committed_or_owed(&self.round[0]) && committed_or_owed(&self.round[1])) {
            return Ok(());
        }
        self.phase = PHASE_REVEAL;
        self.phase_opened_at = at;
        for side in [SIDE_A, SIDE_B] {
            let player = player_of(side, self.match_index) as usize;
            if self.round[side as usize].owes_fallback {
                if let Some(f) = self.fallback[player] {
                    self.round[side as usize].pull = Some(f.pull_for(&self.game, side));
                }
            }
        }
        if self.round[0].pull.is_some() && self.round[1].pull.is_some() {
            return self.resolve(at);
        }
        Ok(())
    }

    /// A side commits to its pull for the open round. The commit names its match and its round, as its commitment
    /// does, and both must be the ones in play: round numbers repeat from match to match, so a second copy of an
    /// earlier match's commit (a retry that landed late) would otherwise stand as this match's move, unopenable.
    pub fn commit(&mut self, player: u8, match_index: u8, round: u8, hash: [u8; 32], at: i64) -> Result<(), SeriesError> {
        let pi = check_player(player)?;
        if self.ending.is_some() {
            return Err(SeriesError::Over);
        }
        if self.phase != PHASE_COMMIT {
            return Err(SeriesError::WrongPhase);
        }
        if at < self.phase_opened_at {
            return Err(SeriesError::ClockBackward);
        }
        if match_index != self.match_index {
            return Err(SeriesError::WrongMatch);
        }
        if round != self.game.rounds + 1 {
            return Err(SeriesError::WrongRound);
        }
        let side = side_of(player, self.match_index);
        if committed_or_owed(&self.round[side as usize]) {
            return Err(SeriesError::AlreadyCommitted);
        }
        // As free play's clock: a move must land before the round's time (or the bank) runs out, never on it.
        if at >= self.commit_deadline(side) {
            return Err(SeriesError::TooLate);
        }
        let waited = u32::try_from(at - self.phase_opened_at).map_err(|_| SeriesError::Internal)?;
        let (bank, out) = charge_clock(&self.rules, self.bank[pi], waited);
        self.bank[pi] = bank;
        self.bank_out[pi] = out;
        self.round[side as usize].hash = Some(hash);
        self.maybe_reveal(at)
    }

    pub fn reveal(&mut self, player: u8, input: Reveal, at: i64) -> Result<(), SeriesError> {
        let pi = check_player(player)?;
        if self.ending.is_some() {
            return Err(SeriesError::Over);
        }
        if self.phase != PHASE_REVEAL {
            return Err(SeriesError::WrongPhase);
        }
        if at < self.phase_opened_at {
            return Err(SeriesError::ClockBackward);
        }
        if at > self.reveal_deadline() {
            return Err(SeriesError::TooLate);
        }
        let side = side_of(player, self.match_index);
        let r = self.round[side as usize];
        if r.pull.is_some() {
            return Err(SeriesError::AlreadyRevealed);
        }
        let pull = match input {
            Reveal::Fallback { fallback, salt } => {
                if !r.owes_fallback {
                    return Err(SeriesError::NoFallbackOwed);
                }
                if !fallback.valid() || fallback_commitment(&self.series_id, player, &fallback, &salt) != self.fallback_hash[pi] {
                    return Err(SeriesError::WrongFallback);
                }
                self.fallback[pi] = Some(fallback);
                fallback.pull_for(&self.game, side)
            }
            Reveal::Pull { pull, nonce } => {
                if r.owes_fallback {
                    return Err(SeriesError::OwesFallback);
                }
                if Some(move_commitment(&self.series_id, self.match_index, self.game.rounds + 1, side, pull, &nonce)) != r.hash {
                    return Err(SeriesError::BadReveal);
                }
                if pull > self.game.energy[side as usize] {
                    return Err(SeriesError::IllegalPull);
                }
                pull
            }
        };
        self.round[side as usize].pull = Some(pull);
        if self.round[0].pull.is_some() && self.round[1].pull.is_some() {
            self.resolve(at)?;
        }
        Ok(())
    }

    fn resolve(&mut self, at: i64) -> Result<(), SeriesError> {
        let (a, b) = match (self.round[0].pull, self.round[1].pull) {
            (Some(a), Some(b)) => (a, b),
            _ => return Err(SeriesError::Internal),
        };
        // Both pulls are legal by construction (checked at reveal, or a fallback's capped pull); if not, fail loudly.
        self.game.play_round(&self.rules, a, b).map_err(|_| SeriesError::Internal)?;
        match self.game.ending {
            Some(e) => {
                let winner = e.winner.map(|side| player_of(side, self.match_index));
                self.end_match(MatchResult { winner, reason: e.reason }, at)
            }
            None => self.open_commit(at),
        }
    }

    fn end_match(&mut self, result: MatchResult, at: i64) -> Result<(), SeriesError> {
        let played = self.results.iter().filter(|r| r.is_some()).count();
        *self.results.get_mut(played).ok_or(SeriesError::Internal)? = Some(result);
        let played = played as u8 + 1;
        let wins = |p: u8| self.results.iter().filter(|r| matches!(r, Some(MatchResult { winner: Some(w), .. }) if *w == p)).count() as u8;
        let (a, b) = (wins(PLAYER_A), wins(PLAYER_B));
        let left = MATCHES.checked_sub(played).ok_or(SeriesError::Internal)?;
        if a > b + left {
            self.ending = Some(SeriesEnding { winner: Some(PLAYER_A), reason: DECIDED });
        } else if b > a + left {
            self.ending = Some(SeriesEnding { winner: Some(PLAYER_B), reason: DECIDED });
        } else if left == 0 {
            self.ending = Some(if a == b {
                SeriesEnding { winner: None, reason: SERIES_DRAW }
            } else {
                SeriesEnding { winner: Some(if a > b { PLAYER_A } else { PLAYER_B }), reason: DECIDED }
            });
        }
        if self.ending.is_some() {
            return Ok(());
        }
        self.match_index += 1;
        self.game = Match::start(&self.rules);
        // Banks refill each match, but a side whose bank ran out stays on its fallback for the rest of the series.
        for p in 0..2 {
            self.bank[p] = if self.bank_out[p] { 0 } else { self.rules.bank_seconds };
        }
        self.open_commit(at)
    }

    /// Anyone, after a deadline. In a commit phase it applies only once every side that hasn't committed is past its
    /// own deadline (so nothing about one side is published while the other can still move); each late side then owes
    /// its fallback. In a reveal phase past the window, a side that hasn't revealed forfeits the match (both: void).
    pub fn timeout(&mut self, at: i64) -> Result<(), SeriesError> {
        if self.ending.is_some() {
            return Err(SeriesError::Over);
        }
        if at < self.phase_opened_at {
            return Err(SeriesError::ClockBackward);
        }
        if self.phase == PHASE_COMMIT {
            let late: [bool; 2] = [!committed_or_owed(&self.round[0]), !committed_or_owed(&self.round[1])];
            if !late[0] && !late[1] {
                return Err(SeriesError::NothingDue);
            }
            for side in [SIDE_A, SIDE_B] {
                if late[side as usize] && at < self.commit_deadline(side) {
                    return Err(SeriesError::StillOpen);
                }
            }
            for side in [SIDE_A, SIDE_B] {
                if !late[side as usize] {
                    continue;
                }
                let p = player_of(side, self.match_index) as usize;
                let waited = u32::try_from(self.commit_deadline(side) - self.phase_opened_at).map_err(|_| SeriesError::Internal)?;
                let (bank, out) = charge_clock(&self.rules, self.bank[p], waited);
                self.bank[p] = bank;
                self.bank_out[p] = out;
                self.round[side as usize].owes_fallback = true;
            }
            return self.maybe_reveal(at);
        }
        if at <= self.reveal_deadline() {
            return Err(SeriesError::StillOpen);
        }
        let missed_a = self.round[0].pull.is_none();
        let missed_b = self.round[1].pull.is_none();
        let result = match (missed_a, missed_b) {
            (true, true) => MatchResult { winner: None, reason: VOID },
            (true, false) => MatchResult { winner: Some(player_of(SIDE_B, self.match_index)), reason: MISSED_REVEAL },
            (false, true) => MatchResult { winner: Some(player_of(SIDE_A, self.match_index)), reason: MISSED_REVEAL },
            (false, false) => return Err(SeriesError::Internal),
        };
        self.end_match(result, at)
    }

    pub fn retire(&mut self, player: u8) -> Result<(), SeriesError> {
        check_player(player)?;
        if self.ending.is_some() {
            return Err(SeriesError::Over);
        }
        self.ending = Some(SeriesEnding { winner: Some(if player == PLAYER_A { PLAYER_B } else { PLAYER_A }), reason: RETIRED });
        Ok(())
    }
}
