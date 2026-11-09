//! A wager series: the program's state machine, ported from packages/core/src/arena/series.ts (which is the twin the
//! pages replay and the parity fixtures come from). Five matches, two phases a round (commit, then reveal), committed
//! fallbacks, and a missed reveal forfeiting the match (docs/wager-mode.md 7.2). Times are whole seconds.

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
        s.open_commit(at);
        s
    }

    fn open_commit(&mut self, at: i64) {
        self.phase = PHASE_COMMIT;
        self.phase_opened_at = at;
        self.round = [SideRound::default(); 2];
        for side in [SIDE_A, SIDE_B] {
            if self.bank_out[player_of(side, self.match_index) as usize] {
                self.round[side as usize].owes_fallback = true;
            }
        }
        if self.round[0].owes_fallback && self.round[1].owes_fallback {
            self.end_match(MatchResult { winner: None, reason: crate::series::VOID }, at);
        }
    }

    pub fn commit_deadline(&self, side: u8) -> i64 {
        let p = player_of(side, self.match_index) as usize;
        self.phase_opened_at + self.rules.round_seconds.min(self.bank[p]) as i64
    }

    pub fn reveal_deadline(&self) -> i64 {
        self.phase_opened_at + self.reveal_seconds as i64
    }

    fn maybe_reveal(&mut self, at: i64) {
        if !(committed_or_owed(&self.round[0]) && committed_or_owed(&self.round[1])) {
            return;
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
            self.resolve(at);
        }
    }

    pub fn commit(&mut self, player: u8, round: u8, hash: [u8; 32], at: i64) -> Result<(), SeriesError> {
        if self.ending.is_some() {
            return Err(SeriesError::Over);
        }
        if self.phase != PHASE_COMMIT {
            return Err(SeriesError::WrongPhase);
        }
        if round != self.game.rounds + 1 {
            return Err(SeriesError::WrongRound);
        }
        let side = side_of(player, self.match_index);
        if committed_or_owed(&self.round[side as usize]) {
            return Err(SeriesError::AlreadyCommitted);
        }
        if at > self.commit_deadline(side) {
            return Err(SeriesError::TooLate);
        }
        let waited = (at - self.phase_opened_at).max(0) as u32;
        let (bank, out) = charge_clock(&self.rules, self.bank[player as usize], waited);
        self.bank[player as usize] = bank;
        self.bank_out[player as usize] = out;
        self.round[side as usize].hash = Some(hash);
        self.maybe_reveal(at);
        Ok(())
    }

    pub fn reveal(&mut self, player: u8, input: Reveal, at: i64) -> Result<(), SeriesError> {
        if self.ending.is_some() {
            return Err(SeriesError::Over);
        }
        if self.phase != PHASE_REVEAL {
            return Err(SeriesError::WrongPhase);
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
                if !fallback.valid() || fallback_commitment(&self.series_id, player, &fallback, &salt) != self.fallback_hash[player as usize] {
                    return Err(SeriesError::WrongFallback);
                }
                self.fallback[player as usize] = Some(fallback);
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
            self.resolve(at);
        }
        Ok(())
    }

    fn resolve(&mut self, at: i64) {
        let (a, b) = (self.round[0].pull.unwrap_or(0), self.round[1].pull.unwrap_or(0));
        // Both pulls are legal by construction (checked at reveal, or a fallback's capped pull).
        let _ = self.game.play_round(&self.rules, a, b);
        match self.game.ending {
            Some(e) => {
                let winner = e.winner.map(|side| player_of(side, self.match_index));
                self.end_match(MatchResult { winner, reason: e.reason }, at);
            }
            None => self.open_commit(at),
        }
    }

    fn end_match(&mut self, result: MatchResult, at: i64) {
        let played = self.results.iter().filter(|r| r.is_some()).count();
        self.results[played] = Some(result);
        let played = played as u8 + 1;
        let wins = |p: u8| self.results.iter().filter(|r| matches!(r, Some(MatchResult { winner: Some(w), .. }) if *w == p)).count() as u8;
        let (a, b) = (wins(PLAYER_A), wins(PLAYER_B));
        let left = MATCHES - played;
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
            return;
        }
        self.match_index += 1;
        self.game = Match::start(&self.rules);
        self.bank = [self.rules.bank_seconds, self.rules.bank_seconds];
        self.bank_out = [false, false];
        self.open_commit(at);
    }

    /// Anyone, after a deadline: a missed commit owes its fallback; a missed reveal forfeits the match (both: void).
    pub fn timeout(&mut self, at: i64) -> Result<(), SeriesError> {
        if self.ending.is_some() {
            return Err(SeriesError::Over);
        }
        if self.phase == PHASE_COMMIT {
            let mut changed = false;
            for side in [SIDE_A, SIDE_B] {
                if committed_or_owed(&self.round[side as usize]) || at <= self.commit_deadline(side) {
                    continue;
                }
                let p = player_of(side, self.match_index) as usize;
                let waited = (self.commit_deadline(side) - self.phase_opened_at) as u32;
                let (bank, out) = charge_clock(&self.rules, self.bank[p], waited);
                self.bank[p] = bank;
                self.bank_out[p] = out;
                self.round[side as usize].owes_fallback = true;
                changed = true;
            }
            if !changed {
                return Err(SeriesError::NothingDue);
            }
            self.maybe_reveal(at);
            return Ok(());
        }
        if at <= self.reveal_deadline() {
            return Err(SeriesError::StillOpen);
        }
        let missed_a = self.round[0].pull.is_none();
        let missed_b = self.round[1].pull.is_none();
        let result = match (missed_a, missed_b) {
            (true, true) => MatchResult { winner: None, reason: VOID },
            (true, false) => MatchResult { winner: Some(player_of(SIDE_B, self.match_index)), reason: MISSED_REVEAL },
            _ => MatchResult { winner: Some(player_of(SIDE_A, self.match_index)), reason: MISSED_REVEAL },
        };
        self.end_match(result, at);
        Ok(())
    }

    pub fn retire(&mut self, player: u8) -> Result<(), SeriesError> {
        if self.ending.is_some() {
            return Err(SeriesError::Over);
        }
        self.ending = Some(SeriesEnding { winner: Some(if player == PLAYER_A { PLAYER_B } else { PLAYER_A }), reason: RETIRED });
        Ok(())
    }
}
