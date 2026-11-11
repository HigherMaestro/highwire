//! The arena's rules (`duels-1`), ported from packages/core/src/arena/rules.ts. Integer-only and allocation-free, for
//! the program. The parity fixtures (tests/parity.rs) check this against the TypeScript after every event.

use borsh::{BorshDeserialize, BorshSerialize};

pub const SIDE_A: u8 = 0;
pub const SIDE_B: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Rules {
    /// The node wins at ±places.
    pub places: u8,
    /// Starting energy, and the most a side can hold.
    pub energy: u8,
    /// Energy regained after every round, up to `energy`.
    pub regen: u8,
    /// After this many rounds, the side the node is on wins.
    pub rounds: u8,
    /// A middle finish goes to the side that spent less (else it's a draw).
    pub tie_break_spent: bool,
    pub round_seconds: u32,
    pub bank_seconds: u32,
}

/// `duels-1`: seven places, 30 energy regaining 2 a round, 15 rounds, no tie-break, 2 minutes a round, 10 in all.
pub const DUELS_1: Rules = Rules { places: 3, energy: 30, regen: 3, rounds: 15, tie_break_spent: false, round_seconds: 120, bank_seconds: 600 };

/// Why a match ended. The numbers are stored on-chain; never renumber them.
pub const REACHED_END: u8 = 1;
pub const ROUNDS_UP: u8 = 2;
pub const TIE_BREAK: u8 = 3;
pub const DRAW: u8 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Ending {
    /// The winning side, or none for a draw.
    pub winner: Option<u8>,
    pub reason: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Match {
    /// Negative is toward side a's end, positive toward b's.
    pub node: i8,
    pub energy: [u8; 2],
    pub spent: [u16; 2],
    /// Rounds played so far.
    pub rounds: u8,
    /// The last round's pulls (for the mirror fallback).
    pub last_pull: [u8; 2],
    pub ending: Option<Ending>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RulesError {
    Over,
    IllegalPull,
}

impl Match {
    pub fn start(rules: &Rules) -> Self {
        Match { node: 0, energy: [rules.energy, rules.energy], spent: [0, 0], rounds: 0, last_pull: [0, 0], ending: None }
    }

    /// One round: the bigger pull moves the node one place; both pay; energy comes back up to the cap.
    pub fn play_round(&mut self, rules: &Rules, pull_a: u8, pull_b: u8) -> Result<(), RulesError> {
        if self.ending.is_some() {
            return Err(RulesError::Over);
        }
        if pull_a > self.energy[0] || pull_b > self.energy[1] {
            return Err(RulesError::IllegalPull);
        }
        let winner = if pull_a > pull_b { Some(SIDE_A) } else if pull_b > pull_a { Some(SIDE_B) } else { None };
        self.node += match winner {
            Some(SIDE_A) => -1,
            Some(_) => 1,
            None => 0,
        };
        // pull <= energy was checked above, so these never underflow; saturating keeps it panic-free by construction.
        self.energy = [
            self.energy[0].saturating_sub(pull_a).saturating_add(rules.regen).min(rules.energy),
            self.energy[1].saturating_sub(pull_b).saturating_add(rules.regen).min(rules.energy),
        ];
        self.spent = [self.spent[0] + pull_a as u16, self.spent[1] + pull_b as u16];
        self.rounds += 1;
        self.last_pull = [pull_a, pull_b];
        if self.node.unsigned_abs() >= rules.places {
            self.ending = Some(Ending { winner: Some(if self.node > 0 { SIDE_B } else { SIDE_A }), reason: REACHED_END });
        } else if self.rounds >= rules.rounds {
            self.ending = Some(self.final_word(rules));
        }
        Ok(())
    }

    fn final_word(&self, rules: &Rules) -> Ending {
        if self.node != 0 {
            return Ending { winner: Some(if self.node > 0 { SIDE_B } else { SIDE_A }), reason: ROUNDS_UP };
        }
        if rules.tie_break_spent && self.spent[0] != self.spent[1] {
            return Ending { winner: Some(if self.spent[0] < self.spent[1] { SIDE_A } else { SIDE_B }), reason: TIE_BREAK };
        }
        Ending { winner: None, reason: DRAW }
    }
}

/// The fallback menu (docs/arena.md 4.4). Stored on-chain as (kind, pull).
pub const FALLBACK_ZERO: u8 = 0;
pub const FALLBACK_STEADY: u8 = 1;
pub const FALLBACK_MIRROR: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Fallback {
    pub kind: u8,
    /// The steady fallback's pull; 0 otherwise.
    pub pull: u8,
}

impl Fallback {
    pub fn valid(&self) -> bool {
        match self.kind {
            FALLBACK_STEADY => self.pull <= 99,
            FALLBACK_ZERO | FALLBACK_MIRROR => self.pull == 0,
            _ => false,
        }
    }

    /// The fallback's pull in this state: always legal (capped by the side's energy).
    pub fn pull_for(&self, m: &Match, side: u8) -> u8 {
        let cap = m.energy[side as usize];
        match self.kind {
            FALLBACK_STEADY => self.pull.min(cap),
            FALLBACK_MIRROR => {
                if m.rounds == 0 {
                    0
                } else {
                    m.last_pull[1 - side as usize].min(cap)
                }
            }
            _ => 0,
        }
    }
}

/// Charges a side for one round: at most the round's time, never below zero. Returns (bank left, bank out).
pub fn charge_clock(rules: &Rules, bank: u32, waited: u32) -> (u32, bool) {
    if bank == 0 {
        return (0, true);
    }
    let cost = waited.min(rules.round_seconds).min(bank);
    let left = bank - cost;
    (left, left == 0)
}
