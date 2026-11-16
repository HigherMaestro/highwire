//! The program's instruction handlers: accounts and money, and no rules of the game. Rules it keeps
//! (docs/link-wager.md 1 to 4):
//! - stakes leave a battle's account only to its two players;
//! - a battle starts from the desk's ticket and ends on the referee's signed result, each checked against the key in
//!   the config and against this battle's id and wallets;
//! - a battle with both stakes in and no result for the config's `refund_after_seconds` can be refunded by anyone, so no
//!   stake is ever stuck on a referee that's gone;
//! - the authority can pause new battles, change limits within hard caps, rotate the two keys and freeze-and-refund,
//!   and nothing else: it can't pay anyone but the players;
//! - an account that's done is closed, its rent to player A, who paid it;
//! - no payee can block a payout: a share the runtime won't credit (an executable or loader-owned account) burns.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    bpf_loader, bpf_loader_deprecated,
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    clock::Clock,
    entrypoint::ProgramResult,
    incinerator, loader_v4,
    log::sol_log_data,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};

use crate::error::WagerError;
use crate::instruction::{ConfigInit, ConfigUpdate, LinkWagerInstruction};
use crate::signed::{self, BattleResult, Ticket};
use crate::state::*;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let ix = LinkWagerInstruction::try_from_slice(data).map_err(|_| WagerError::BadInstruction)?;
    match ix {
        LinkWagerInstruction::InitConfig(c) => init_config(program_id, accounts, c),
        LinkWagerInstruction::UpdateConfig(u) => update_config(program_id, accounts, u),
        LinkWagerInstruction::Open { battle_id, player_b, stake, accept_deadline, expiry, key_id } => open(program_id, accounts, battle_id, player_b, stake, accept_deadline, expiry, key_id),
        LinkWagerInstruction::Accept => accept(program_id, accounts),
        LinkWagerInstruction::Cancel => cancel(program_id, accounts),
        LinkWagerInstruction::Settle { outcome, key_id } => settle(program_id, accounts, outcome, key_id),
        LinkWagerInstruction::Refund => refund_all(program_id, accounts, false),
        LinkWagerInstruction::FreezeAndRefund => refund_all(program_id, accounts, true),
    }
}

// ---------------------------------------------------------------- helpers

fn now() -> Result<i64, ProgramError> {
    Ok(Clock::get()?.unix_timestamp)
}

fn config_address(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CONFIG_SEED], program_id)
}

pub fn battle_address(program_id: &Pubkey, battle_id: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[BATTLE_SEED, battle_id], program_id)
}

fn load_config(program_id: &Pubkey, acc: &AccountInfo) -> Result<Config, ProgramError> {
    if acc.owner != program_id || *acc.key != config_address(program_id).0 {
        return Err(WagerError::NotConfig.into());
    }
    Config::deserialize(&mut &acc.data.borrow()[..]).map_err(|_| WagerError::NotConfig.into())
}

fn save<T: BorshSerialize>(value: &T, acc: &AccountInfo) -> ProgramResult {
    let bytes = borsh::to_vec(value).map_err(|_| WagerError::Math)?;
    let mut data = acc.data.borrow_mut();
    if bytes.len() > data.len() {
        return Err(WagerError::Math.into());
    }
    data[..bytes.len()].copy_from_slice(&bytes);
    Ok(())
}

fn load_battle(program_id: &Pubkey, acc: &AccountInfo) -> Result<Battle, ProgramError> {
    if acc.owner != program_id {
        return Err(WagerError::WrongBattleAccount.into());
    }
    let b = Battle::deserialize(&mut &acc.data.borrow()[..]).map_err(|_| WagerError::WrongBattleAccount)?;
    if *acc.key != battle_address(program_id, &b.battle_id).0 {
        return Err(WagerError::WrongBattleAccount.into());
    }
    Ok(b)
}

/// Moves lamports out of a program-owned account.
fn pay(from: &AccountInfo, to: &AccountInfo, lamports: u64) -> ProgramResult {
    if lamports == 0 {
        return Ok(());
    }
    let left = from.lamports().checked_sub(lamports).ok_or(WagerError::Math)?;
    let got = to.lamports().checked_add(lamports).ok_or(WagerError::Math)?;
    **from.try_borrow_mut_lamports()? = left;
    **to.try_borrow_mut_lamports()? = got;
    Ok(())
}

/// Whether the runtime would refuse to credit this account: a program, or anything a loader owns. A player can turn its
/// own wallet into one (empty it, then deploy a program at its address), and without this check that would block every
/// payout that touches it, the other player's included.
const NATIVE_LOADER: Pubkey = solana_program::pubkey!("NativeLoader1111111111111111111111111111111");

fn uncreditable(acc: &AccountInfo) -> bool {
    acc.executable || [bpf_loader_upgradeable::ID, bpf_loader::ID, bpf_loader_deprecated::ID, loader_v4::ID, NATIVE_LOADER].contains(acc.owner)
}

fn incinerator_account<'a, 'b>(acc: &'a AccountInfo<'b>) -> Result<&'a AccountInfo<'b>, ProgramError> {
    if *acc.key != incinerator::ID {
        return Err(WagerError::NotIncinerator.into());
    }
    Ok(acc)
}

/// Pays a player, or burns the share if the runtime won't credit them.
fn pay_player<'a>(from: &AccountInfo<'a>, to: &AccountInfo<'a>, burn: &AccountInfo<'a>, lamports: u64) -> ProgramResult {
    pay(from, if uncreditable(to) { burn } else { to }, lamports)
}

/// Closes a battle's account: every remaining lamport (its rent, and anything sent to it by mistake) to `to`.
fn close<'a>(battle: &AccountInfo<'a>, to: &AccountInfo<'a>, burn: &AccountInfo<'a>) -> ProgramResult {
    pay_player(battle, to, burn, battle.lamports())?;
    battle.data.borrow_mut().fill(0);
    battle.realloc(0, false)?;
    battle.assign(&system_program::ID);
    Ok(())
}

/// How a battle closed, announced as a `Program data:` log line: "link-wager", the kind, the battle's id and the
/// outcome. Readers take it only from this program's own frames of the log, so no other program can forge one, and it
/// names the battle, so no other battle's transaction can stand in for it.
pub const EVENT_TAG: &[u8] = b"link-wager";
pub const CLOSED_SETTLED: u8 = 1;
pub const CLOSED_CANCELLED: u8 = 2;
pub const CLOSED_REFUNDED: u8 = 3;
/// The outcome byte of a close that isn't a settle.
pub const OUTCOME_NONE: u8 = 255;

fn announce(kind: u8, battle_id: &[u8; 32], outcome: u8) {
    sol_log_data(&[EVENT_TAG, &[kind], battle_id, &[outcome]]);
}

fn release(config_acc: &AccountInfo, program_id: &Pubkey, lamports: u64) -> ProgramResult {
    let mut c = load_config(program_id, config_acc)?;
    c.open_stake = c.open_stake.saturating_sub(lamports);
    save(&c, config_acc)
}

fn check_limits(c: &ConfigInit) -> ProgramResult {
    if c.max_stake > STAKE_HARD_MAX || c.tiers.iter().any(|t| *t > c.max_stake || (*t != 0 && *t < STAKE_HARD_MIN)) {
        return Err(WagerError::OverStakeCap.into());
    }
    if !(REFUND_AFTER_MIN..=REFUND_AFTER_MAX).contains(&c.refund_after_seconds) {
        return Err(WagerError::BadInstruction.into());
    }
    Ok(())
}

// ---------------------------------------------------------------- config

fn init_config(program_id: &Pubkey, accounts: &[AccountInfo], c: ConfigInit) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let config = next_account_info(it)?;
    let program_data = next_account_info(it)?;
    let system = next_account_info(it)?;
    if !payer.is_signer || *system.key != system_program::ID {
        return Err(WagerError::NotAuthority.into());
    }
    // Only the program's upgrade authority may set it up, so nobody can front-run the deploy with their own config.
    let (pd, _) = Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::ID);
    if *program_data.key != pd || *program_data.owner != bpf_loader_upgradeable::ID {
        return Err(WagerError::NotAuthority.into());
    }
    let state: UpgradeableLoaderState = program_data_state(&program_data.data.borrow())?;
    match state {
        UpgradeableLoaderState::ProgramData { upgrade_authority_address: Some(a), .. } if a == *payer.key => {}
        _ => return Err(WagerError::NotAuthority.into()),
    }
    check_limits(&c)?;
    let (addr, bump) = config_address(program_id);
    if *config.key != addr {
        return Err(WagerError::NotConfig.into());
    }
    if config.lamports() > 0 && config.owner == program_id {
        return Err(WagerError::AlreadyInitialised.into());
    }
    create_pda(payer, config, system, program_id, Config::LEN, 0, &[CONFIG_SEED, &[bump]])?;
    let cfg = Config {
        version: 1,
        authority: c.authority,
        ticket_key: c.ticket_key,
        ticket_key_id: c.ticket_key_id,
        result_key: c.result_key,
        result_key_id: c.result_key_id,
        paused: false,
        tiers: c.tiers,
        max_stake: c.max_stake,
        open_stake_cap: c.open_stake_cap,
        open_stake: 0,
        refund_after_seconds: c.refund_after_seconds,
    };
    save(&cfg, config)
}

/// The program-data account's state: a u32 tag, then (for ProgramData) the slot and an optional authority.
fn program_data_state(data: &[u8]) -> Result<UpgradeableLoaderState, ProgramError> {
    // Layout (bincode): tag u32 = 3, slot u64, Option<Pubkey> (u8 flag + 32 bytes).
    if data.len() < 4 + 8 + 1 || u32::from_le_bytes([data[0], data[1], data[2], data[3]]) != 3 {
        return Err(WagerError::NotAuthority.into());
    }
    let slot = u64::from_le_bytes(data[4..12].try_into().map_err(|_| WagerError::NotAuthority)?);
    let authority = match data[12] {
        0 => None,
        1 if data.len() >= 13 + 32 => Some(Pubkey::new_from_array(data[13..45].try_into().map_err(|_| WagerError::NotAuthority)?)),
        _ => return Err(WagerError::NotAuthority.into()),
    };
    Ok(UpgradeableLoaderState::ProgramData { slot, upgrade_authority_address: authority })
}

fn update_config(program_id: &Pubkey, accounts: &[AccountInfo], u: ConfigUpdate) -> ProgramResult {
    let it = &mut accounts.iter();
    let authority = next_account_info(it)?;
    let config = next_account_info(it)?;
    let mut c = load_config(program_id, config)?;
    if !authority.is_signer || *authority.key != c.authority {
        return Err(WagerError::NotAuthority.into());
    }
    if let Some(a) = u.authority {
        c.authority = a;
    }
    if let Some((k, id)) = u.ticket_key {
        c.ticket_key = k;
        c.ticket_key_id = id;
    }
    if let Some((k, id)) = u.result_key {
        c.result_key = k;
        c.result_key_id = id;
    }
    if let Some(p) = u.paused {
        c.paused = p;
    }
    if let Some(t) = u.tiers {
        c.tiers = t;
    }
    if let Some(m) = u.max_stake {
        c.max_stake = m;
    }
    if let Some(m) = u.open_stake_cap {
        c.open_stake_cap = m;
    }
    if let Some(s) = u.refund_after_seconds {
        c.refund_after_seconds = s;
    }
    check_limits(&ConfigInit {
        authority: c.authority,
        ticket_key: c.ticket_key,
        ticket_key_id: c.ticket_key_id,
        result_key: c.result_key,
        result_key_id: c.result_key_id,
        tiers: c.tiers,
        max_stake: c.max_stake,
        open_stake_cap: c.open_stake_cap,
        refund_after_seconds: c.refund_after_seconds,
    })?;
    save(&c, config)
}

/// Creates a program-owned PDA funded with its rent plus `extra`, even if someone has already sent lamports to its address
/// (which would make a plain `create_account` fail: a cheap way to block a battle).
fn create_pda<'a>(payer: &AccountInfo<'a>, pda: &AccountInfo<'a>, system: &AccountInfo<'a>, program_id: &Pubkey, space: usize, extra: u64, seeds: &[&[u8]]) -> ProgramResult {
    let need = Rent::get()?.minimum_balance(space).checked_add(extra).ok_or(WagerError::Math)?;
    if pda.lamports() == 0 {
        invoke_signed(&system_instruction::create_account(payer.key, pda.key, need, space as u64, program_id), &[payer.clone(), pda.clone(), system.clone()], &[seeds])?;
        return Ok(());
    }
    if pda.owner != &system_program::ID || !pda.data_is_empty() {
        return Err(WagerError::WrongBattleAccount.into());
    }
    let top_up = need.saturating_sub(pda.lamports());
    if top_up > 0 {
        invoke(&system_instruction::transfer(payer.key, pda.key, top_up), &[payer.clone(), pda.clone(), system.clone()])?;
    }
    invoke_signed(&system_instruction::allocate(pda.key, space as u64), &[pda.clone(), system.clone()], &[seeds])?;
    invoke_signed(&system_instruction::assign(pda.key, program_id), &[pda.clone(), system.clone()], &[seeds])?;
    Ok(())
}

// ---------------------------------------------------------------- staking

#[allow(clippy::too_many_arguments)]
fn open(program_id: &Pubkey, accounts: &[AccountInfo], battle_id: [u8; 32], player_b: Pubkey, stake: u64, accept_deadline: i64, expiry: i64, key_id: u16) -> ProgramResult {
    let it = &mut accounts.iter();
    let player_a = next_account_info(it)?;
    let config_acc = next_account_info(it)?;
    let battle_acc = next_account_info(it)?;
    let ixs = next_account_info(it)?;
    let system = next_account_info(it)?;
    // A plain wallet: something that pays its stake from its own lamports, and that can be paid.
    if !player_a.is_signer || *system.key != system_program::ID || *player_a.owner != system_program::ID || uncreditable(player_a) {
        return Err(WagerError::NotAPlayer.into());
    }
    let mut c = load_config(program_id, config_acc)?;
    if c.paused {
        return Err(WagerError::Paused.into());
    }
    if stake == 0 || stake > c.max_stake || !c.tiers.contains(&stake) {
        return Err(WagerError::BadTier.into());
    }
    if player_b == *player_a.key {
        return Err(WagerError::NotAPlayer.into());
    }
    let t = now()?;
    if t > expiry || accept_deadline > expiry || key_id != c.ticket_key_id {
        return Err(WagerError::TicketExpired.into());
    }
    let ticket = Ticket { battle_id, player_a: *player_a.key, player_b, stake, accept_deadline, expiry, key_id };
    signed::verify(ixs, &c.ticket_key, &ticket.message(program_id), WagerError::BadTicket)?;
    let both = stake.checked_mul(2).ok_or(WagerError::Math)?;
    let open_stake = c.open_stake.checked_add(both).ok_or(WagerError::Math)?;
    if open_stake > c.open_stake_cap {
        return Err(WagerError::OverOpenStakeCap.into());
    }
    let (addr, bump) = battle_address(program_id, &battle_id);
    if *battle_acc.key != addr {
        return Err(WagerError::WrongBattleAccount.into());
    }
    if battle_acc.owner == program_id {
        return Err(WagerError::WrongStatus.into()); // already opened
    }
    create_pda(player_a, battle_acc, system, program_id, Battle::LEN, stake, &[BATTLE_SEED, &battle_id, &[bump]])?;
    let battle = Battle {
        version: 1,
        status: STATUS_OPEN,
        battle_id,
        player_a: *player_a.key,
        player_b,
        stake,
        ticket_key_id: key_id,
        accept_deadline,
        ticket_expiry: expiry,
        opened_at: t,
        live_at: 0,
    };
    save(&battle, battle_acc)?;
    // Reserve both stakes against the cap now, so an accept can't push it over.
    c.open_stake = open_stake;
    save(&c, config_acc)
}

fn accept(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let player_b = next_account_info(it)?;
    let config_acc = next_account_info(it)?;
    let battle_acc = next_account_info(it)?;
    let ixs = next_account_info(it)?;
    let system = next_account_info(it)?;
    let c = load_config(program_id, config_acc)?;
    if c.paused {
        return Err(WagerError::Paused.into());
    }
    let mut b = load_battle(program_id, battle_acc)?;
    if !player_b.is_signer || *player_b.key != b.player_b || *system.key != system_program::ID {
        return Err(WagerError::NotAPlayer.into());
    }
    if b.status != STATUS_OPEN {
        return Err(WagerError::WrongStatus.into());
    }
    let t = now()?;
    if t > b.accept_deadline {
        return Err(WagerError::AcceptDeadlinePassed.into());
    }
    // The same ticket A opened with, and still under the key that signed it: after a rotation B can't accept, and A cancels.
    if b.ticket_key_id != c.ticket_key_id {
        return Err(WagerError::BadTicket.into());
    }
    let ticket = Ticket { battle_id: b.battle_id, player_a: b.player_a, player_b: b.player_b, stake: b.stake, accept_deadline: b.accept_deadline, expiry: b.ticket_expiry, key_id: b.ticket_key_id };
    signed::verify(ixs, &c.ticket_key, &ticket.message(program_id), WagerError::BadTicket)?;
    invoke(&system_instruction::transfer(player_b.key, battle_acc.key, b.stake), &[player_b.clone(), battle_acc.clone(), system.clone()])?;
    b.status = STATUS_LIVE;
    b.live_at = t;
    save(&b, battle_acc)
}

fn cancel(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let caller = next_account_info(it)?;
    let config_acc = next_account_info(it)?;
    let battle_acc = next_account_info(it)?;
    let player_a = next_account_info(it)?;
    let burn = incinerator_account(next_account_info(it)?)?;
    let b = load_battle(program_id, battle_acc)?;
    if b.status != STATUS_OPEN {
        return Err(WagerError::WrongStatus.into());
    }
    if *player_a.key != b.player_a {
        return Err(WagerError::WrongPayee.into());
    }
    let by_a = caller.is_signer && *caller.key == b.player_a;
    if !by_a && now()? <= b.accept_deadline {
        return Err(WagerError::NotYet.into());
    }
    release(config_acc, program_id, b.stake.checked_mul(2).ok_or(WagerError::Math)?)?;
    announce(CLOSED_CANCELLED, &b.battle_id, OUTCOME_NONE);
    close(battle_acc, player_a, burn)
}

// ---------------------------------------------------------------- the end

/// Pays on the referee's signed result: the winner both stakes, or each their own on a draw or a void.
fn settle(program_id: &Pubkey, accounts: &[AccountInfo], outcome: u8, key_id: u16) -> ProgramResult {
    let it = &mut accounts.iter();
    let battle_acc = next_account_info(it)?;
    let config_acc = next_account_info(it)?;
    let player_a = next_account_info(it)?;
    let player_b = next_account_info(it)?;
    let ixs = next_account_info(it)?;
    let burn = incinerator_account(next_account_info(it)?)?;
    let b = load_battle(program_id, battle_acc)?;
    if b.status != STATUS_LIVE {
        return Err(WagerError::WrongStatus.into());
    }
    if outcome > OUTCOME_VOID {
        return Err(WagerError::BadOutcome.into());
    }
    let c = load_config(program_id, config_acc)?;
    // A result signed under a key since rotated is refused: the referee signs it again with the key in the config.
    if key_id != c.result_key_id {
        return Err(WagerError::BadResult.into());
    }
    let result = BattleResult { battle_id: b.battle_id, player_a: b.player_a, player_b: b.player_b, outcome, key_id };
    signed::verify(ixs, &c.result_key, &result.message(program_id), WagerError::BadResult)?;
    if *player_a.key != b.player_a || *player_b.key != b.player_b {
        return Err(WagerError::WrongPayee.into());
    }
    let pot = b.stake.checked_mul(2).ok_or(WagerError::Math)?;
    match outcome {
        OUTCOME_A => pay_player(battle_acc, player_a, burn, pot)?,
        OUTCOME_B => pay_player(battle_acc, player_b, burn, pot)?,
        _ => {
            pay_player(battle_acc, player_a, burn, b.stake)?;
            pay_player(battle_acc, player_b, burn, b.stake)?;
        }
    }
    release(config_acc, program_id, pot)?;
    announce(CLOSED_SETTLED, &b.battle_id, outcome);
    close(battle_acc, player_a, burn)
}

/// Refunds every stake in a battle's account and closes it: anyone, once both have staked and no result has come for
/// the config's `refund_after_seconds`; or the authority at any time, whoever has staked.
fn refund_all(program_id: &Pubkey, accounts: &[AccountInfo], by_authority: bool) -> ProgramResult {
    let it = &mut accounts.iter();
    let (config_acc, battle_acc) = if by_authority {
        let authority = next_account_info(it)?;
        let config_acc = next_account_info(it)?;
        let c = load_config(program_id, config_acc)?;
        if !authority.is_signer || *authority.key != c.authority {
            return Err(WagerError::NotAuthority.into());
        }
        (config_acc, next_account_info(it)?)
    } else {
        let battle_acc = next_account_info(it)?;
        (next_account_info(it)?, battle_acc)
    };
    let player_a = next_account_info(it)?;
    let player_b = next_account_info(it)?;
    let burn = incinerator_account(next_account_info(it)?)?;
    let b = load_battle(program_id, battle_acc)?;
    if *player_a.key != b.player_a || *player_b.key != b.player_b {
        return Err(WagerError::WrongPayee.into());
    }
    if !by_authority {
        // A battle only A has staked on is cancelled, not refunded (A at once, anyone after the deadline).
        if b.status != STATUS_LIVE {
            return Err(WagerError::WrongStatus.into());
        }
        let c = load_config(program_id, config_acc)?;
        if now()?.saturating_sub(b.live_at) < c.refund_after_seconds as i64 {
            return Err(WagerError::NotYet.into());
        }
    }
    match b.status {
        STATUS_OPEN => {}
        STATUS_LIVE => pay_player(battle_acc, player_b, burn, b.stake)?,
        _ => return Err(WagerError::WrongStatus.into()),
    }
    release(config_acc, program_id, b.stake.checked_mul(2).ok_or(WagerError::Math)?)?;
    announce(CLOSED_REFUNDED, &b.battle_id, OUTCOME_NONE);
    // A's stake and the rent go back to A.
    close(battle_acc, player_a, burn)
}
